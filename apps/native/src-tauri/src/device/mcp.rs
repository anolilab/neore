//! Local MCP servers over stdio: a minimal JSON-RPC 2.0 client (`initialize`,
//! `tools/list`, `tools/call`) and the process manager around it.
//!
//! Servers are configured ONLY in the local device window; the page can never
//! add, edit or start one. A server is spawned on first use, killed after
//! [`IDLE_TIMEOUT`] without a call and when the app exits, and restarted once
//! if it died between calls. Its stderr is drained and discarded (last few KiB
//! kept for errors).

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const STDERR_KEEP: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct McpServerConfig {
    #[serde(default)]
    pub args: Vec<String>,
    pub command: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub name: String,
}

/// `[a-z0-9_]` only, lower case — what a device tool name may contain.
pub fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// The manifest name of a server's tool: `mcp__<server>__<tool>`, at most 64 characters.
pub fn tool_name(server: &str, tool: &str) -> String {
    format!("mcp__{}__{}", sanitize(server), sanitize(tool))
        .chars()
        .take(64)
        .collect()
}

#[derive(Clone, Debug)]
pub struct McpTool {
    pub description: String,
    pub input_schema: Value,
    pub name: String,
    pub read_only: bool,
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Value>>>>;

pub struct McpProcess {
    child: Child,
    /// Set by the reader once the server's output closed.
    closed: Arc<AtomicBool>,
    last_used: Instant,
    next_id: u64,
    pending: Pending,
    stderr: Arc<Mutex<Vec<u8>>>,
    stdin: Arc<Mutex<ChildStdin>>,
}

fn write_message(stdin: &Mutex<ChildStdin>, message: &Value) -> Result<(), String> {
    let mut line = message.to_string();
    line.push('\n');

    let mut stdin = stdin.lock().unwrap();
    stdin
        .write_all(line.as_bytes())
        .and_then(|()| stdin.flush())
        .map_err(|error| format!("the server closed its input: {error}"))
}

/// Parses one line of server output: a response goes to its waiter; a request
/// FROM the server (sampling, roots…) is refused — this client offers none.
pub fn route_line(line: &str, pending: &Pending, stdin: &Mutex<ChildStdin>) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return;
    };

    let id = message.get("id").cloned();
    let is_request = message.get("method").is_some();

    match (id, is_request) {
        (Some(id), true) => {
            let _ = write_message(
                stdin,
                &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "not supported" } }),
            );
        }
        (Some(Value::Number(id)), false) => {
            if let Some(waiter) = id
                .as_u64()
                .and_then(|id| pending.lock().unwrap().remove(&id))
            {
                let _ = waiter.send(message);
            }
        }
        _ => {}
    }
}

impl McpProcess {
    pub fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let mut child = Command::new(&config.command)
            .args(&config.args)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not start {}: {error}", config.command))?;

        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped")));
        let stdout = child.stdout.take().expect("piped");
        let mut stderr_stream = child.stderr.take().expect("piped");
        let pending: Pending = Arc::default();
        let stderr: Arc<Mutex<Vec<u8>>> = Arc::default();
        let closed: Arc<AtomicBool> = Arc::default();

        {
            let pending = pending.clone();
            let stdin = stdin.clone();
            let closed = closed.clone();

            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    route_line(&line, &pending, &stdin);
                }

                // Output closed: wake every waiter with nothing.
                closed.store(true, Ordering::SeqCst);
                pending.lock().unwrap().clear();
            });
        }

        {
            let stderr = stderr.clone();

            thread::spawn(move || {
                let mut chunk = [0u8; 4096];

                while let Ok(read) = stderr_stream.read(&mut chunk) {
                    if read == 0 {
                        break;
                    }

                    let mut kept = stderr.lock().unwrap();
                    kept.extend_from_slice(&chunk[..read]);

                    if kept.len() > STDERR_KEEP {
                        let excess = kept.len() - STDERR_KEEP;
                        kept.drain(..excess);
                    }
                }
            });
        }

        let mut process = McpProcess {
            child,
            closed,
            last_used: Instant::now(),
            next_id: 1,
            pending,
            stderr,
            stdin,
        };

        process.request(
            "initialize",
            json!({ "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "neore-desktop", "version": env!("CARGO_PKG_VERSION") } }),
            STARTUP_TIMEOUT,
        )?;
        write_message(
            &process.stdin,
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        )?;

        Ok(process)
    }

    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.last_used = Instant::now();

        let (sender, receiver) = channel();
        self.pending.lock().unwrap().insert(id, sender);
        write_message(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )?;

        let started = Instant::now();
        let response = loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(response) => break Some(response),
                Err(RecvTimeoutError::Timeout)
                    if !self.closed.load(Ordering::SeqCst) && started.elapsed() < timeout => {}
                Err(_) => break None,
            }
        };
        let Some(response) = response else {
            self.pending.lock().unwrap().remove(&id);

            return Err(if self.closed.load(Ordering::SeqCst) || !self.is_alive() {
                format!(
                    "the server exited: {}",
                    String::from_utf8_lossy(&self.stderr.lock().unwrap()).trim()
                )
            } else {
                format!("{method} timed out")
            });
        };

        if let Some(error) = response.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the server returned an error")
                .to_owned());
        }

        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn list_tools(&mut self) -> Result<Vec<McpTool>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;

        // A few pages at most; a server with more tools than that is not a local helper.
        for _ in 0..5 {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let result = self.request("tools/list", params, STARTUP_TIMEOUT)?;

            for tool in result
                .get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(name) = tool.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let schema = tool
                    .get("inputSchema")
                    .cloned()
                    .filter(|schema| schema.get("type") == Some(&json!("object")));

                tools.push(McpTool {
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    input_schema: schema.unwrap_or_else(|| json!({ "type": "object" })),
                    name: name.to_owned(),
                    read_only: tool.pointer("/annotations/readOnlyHint") == Some(&json!(true))
                        && tool.pointer("/annotations/destructiveHint") != Some(&json!(true)),
                });
            }

            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);

            if cursor.is_none() {
                break;
            }
        }

        Ok(tools)
    }

    /// Calls a tool; the result's content flattened to text.
    pub fn call_tool(
        &mut self,
        name: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<(String, bool), String> {
        let result = self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
            timeout,
        )?;
        let is_error = result.get("isError") == Some(&json!(true));
        let text = result
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .map(|part| match part.get("type").and_then(Value::as_str) {
                        Some("text") => part
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        Some(other) => format!("[{other} content]"),
                        None => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        Ok((text, is_error))
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Running servers by name.
#[derive(Default)]
pub struct McpManager {
    processes: Mutex<HashMap<String, Arc<Mutex<McpProcess>>>>,
}

impl McpManager {
    fn process(&self, config: &McpServerConfig) -> Result<Arc<Mutex<McpProcess>>, String> {
        let mut processes = self.processes.lock().unwrap();

        if let Some(process) = processes.get(&config.name) {
            if process.lock().unwrap().is_alive() {
                return Ok(process.clone());
            }
        }

        let process = Arc::new(Mutex::new(McpProcess::spawn(config)?));
        processes.insert(config.name.clone(), process.clone());

        Ok(process)
    }

    /// Runs `work` against the server, restarting it ONCE if it died in between.
    pub fn with<T>(
        &self,
        config: &McpServerConfig,
        work: impl Fn(&mut McpProcess) -> Result<T, String>,
    ) -> Result<T, String> {
        let process = self.process(config)?;
        let first = work(&mut process.lock().unwrap());

        match first {
            Err(_) if !process.lock().unwrap().is_alive() => {
                self.processes.lock().unwrap().remove(&config.name);
                let process = self.process(config)?;
                let mut guard = process.lock().unwrap();

                work(&mut guard)
            }
            result => result,
        }
    }

    /// Stops idle servers and servers no longer configured.
    pub fn reap(&self, configured: &[McpServerConfig]) {
        self.processes.lock().unwrap().retain(|name, process| {
            let process = process.lock().unwrap();

            configured.iter().any(|config| &config.name == name)
                && process.last_used.elapsed() < IDLE_TIMEOUT
        });
    }

    pub fn stop_all(&self) {
        self.processes.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_tools_within_the_manifest_rules() {
        assert_eq!(
            tool_name("My Server", "Get-Issue"),
            "mcp__my_server__get_issue"
        );
        assert!(tool_name(&"s".repeat(80), "t").len() <= 64);
    }

    /// A fake server in `sh`: answers initialize, tools/list and one call.
    #[cfg(unix)]
    #[test]
    fn speaks_json_rpc_over_stdio() {
        let script = r#"
read l; echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}'
read l
read l; echo '{"jsonrpc":"2.0","method":"notifications/message","params":{}}'; echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echo","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}}'
read l; echo '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hi"},{"type":"image","data":""}]}}'
sleep 1
"#;
        let config = McpServerConfig {
            args: vec!["-c".into(), script.into()],
            command: "sh".into(),
            env: BTreeMap::new(),
            name: "fake".into(),
        };
        let mut process = McpProcess::spawn(&config).unwrap();

        let tools = process.list_tools().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert!(tools[0].read_only);

        let (text, is_error) = process
            .call_tool("echo", json!({}), Duration::from_secs(5))
            .unwrap();
        assert_eq!(text, "hi\n[image content]");
        assert!(!is_error);
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_server_that_exits() {
        let config = McpServerConfig {
            args: vec!["-c".into(), "echo boom >&2; exit 1".into()],
            command: "sh".into(),
            env: BTreeMap::new(),
            name: "dead".into(),
        };

        assert!(McpProcess::spawn(&config).is_err());
    }
}
