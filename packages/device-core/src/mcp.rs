//! Local MCP servers over stdio: a minimal JSON-RPC 2.0 client (`initialize`,
//! `tools/list`, `tools/call`) and the process manager around it.
//!
//! Servers are configured ONLY in the local device window; the page can never
//! add, edit or start one. A server is spawned on first use, killed after
//! [`IDLE_TIMEOUT`] without a call and when the app exits, and restarted once
//! if it died between calls. Its stderr is drained and discarded (last few KiB
//! kept for errors).
//!
//! **Sandbox.** Given a [`Policy`] a server runs in the same OS sandbox as `shell_run`
//! (`sandbox.rs`), with the same network tiers: it writes only the shared folders and
//! a private state folder of its own, and the rest of `$HOME` is hidden. Without a
//! policy (only where the user turned off "Require sandbox") it runs as the user.
//!
//! The private folder, `<state root>/<sanitised server name>/`, is why package
//! launchers (`npx`, `uvx`, `bunx`, `deno`…) still work without opening the user's
//! own caches:
//!
//! - `tmp/` is `$TMPDIR`, emptied at every start.
//! - `cache/<tool>/` receives each package manager's cache variable ([`shell::cache_env`]:
//!   npm, pip, uv, yarn, bun, go, deno, corepack, XDG). It persists across restarts, so a
//!   server installed once starts again from its cache and keeps working offline.
//! - The user's real caches (`~/.npm`, `~/.cache/uv`…) are neither readable nor writable:
//!   a writable one would let a sandboxed server plant a package the user later runs
//!   outside the sandbox, and a readable one can hold private-registry tarballs. The
//!   price is one download per server, through the network tier.
//! - Toolchains (`node`, `python`, `uv`…) stay readable where they live, through the
//!   policy's `HOME_TOOLCHAINS` list (`sandbox.rs`); user and global `.npmrc` are
//!   pointed at files in the state folder so a hidden `~/.npmrc` is never consulted, and
//!   git is told to use no global config for the same reason.
//! - It is removed when the server is removed or its command changes.
//!
//! A server keeps the app's working directory, sandboxed or not, so a relative command or argument resolves
//! as it did before the sandbox. That grants nothing: the policy alone decides what the server may read, so a
//! working directory outside the shared folders is a name it can stat, not a folder it can open.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::egress::{self, Proxy};
use crate::sandbox::{self, NetworkTier, Policy};
use crate::shell;

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
    /// How far the server may reach into the network. A server saved before the tiers existed has
    /// the middle one where this computer can enforce it (it can fetch its packages and nothing else),
    /// else Off, so it still starts.
    #[serde(default = "default_network")]
    pub network: NetworkTier,
}

fn default_network() -> NetworkTier {
    default_network_for(sandbox::dependencies_support().is_ok())
}

/// The tier of a server saved with none. "Common dependencies only" is refused where it cannot be enforced
/// (Linux, and anywhere without a sandbox), so defaulting to it there would leave the server unable to start.
fn default_network_for(dependencies_enforceable: bool) -> NetworkTier {
    if dependencies_enforceable {
        NetworkTier::Dependencies
    } else {
        NetworkTier::Off
    }
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
    /// The config it was started from; a changed config in settings means a restart.
    config: McpServerConfig,
    /// The policy it was planned under (`None` = unsandboxed). The shared folders and the
    /// network tier are in it, so changing either restarts the server.
    policy: Option<Policy>,
    /// The network filter of a `Dependencies` server; stops with the process.
    proxy: Option<Proxy>,
    /// Set by the reader once the server's output closed.
    closed: Arc<AtomicBool>,
    last_used: Instant,
    next_id: u64,
    pending: Pending,
    /// Set once `kill` has waited the child: from then on its pid, and the group id it gave, may belong to
    /// somebody else, so nothing is signalled.
    reaped: bool,
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

/// The server's private folder under `state_root`, created owner-only, with an empty `tmp/`. Canonical, since
/// the sandbox matches resolved paths (`/var` is `/private/var` on macOS).
fn prepare_state(state_root: &Path, name: &str) -> Result<PathBuf, String> {
    let fail = |error: std::io::Error| format!("could not prepare the server's folder: {error}");
    let folder = state_root.join(sanitize(name));

    create_private(&folder).map_err(fail)?;
    // The package caches in here are programs the server will run, so a folder somebody else could have put there
    // first, or can write to, is refused rather than used.
    ensure_private(state_root)?;
    ensure_private(&folder)?;

    let folder = std::fs::canonicalize(&folder).map_err(fail)?;
    let tmp = folder.join("tmp");

    let _ = std::fs::remove_dir_all(&tmp);
    create_private(&tmp).map_err(fail)?;

    Ok(folder)
}

/// Fails unless `path` is a real folder (not a link) that only this user can enter and write.
fn ensure_private(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let refused = |why: &str| {
            format!(
                "{} is not a private folder ({why}); remove it so the server can start from a new one",
                path.display()
            )
        };
        let meta = std::fs::symlink_metadata(path)
            .map_err(|error| format!("could not prepare the server's folder: {error}"))?;

        if !meta.is_dir() {
            return Err(refused("a link or a file"));
        }

        // SAFETY: geteuid takes no arguments and cannot fail.
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(refused("owned by another user"));
        }

        if meta.permissions().mode() & 0o077 != 0 {
            return Err(refused("others can reach it"));
        }
    }

    #[cfg(not(unix))]
    let _ = path;

    Ok(())
}

fn create_private(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;

        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
    }

    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// The only variables a sandboxed server inherits from the app, as for `shell_run`. Anything else it needs the
/// user wrote into the server's own `env`.
const INHERITED_ENV: &[&str] = &["PATH", "HOME", "LANG", "TERM"];

/// What a sandboxed server's environment holds besides [`INHERITED_ENV`] and the user's own `env`: the temp and
/// cache variables pointing into `state`, no user or global npm config, and the offline switches that make a
/// server with nothing to download start from its cache instead of waiting on a network it does not have.
fn sandbox_env(state: &Path, policy: &Policy) -> Vec<(String, std::ffi::OsString)> {
    let tmp = state.join("tmp");
    let mut env: Vec<(String, std::ffi::OsString)> = ["TMPDIR", "TMP", "TEMP"]
        .into_iter()
        .map(|name| (name.to_owned(), tmp.clone().into_os_string()))
        .collect();

    env.extend(
        shell::cache_env(state, &policy.writable, |name| std::env::var_os(name))
            .into_iter()
            .map(|(name, path)| (name.to_owned(), path.into_os_string())),
    );
    // The user's `~/.gitconfig` is hidden, and git treats an unreadable one as fatal rather than absent.
    env.push(("GIT_CONFIG_GLOBAL".to_owned(), "/dev/null".into()));
    env.push((
        "npm_config_userconfig".to_owned(),
        state.join("npmrc").into_os_string(),
    ));
    env.push((
        "npm_config_globalconfig".to_owned(),
        state.join("npmrc-global").into_os_string(),
    ));

    match policy.network {
        NetworkTier::Off => {
            env.push(("npm_config_offline".to_owned(), "true".into()));
            env.push(("UV_OFFLINE".to_owned(), "1".into()));
        }
        NetworkTier::Dependencies | NetworkTier::On => {
            env.push(("npm_config_prefer_offline".to_owned(), "true".into()));
        }
    }

    env
}

impl McpProcess {
    /// Starts `config`. With a `policy` the server is confined by it, with its private folder under
    /// `state_root` added to what it may write; without one it runs as the user.
    pub fn spawn(
        config: &McpServerConfig,
        policy: Option<&Policy>,
        state_root: &Path,
    ) -> Result<Self, String> {
        let mut proxy = None;
        let mut command;
        // Holds the Landlock ruleset open until the child has it.
        let _guard;

        match policy {
            None => {
                command = Command::new(&config.command);
                command.args(&config.args).envs(&config.env);
                _guard = sandbox::Guard::default();
            }
            Some(policy) => {
                let state = prepare_state(state_root, &config.name)?;
                let mut confined = policy.clone();

                confined.writable.push(state.clone());

                if confined.network == NetworkTier::Dependencies {
                    let started = Proxy::start()
                        .map_err(|error| format!("could not start the network filter: {error}"))?;

                    confined.proxy_port = Some(started.port());
                    proxy = Some(started);
                }

                let args: Vec<&str> = config.args.iter().map(String::as_str).collect();

                (command, _guard) = sandbox::sandboxed_command(&confined, &config.command, &args)?;
                command.env_clear();

                for name in INHERITED_ENV {
                    if let Some(value) = std::env::var_os(name) {
                        command.env(name, value);
                    }
                }

                // The proxy variables come last, so a server's own `env` cannot point it away from the filter.
                command
                    .envs(sandbox_env(&state, &confined))
                    .envs(&config.env);

                if let Some(proxy) = &proxy {
                    command.envs(egress::proxy_env(proxy.port()));
                }
            }
        }

        // Its own process group, so stopping the server also stops what a launcher (`npx`, `uvx`) started.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;

            command.process_group(0);
        }

        let mut child = command
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
            config: config.clone(),
            policy: policy.cloned(),
            proxy,
            closed,
            last_used: Instant::now(),
            next_id: 1,
            pending,
            reaped: false,
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

            let blocked = self
                .proxy
                .as_ref()
                .map(Proxy::refused_note)
                .unwrap_or_default();

            return Err(if self.closed.load(Ordering::SeqCst) || !self.is_alive() {
                format!(
                    "the server exited: {}{blocked}",
                    String::from_utf8_lossy(&self.stderr.lock().unwrap()).trim()
                )
            } else {
                format!("{method} timed out{blocked}")
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

    /// Whether the server's process is still running. A process that exited is NOT reaped here: until `kill` waits
    /// for it, its pid, which is also its group's id, stays reserved, so stopping it later cannot signal a stranger.
    pub fn is_alive(&mut self) -> bool {
        if self.reaped {
            return false;
        }

        #[cfg(unix)]
        {
            !exited_unreaped(self.child.id() as libc::pid_t)
        }

        #[cfg(not(unix))]
        {
            matches!(self.child.try_wait(), Ok(None))
        }
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

    /// Stops the server and what it started. Safe to call again: the first call waits for the child, after which
    /// its pid may belong to anyone, so a later call signals nothing.
    pub fn kill(&mut self) {
        if self.reaped {
            return;
        }

        #[cfg(unix)]
        // SAFETY: plain syscall with no memory arguments; the group is the one `process_group(0)` made for this
        // server, and its leader has not been waited for yet (see `reaped`), so the id is still ours even when the
        // leader exited. Not checked: ESRCH means the group is empty.
        unsafe {
            libc::kill(-(self.child.id() as libc::pid_t), libc::SIGKILL);
        }

        let _ = self.child.kill();
        let _ = self.child.wait();
        self.reaped = true;
    }
}

/// Whether `pid`, a child of ours, has exited, without reaping it (`WNOWAIT`): the zombie keeps the pid reserved.
/// A child somebody already waited for counts as exited.
#[cfg(unix)]
fn exited_unreaped(pid: libc::pid_t) -> bool {
    // SAFETY: an all-zero siginfo_t is a valid value (plain integers and a union of them).
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: waitid takes an id type, a pid, a siginfo to fill and flags; `info` outlives the call.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };

    if result != 0 {
        return std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR);
    }

    // SAFETY (linux): reading si_pid of a siginfo_t waitid filled. With WNOHANG and nothing to report it stays 0.
    #[cfg(target_os = "linux")]
    let reported = unsafe { info.si_pid() };
    #[cfg(not(target_os = "linux"))]
    let reported = info.si_pid;

    reported != 0
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Running servers by name.
pub struct McpManager {
    processes: Mutex<HashMap<String, Arc<Mutex<McpProcess>>>>,
    /// Where each server's private folder lives (`prepare_state`): always under the app's own data folder, never a
    /// shared temp folder, which is why there is no `Default`.
    state_root: PathBuf,
}

impl McpManager {
    pub fn new(state_root: PathBuf) -> Self {
        McpManager {
            processes: Mutex::default(),
            state_root,
        }
    }

    fn process(
        &self,
        config: &McpServerConfig,
        policy: Option<&Policy>,
    ) -> Result<Arc<Mutex<McpProcess>>, String> {
        let mut processes = self.processes.lock().unwrap();

        if let Some(process) = processes.get(&config.name) {
            let mut running = process.lock().unwrap();

            // Same name, edited command/args/env, another network tier or other shared folders: the old
            // process is not the server settings describe.
            if running.config == *config && running.policy.as_ref() == policy && running.is_alive()
            {
                return Ok(process.clone());
            }
        }

        // Stop the old one BEFORE starting its replacement: if the new start fails, the access the old policy
        // granted (a shared folder since removed, a wider network tier) must not stay in a running process. The
        // process's own lock is taken first, so a call in flight finishes before it dies.
        if let Some(stale) = processes.remove(&config.name) {
            stale.lock().unwrap_or_else(PoisonError::into_inner).kill();
        }

        let process = Arc::new(Mutex::new(McpProcess::spawn(
            config,
            policy,
            &self.state_root,
        )?));
        processes.insert(config.name.clone(), process.clone());

        Ok(process)
    }

    /// Runs `work` against the server, restarting it ONCE if it died in between. `policy` is what the
    /// server is confined by (`None` = the user allowed it unsandboxed); it is part of what makes a
    /// running process the right one, so every caller that starts servers goes through here.
    pub fn with<T>(
        &self,
        config: &McpServerConfig,
        policy: Option<&Policy>,
        work: impl Fn(&mut McpProcess) -> Result<T, String>,
    ) -> Result<T, String> {
        let process = self.process(config, policy)?;
        let first = work(&mut process.lock().unwrap());

        match first {
            Err(_) if !process.lock().unwrap().is_alive() => {
                self.processes.lock().unwrap().remove(&config.name);
                let process = self.process(config, policy)?;
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

    /// Stops these servers and deletes their private folders (caches included).
    ///
    /// The process table stays locked throughout, so no server starts into a folder this is about to delete. Each
    /// server is killed through its own lock, which a call in flight holds: the folder goes only after the
    /// server has stopped. A folder belongs to a name's sanitized form (`old-name` and `old_name` share one), so
    /// every running server under that folder is stopped, not just the one named.
    pub fn forget(&self, names: &[String]) {
        let mut processes = self.processes.lock().unwrap();

        for name in names {
            let folder = sanitize(name);
            let sharing: Vec<String> = processes
                .keys()
                .filter(|running| sanitize(running) == folder)
                .cloned()
                .collect();

            for running in sharing {
                if let Some(process) = processes.remove(&running) {
                    process
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .kill();
                }
            }

            let _ = std::fs::remove_dir_all(self.state_root.join(folder));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A state root of this test's own, under the OS temp folder.
    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("neore-mcp-test-{name}-{}", std::process::id()))
    }

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
            network: NetworkTier::Off,
        };
        let mut process = McpProcess::spawn(&config, None, &temp_root("speaks")).unwrap();

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

    /// A fake server that completes the handshake and then stays up.
    #[cfg(unix)]
    #[test]
    fn restarts_a_server_whose_config_changed() {
        let script = r#"read l; echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}'; sleep 30"#;
        let config = |mark: &str| McpServerConfig {
            args: vec!["-c".into(), script.into()],
            command: "sh".into(),
            env: BTreeMap::from([("MARK".to_owned(), mark.to_owned())]),
            name: "fake".into(),
            network: NetworkTier::Off,
        };
        let manager = McpManager::new(temp_root("restart-config"));

        let first = manager.process(&config("1"), None).unwrap();
        assert!(Arc::ptr_eq(
            &first,
            &manager.process(&config("1"), None).unwrap()
        ));
        assert!(!Arc::ptr_eq(
            &first,
            &manager.process(&config("2"), None).unwrap()
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_server_that_exits() {
        let config = McpServerConfig {
            args: vec!["-c".into(), "echo boom >&2; exit 1".into()],
            command: "sh".into(),
            env: BTreeMap::new(),
            name: "dead".into(),
            network: NetworkTier::Off,
        };

        assert!(McpProcess::spawn(&config, None, &temp_root("dead")).is_err());
    }

    // ── Sandboxed servers ────────────────────────────────────────────────────

    /// Folders for a sandbox test: a shared folder, an outside one holding a secret, and a stand-in home.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    struct Folders {
        base: PathBuf,
        home: PathBuf,
        outside: PathBuf,
        shared: PathBuf,
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    impl Folders {
        fn new(name: &str) -> Folders {
            let base = temp_root(name);
            let make = |dir: &str| {
                std::fs::create_dir_all(base.join(dir)).unwrap();
                std::fs::canonicalize(base.join(dir)).unwrap()
            };
            let folders = Folders {
                home: make("home"),
                outside: make("outside"),
                shared: make("shared"),
                base,
            };

            std::fs::write(folders.home.join("secret.txt"), "TOP-SECRET-CONTENT").unwrap();

            folders
        }

        fn policy(&self, network: NetworkTier) -> Policy {
            Policy {
                network,
                ..Policy::for_roots(std::slice::from_ref(&self.shared), Some(&self.home))
            }
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    impl Drop for Folders {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn sandbox_or_skip() -> bool {
        #[cfg(target_os = "linux")]
        if let Err(reason) = sandbox::network_filter() {
            eprintln!("skipping: {reason}");
            return false;
        }

        match sandbox::support() {
            sandbox::Support::Available(_) => true,
            sandbox::Support::Unavailable(reason) => {
                eprintln!("skipping: {reason}");
                false
            }
        }
    }

    /// A server in `sh` that finishes the handshake, then answers its first tool call with what `probe` printed.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn probing_server(
        name: &str,
        folders: &Folders,
        probe: &str,
        network: NetworkTier,
    ) -> McpServerConfig {
        let script = format!(
            r#"read l; echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2025-06-18","capabilities":{{}},"serverInfo":{{"name":"p","version":"1"}}}}}}'
read l
read l
r=$({probe})
echo "{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"$r\"}}]}}}}"
sleep 1"#
        );

        McpServerConfig {
            args: vec!["-c".into(), script],
            command: "/bin/sh".into(),
            env: BTreeMap::from([
                ("FAKEHOME".to_owned(), folders.home.display().to_string()),
                ("OUTSIDE".to_owned(), folders.outside.display().to_string()),
                ("SHARED".to_owned(), folders.shared.display().to_string()),
            ]),
            name: name.into(),
            network,
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn probe_output(config: &McpServerConfig, policy: Option<&Policy>, root: &Path) -> String {
        let mut process = McpProcess::spawn(config, policy, root).unwrap();
        let (text, _) = process
            .call_tool("probe", json!({}), Duration::from_secs(10))
            .unwrap();

        text
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_sandboxed_server_writes_only_the_shared_folders_and_its_own_folder() {
        if !sandbox_or_skip() {
            return;
        }

        let folders = Folders::new("mcp-write");
        let probe = r#"
            (echo x > "$SHARED/ok.txt") 2>/dev/null && printf 'shared:wrote '
            (echo x > "$OUTSIDE/bad.txt") 2>/dev/null && printf 'outside:WROTE ' || printf 'outside:denied '
            (echo x > "$HOME/bad.txt") 2>/dev/null && printf 'home:WROTE ' || printf 'home:denied '
            (echo x > "$TMPDIR/t") 2>/dev/null && printf 'tmp:wrote '
            (mkdir -p "$npm_config_cache/x" && echo x > "$npm_config_cache/x/c") 2>/dev/null && printf 'cache:wrote '
            (mkdir -p "$UV_CACHE_DIR" && echo x > "$UV_CACHE_DIR/c") 2>/dev/null && printf 'uv:wrote '
            [ "$(pwd -P)" = "$APPCWD" ] && printf 'cwd:inherited '
        "#;
        let mut config = probing_server("write", &folders, probe, NetworkTier::Off);

        // The server keeps the app's working directory, so a relative command or argument resolves as it always did;
        // its private folder is reached through $TMPDIR and the cache variables, not through the cwd.
        config.env.insert(
            "APPCWD".into(),
            std::fs::canonicalize(std::env::current_dir().unwrap())
                .unwrap()
                .display()
                .to_string(),
        );
        let policy = folders.policy(NetworkTier::Off);
        // The app's data folder lives under the user's home, which the sandbox hides: the server's own folder
        // is still readable and writable there, and nothing else under it is.
        let state_root = folders.home.join("app-data").join("mcp");
        let text = probe_output(&config, Some(&policy), &state_root);

        for allowed in [
            "shared:wrote",
            "tmp:wrote",
            "cache:wrote",
            "uv:wrote",
            "cwd:inherited",
            "outside:denied",
            "home:denied",
        ] {
            assert!(text.contains(allowed), "{allowed} missing from: {text}");
        }

        assert!(!text.contains("WROTE"), "{text}");
        assert!(folders.shared.join("ok.txt").exists());
        assert!(!folders.outside.join("bad.txt").exists());

        // The caches landed in the server's own folder, which survives the process.
        let state = state_root.join("write");

        assert!(state.join("cache").join("npm").join("x").join("c").exists());
        assert!(state.join("tmp").join("t").exists());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_sandboxed_server_cannot_read_the_hidden_home_folder() {
        if !sandbox_or_skip() {
            return;
        }

        let folders = Folders::new("mcp-home");
        let probe = r#"
            (cat "$FAKEHOME/secret.txt") 2>/dev/null && printf 'LEAKED ' || printf 'hidden '
            [ -z "$HOME_SECRET" ] && printf 'env:clean '
            [ -z "$NEORE_TEST_TOKEN" ] && printf 'env:no-token '
            [ "$USER_VAR" = "kept" ] && printf 'env:own-kept '
        "#;
        let mut config = probing_server("home", &folders, probe, NetworkTier::Off);

        config.env.insert("USER_VAR".into(), "kept".into());
        std::env::set_var("NEORE_TEST_TOKEN", "not-for-the-server");

        let policy = folders.policy(NetworkTier::Off);
        let text = probe_output(&config, Some(&policy), &folders.base.join("state"));

        assert!(text.contains("hidden"), "{text}");
        assert!(!text.contains("LEAKED"), "{text}");
        assert!(text.contains("env:no-token"), "{text}");
        assert!(text.contains("env:own-kept"), "{text}");

        // The control: unsandboxed, the same probe reads the file and sees the variable.
        let control = probe_output(&config, None, &folders.base.join("control"));

        assert!(control.contains("LEAKED"), "{control}");
        assert!(!control.contains("env:no-token"), "{control}");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn the_network_tier_sets_the_offline_switches_and_never_a_proxy_unless_dependencies() {
        if !sandbox_or_skip() {
            return;
        }

        let folders = Folders::new("mcp-env");
        let probe = r#"printf 'offline=%s prefer=%s uv=%s proxy=%s ' "$npm_config_offline" "$npm_config_prefer_offline" "$UV_OFFLINE" "${HTTPS_PROXY:-none}""#;
        let read = |network| {
            let config = probing_server("env", &folders, probe, network);
            let policy = folders.policy(network);

            probe_output(&config, Some(&policy), &folders.base.join("state"))
        };

        let off = read(NetworkTier::Off);

        assert!(
            off.contains("offline=true") && off.contains("uv=1") && off.contains("proxy=none"),
            "{off}"
        );

        let on = read(NetworkTier::On);

        assert!(
            on.contains("prefer=true") && on.contains("proxy=none"),
            "{on}"
        );

        #[cfg(target_os = "macos")]
        {
            let deps = read(NetworkTier::Dependencies);

            assert!(deps.contains("proxy=http://127.0.0.1:"), "{deps}");
        }
    }

    #[test]
    fn a_missing_sandbox_refuses_the_server_unless_the_user_allowed_it() {
        // The planning every start goes through, on a computer posed as having no sandbox.
        let roots = vec![PathBuf::from("/srv/p")];
        let missing = sandbox::Support::Unavailable("no Landlock".into());
        let refused =
            sandbox::policy_for_mcp(&missing, false, NetworkTier::Dependencies, &roots, None);

        assert!(refused
            .unwrap_err()
            .contains("local MCP servers must run sandboxed"));
        assert_eq!(
            sandbox::policy_for_mcp(&missing, true, NetworkTier::Dependencies, &roots, None),
            Ok(None)
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_changed_policy_or_tier_restarts_the_server_but_the_same_one_is_reused() {
        if !sandbox_or_skip() {
            return;
        }

        let folders = Folders::new("mcp-restart");
        let script = r#"read l; echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"f","version":"1"}}}'; sleep 30"#;
        let config = McpServerConfig {
            args: vec!["-c".into(), script.into()],
            command: "/bin/sh".into(),
            env: BTreeMap::new(),
            name: "restart".into(),
            network: NetworkTier::Off,
        };
        let manager = McpManager::new(folders.base.join("state"));
        let policy = folders.policy(NetworkTier::Off);
        let first = manager.process(&config, Some(&policy)).unwrap();

        assert!(Arc::ptr_eq(
            &first,
            &manager.process(&config, Some(&policy)).unwrap()
        ));

        // Another shared folder: the process does not hold the folders settings describe.
        let mut wider = policy.clone();
        wider.writable.push(folders.outside.clone());
        let second = manager.process(&config, Some(&wider)).unwrap();

        assert!(!Arc::ptr_eq(&first, &second));

        // Another tier.
        let on = folders.policy(NetworkTier::On);
        let third = manager.process(&config, Some(&on)).unwrap();

        assert!(!Arc::ptr_eq(&second, &third));

        // And sandboxed to unsandboxed.
        assert!(!Arc::ptr_eq(
            &third,
            &manager.process(&config, None).unwrap()
        ));
    }

    /// A fake server that completes the handshake and stays up.
    #[cfg(unix)]
    fn idle_server(name: &str) -> McpServerConfig {
        let script = r#"read l; echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}'; sleep 30"#;

        McpServerConfig {
            args: vec!["-c".into(), script.into()],
            command: "sh".into(),
            env: BTreeMap::new(),
            name: name.into(),
            network: NetworkTier::Off,
        }
    }

    #[cfg(unix)]
    fn pid_gone(pid: libc::pid_t) -> bool {
        // A zombie nobody reaped yet is as dead as a reaped one.
        let state = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_default();

        state.is_empty() || state.starts_with('Z')
    }

    #[cfg(unix)]
    fn wait_until(mut done: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if done() {
                return true;
            }

            thread::sleep(Duration::from_millis(50));
        }

        false
    }

    #[cfg(unix)]
    #[test]
    fn a_replacement_that_cannot_start_leaves_the_old_server_stopped() {
        let manager = McpManager::new(temp_root("replace-fails"));
        let old = manager.process(&idle_server("svc"), None).unwrap();
        let pid = old.lock().unwrap().child.id() as libc::pid_t;

        assert!(!pid_gone(pid));

        // Same name, changed config that cannot start: whatever the old server had must not outlive the edit.
        let broken = McpServerConfig {
            command: "/nonexistent/neore-mcp-server".into(),
            ..idle_server("svc")
        };

        assert!(manager.process(&broken, None).is_err());
        assert!(manager.processes.lock().unwrap().is_empty());
        assert!(pid_gone(pid), "the old server is still running");
    }

    #[cfg(unix)]
    #[test]
    fn a_dead_server_is_not_reaped_until_it_is_stopped_so_its_group_stays_ours() {
        let root = temp_root("dead-group");
        let pidfile = root.join("orphan.pid");
        let script = format!(
            r#"read l; echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":"2025-06-18","capabilities":{{}},"serverInfo":{{"name":"f","version":"1"}}}}}}'; sleep 30 & echo $! > '{}'; exit 0"#,
            pidfile.display()
        );

        std::fs::create_dir_all(&root).unwrap();

        let config = McpServerConfig {
            args: vec!["-c".into(), script],
            ..idle_server("leaves-a-child")
        };
        let mut process = McpProcess::spawn(&config, None, &root).unwrap();
        let leader = process.child.id() as libc::pid_t;

        assert!(wait_until(|| !process.is_alive()));
        // Asking whether it is alive must not reap it: while the leader is a zombie its pid, which is the group's
        // id, cannot go to an unrelated process.
        // SAFETY: signal 0 only checks that the pid exists.
        assert_eq!(unsafe { libc::kill(leader, 0) }, 0, "the leader was reaped");

        assert!(wait_until(|| pidfile.exists()
            && !std::fs::read_to_string(&pidfile)
                .unwrap()
                .trim()
                .is_empty()));
        let orphan: libc::pid_t = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        assert!(!pid_gone(orphan));

        drop(process);

        assert!(
            wait_until(|| pid_gone(orphan)),
            "the group outlived the server"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn stopping_a_server_twice_signals_its_group_once() {
        let mut process =
            McpProcess::spawn(&idle_server("twice"), None, &temp_root("twice")).unwrap();

        process.kill();
        assert!(process.reaped);

        // The pid may belong to somebody else by now: a second stop (the drop) must not signal it.
        process.kill();
        assert!(!process.is_alive());
    }

    #[cfg(unix)]
    #[test]
    fn a_state_folder_that_others_can_write_or_a_link_is_refused() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = temp_root("state-trust");
        let _ = std::fs::remove_dir_all(&root);

        let state = prepare_state(&root, "ok").unwrap();

        assert_eq!(
            std::fs::metadata(&state).unwrap().permissions().mode() & 0o077,
            0
        );
        assert!(prepare_state(&root, "ok").is_ok());

        // Somebody else pre-created it open to the world, or as a link to a place of their choosing.
        std::fs::create_dir_all(root.join("open")).unwrap();
        std::fs::set_permissions(root.join("open"), std::fs::Permissions::from_mode(0o777))
            .unwrap();
        assert!(prepare_state(&root, "open")
            .unwrap_err()
            .contains("private"));

        let elsewhere = temp_root("state-trust-elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        symlink(&elsewhere, root.join("linked")).unwrap();
        assert!(prepare_state(&root, "linked")
            .unwrap_err()
            .contains("private"));
        assert!(!elsewhere.join("tmp").exists());

        // The root itself must not be a place others can write.
        let loose = temp_root("state-trust-loose");
        std::fs::create_dir_all(&loose).unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(prepare_state(&loose, "x").unwrap_err().contains("private"));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
        let _ = std::fs::remove_dir_all(&loose);
    }

    #[cfg(unix)]
    #[test]
    fn forgetting_waits_for_a_call_in_flight_before_deleting_its_folder() {
        let root = temp_root("forget-busy");
        let manager = Arc::new(McpManager::new(root.clone()));
        let config = idle_server("busy");
        let folder = root.join(sanitize("busy"));

        std::fs::create_dir_all(&folder).unwrap();
        let (started, running) = std::sync::mpsc::channel();
        let existed_throughout = Arc::new(AtomicBool::new(false));
        let call = {
            let (manager, config, folder) = (manager.clone(), config.clone(), folder.clone());
            let existed = existed_throughout.clone();

            thread::spawn(move || {
                manager
                    .with(&config, None, |_| {
                        let _ = started.send(());
                        thread::sleep(Duration::from_millis(400));
                        existed.store(folder.is_dir(), Ordering::SeqCst);

                        Ok(())
                    })
                    .unwrap();
            })
        };

        running.recv_timeout(Duration::from_secs(10)).unwrap();
        manager.forget(&["busy".to_owned()]);

        assert!(!folder.exists());
        call.join().unwrap();
        assert!(
            existed_throughout.load(Ordering::SeqCst),
            "the folder was deleted under a running call"
        );
        assert!(manager.processes.lock().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn forgetting_a_name_stops_a_server_whose_name_shares_its_folder() {
        let root = temp_root("forget-alias");
        let manager = McpManager::new(root.clone());

        std::fs::create_dir_all(root.join("old_name")).unwrap();
        manager.process(&idle_server("old_name"), None).unwrap();

        // `old-name` and `old_name` are the same folder, so renaming one to the other must stop the live server
        // before the folder goes.
        manager.forget(&["old-name".to_owned()]);

        assert!(manager.processes.lock().unwrap().is_empty());
        assert!(!root.join(sanitize("old_name")).exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn forgetting_a_server_removes_its_private_folder() {
        let root = temp_root("forget");
        let manager = McpManager::new(root.clone());
        let state = prepare_state(&root, "Docs Server").unwrap();

        std::fs::write(state.join("cache.bin"), "x").unwrap();
        assert!(state.starts_with(std::fs::canonicalize(&root).unwrap()));
        assert!(state.join("tmp").is_dir());

        manager.forget(&["Docs Server".to_owned()]);

        assert!(!state.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_server_saved_before_the_tiers_gets_the_tier_this_computer_can_enforce() {
        assert_eq!(default_network_for(true), NetworkTier::Dependencies);
        assert_eq!(default_network_for(false), NetworkTier::Off);

        let config: McpServerConfig =
            serde_json::from_str(r#"{"name":"git","command":"git-mcp"}"#).unwrap();

        assert_eq!(
            config.network,
            default_network_for(sandbox::dependencies_support().is_ok())
        );
        assert_eq!(
            serde_json::from_str::<McpServerConfig>(
                r#"{"name":"g","command":"c","network":"off"}"#
            )
            .unwrap()
            .network,
            NetworkTier::Off
        );
    }

    /// A real package-launched server through the whole path: sandbox, private caches, the dependencies filter.
    /// `cargo test --lib a_real_npx_server -- --ignored --nocapture`; needs the network on macOS.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "downloads a package through the dependencies tier"]
    fn a_real_npx_server_starts_sandboxed_and_lists_its_tools() {
        let folders = Folders::new("mcp-npx");
        let config = McpServerConfig {
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem@2025.8.21".into(),
                folders.shared.display().to_string(),
            ],
            command: "npx".into(),
            env: BTreeMap::new(),
            name: "files".into(),
            network: NetworkTier::Dependencies,
        };
        let policy = folders.policy(NetworkTier::Dependencies);
        let state = folders.base.join("state");
        let mut process = McpProcess::spawn(&config, Some(&policy), &state).unwrap();
        let tools = process.list_tools().unwrap();

        println!("{} tools", tools.len());
        assert!(tools
            .iter()
            .any(|tool| tool.name == "read_file" || tool.name == "read_text_file"));
        drop(process);

        // Second start, nothing to download: the offline tier starts it from the private cache.
        let offline = folders.policy(NetworkTier::Off);
        let config = McpServerConfig {
            network: NetworkTier::Off,
            ..config
        };
        let mut again = McpProcess::spawn(&config, Some(&offline), &state).unwrap();

        assert!(!again.list_tools().unwrap().is_empty());
    }
}
