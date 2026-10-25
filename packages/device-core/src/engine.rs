//! The device engine: everything `device/mod.rs` did that is not a window, a
//! notification or a dialog (`docs/plans/device-execution.md`).
//!
//! The host (the Electron shell through `device-core-node`, or any other
//! embedder) owns the windows. It hands the engine an event sink and calls the
//! methods here; the engine never reaches into a UI. Every security decision —
//! envelope verification, the approval rules, root confinement, sandboxing,
//! output caps and the audit log — happens in this crate.

use std::collections::HashMap;
use std::fs as stdfs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::approval::{Answer, Prompt, PromptBody, Prompts};
use crate::envelope::{self, Domain, NonceSet, Signed};
use crate::fs;
use crate::mcp::{self, McpManager, McpServerConfig};
use crate::sandbox;
use crate::shell;
use crate::store::{self, Pairing, Settings};

/// Output cap for every result; the backend re-caps anyway.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const SHELL_DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const SHELL_MAX_TIMEOUT: Duration = Duration::from_secs(600);
const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ROOTS: usize = 20;
const MAX_MCP_SERVERS: usize = 20;
const AUDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// How long a pairing waits for its confirmation click.
const PAIRING_WAIT: Duration = Duration::from_secs(5 * 60);

/// What the engine tells its host.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Event {
    /// A request is waiting for a person: show the approval window.
    Prompt { prompt: Prompt },
    /// Where a call is (`prompting` / `running`), already signed. Relay it to the page.
    Progress(ProgressEvent),
    /// The tool set changed: the page should send a fresh manifest.
    Changed,
}

/// Receives [`Event`]s. Called from engine threads; must not block.
pub type Sink = Box<dyn Fn(Event) + Send + Sync>;

pub struct DeviceState {
    audit_path: PathBuf,
    last_manifest_at: Mutex<u64>,
    mcp: McpManager,
    /// Manifest tool name → (server, the server's own tool name).
    mcp_tools: Mutex<HashMap<String, (String, String, bool)>>,
    nonces: Mutex<NonceSet>,
    prompts: Prompts,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    sink: Sink,
}

impl DeviceState {
    pub fn new(data_dir: &Path, sink: Sink) -> Self {
        let settings_path = data_dir.join("device.json");
        let mut settings = store::load(&settings_path);

        // Stored roots are kept only in the canonical form the planner uses; the next save writes that list.
        settings.roots = shareable_roots(&settings.roots)
            .into_iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect();

        DeviceState {
            audit_path: data_dir.join("device-audit.jsonl"),
            last_manifest_at: Mutex::new(0),
            mcp: McpManager::default(),
            mcp_tools: Mutex::default(),
            nonces: Mutex::new(NonceSet::persisted(
                &data_dir.join("device-nonces.json"),
                now_ms(),
            )),
            prompts: Prompts::default(),
            settings: Mutex::new(settings),
            settings_path,
            sink,
        }
    }

    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    fn save(&self, settings: Settings) -> Result<(), String> {
        store::save(&self.settings_path, &settings)?;
        *self.settings.lock().unwrap() = settings;

        Ok(())
    }

    fn emit(&self, event: Event) {
        (self.sink)(event);
    }

    pub fn reap_idle_servers(&self) {
        self.mcp.reap(&self.settings().mcp_servers);
    }

    pub fn stop_servers(&self) {
        self.mcp.stop_all();
    }

    fn audit(&self, entry: Value) {
        if stdfs::metadata(&self.audit_path)
            .map(|meta| meta.len() > AUDIT_MAX_BYTES)
            .unwrap_or(false)
        {
            let _ = stdfs::rename(&self.audit_path, self.audit_path.with_extension("jsonl.1"));
        }

        let mut options = stdfs::OpenOptions::new();

        options.create(true).append(true);

        // Owner-only when created, like the device store; an existing file keeps its mode.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            options.mode(0o600);
        }

        if let Ok(mut file) = options.open(&self.audit_path) {
            let _ = writeln!(file, "{entry}");
        }
    }

    /// The prompt the approval window should show.
    pub fn prompt_current(&self) -> Option<Prompt> {
        self.prompts.current()
    }

    /// Answers one prompt. `answer` is `deny`, `once` or `always`.
    pub fn prompt_answer(&self, id: u64, answer: &str) -> Result<(), String> {
        self.prompts
            .answer(id, Answer::parse(answer).ok_or("unknown answer")?)
    }

    /// Closing the approval window is a "no" to everything it was asking.
    pub fn deny_prompts(&self) {
        self.prompts.deny_all();
    }

    pub fn status(&self) -> StatusView {
        let pairing = self.settings().pairing;

        StatusView {
            account_label: pairing
                .as_ref()
                .map(|pairing| pairing.account_label.clone()),
            device_id: pairing.map(|pairing| pairing.device_id),
            platform: platform(),
        }
    }

    /// Stores a pairing — only after the user confirms it in the approval window.
    /// `Ok(false)` when the user declined or did not answer.
    pub fn pair(&self, device_id: &str, secret: &str, account_label: &str) -> Result<bool, String> {
        let account_label = account_label.trim().to_owned();

        if !valid_pairing(device_id, secret, &account_label) {
            return Err("invalid pairing".into());
        }

        if self
            .prompts
            .current()
            .is_some_and(|prompt| matches!(prompt.body, PromptBody::Pairing { .. }))
        {
            return Err("already waiting for a pairing confirmation".into());
        }

        let answer = self.prompts.ask(
            PromptBody::Pairing {
                account_label: account_label.clone(),
            },
            now_ms() + PAIRING_WAIT.as_millis() as u64,
            PAIRING_WAIT,
            |prompt| {
                self.emit(Event::Prompt {
                    prompt: prompt.clone(),
                })
            },
        );

        if !matches!(answer, Answer::Once | Answer::Always) {
            return Ok(false);
        }

        let mut settings = self.settings();

        settings.pairing = Some(Pairing {
            account_label,
            device_id: device_id.to_owned(),
            secret: secret.to_owned(),
        });
        settings.allow_rules.clear();
        self.save(settings)?;

        Ok(true)
    }

    pub fn settings_view(&self) -> SettingsView {
        let settings = self.settings();

        SettingsView {
            account_label: settings
                .pairing
                .as_ref()
                .map(|pairing| pairing.account_label.clone()),
            allow_rules: settings.allow_rules,
            allow_shell_network: settings.allow_shell_network,
            audit_path: self.audit_path.to_string_lossy().into_owned(),
            mcp_servers: settings.mcp_servers,
            paired: settings.pairing.is_some(),
            require_shell_sandbox: !settings.allow_unsandboxed_shell,
            roots: settings.roots,
            sandbox_unavailable: match sandbox::support() {
                sandbox::Support::Available(_) => None,
                sandbox::Support::Unavailable(reason) => Some(reason),
            },
        }
    }

    pub fn settings_update(&self, update: SettingsUpdate) -> Result<SettingsView, String> {
        let mut settings = self.settings();

        if let Some(roots) = update.roots {
            settings.roots = validate_roots(&roots)?;
        }

        if let Some(servers) = update.mcp_servers {
            validate_servers(&servers)?;
            settings.mcp_servers = servers;
            // The cached `readOnly` flags describe the old servers. Dropping them makes every MCP call
            // fail closed until the next manifest, so none can skip its prompt on stale metadata.
            self.mcp_tools.lock().unwrap().clear();
        }

        if let Some(required) = update.require_shell_sandbox {
            settings.allow_unsandboxed_shell = !required;
        }

        if let Some(allowed) = update.allow_shell_network {
            settings.allow_shell_network = allowed;
        }

        // Rules are only ever REMOVED here; one is added by answering "Always allow".
        if let Some(rules) = update.allow_rules {
            settings.allow_rules.retain(|rule| rules.contains(rule));
        }

        if update.unpair {
            self.prompts.deny_all();
            settings.pairing = None;
            settings.allow_rules.clear();
        }

        self.save(settings)?;
        self.reap_idle_servers();
        self.emit(Event::Changed);

        Ok(self.settings_view())
    }

    /// The last 200 audit lines, newest first.
    pub fn audit_tail(&self) -> Vec<String> {
        let text = stdfs::read_to_string(&self.audit_path).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();

        lines[lines.len().saturating_sub(200)..]
            .iter()
            .rev()
            .map(|line| (*line).to_owned())
            .collect()
    }

    /// Verifies, asks, runs and signs one call the page relayed.
    pub fn execute(&self, signed: &Signed) -> Result<Signed, String> {
        let settings = self.settings();
        let pairing = settings
            .pairing
            .clone()
            .ok_or("this computer is not paired")?;
        let call = envelope::verify_call(
            &pairing.secret,
            &pairing.device_id,
            signed,
            now_ms(),
            &mut self.nonces.lock().unwrap(),
        )?;
        let tainted = !call.tainted_by.is_empty();
        let planned = plan(
            &call.tool,
            &call.input,
            &settings,
            &self.mcp_tools.lock().unwrap(),
        );
        let mut detail = String::new();

        let outcome = match planned {
            Err(error) => Outcome::failed("denied", error),
            Ok(action) => {
                detail = action.detail();

                let (skip_prompt, offer_always) = decide(
                    &call.tool,
                    tainted,
                    action.read_only(),
                    &settings.allow_rules,
                );
                let answer = if skip_prompt {
                    Answer::Once
                } else {
                    let wait = Duration::from_millis(call.expires_at.saturating_sub(now_ms()));
                    let body = PromptBody::Call {
                        allow_always: offer_always,
                        detail: detail.clone(),
                        input: serde_json::to_string_pretty(&call.input).unwrap_or_default(),
                        tainted_by: call.tainted_by.clone(),
                        thread_title: call.thread_title.clone(),
                        tool: call.tool.clone(),
                        tool_kind: action.kind().to_owned(),
                    };

                    self.prompts.ask(body, call.expires_at, wait, |prompt| {
                        self.emit_progress(&pairing, &call.call_id, "prompting");
                        self.emit(Event::Prompt {
                            prompt: prompt.clone(),
                        });
                    })
                };

                let decision = match (skip_prompt, answer) {
                    (true, _) => "rule",
                    (false, Answer::Once) => "once",
                    (false, Answer::Always) => "always",
                    (false, Answer::Deny) => "denied",
                    (false, Answer::Timeout) => "timeout",
                };

                if answer == Answer::Always && offer_always {
                    let mut next = self.settings();

                    if !next.allow_rules.contains(&call.tool) {
                        next.allow_rules.push(call.tool.clone());
                        let _ = self.save(next);
                    }
                }

                let remaining = call.expires_at.saturating_sub(now_ms());

                let still_paired = self
                    .settings()
                    .pairing
                    .is_some_and(|current| current.device_id == pairing.device_id);

                match answer {
                    Answer::Deny | Answer::Timeout => Outcome::denied(decision),
                    _ if !still_paired => {
                        Outcome::failed(decision, "the computer was unpaired while waiting")
                    }
                    _ if remaining == 0 => {
                        Outcome::failed(decision, "approved after the request expired")
                    }
                    _ => {
                        self.emit_progress(&pairing, &call.call_id, "running");
                        run_action(self, action, Duration::from_millis(remaining), decision)
                    }
                }
            }
        };

        let output = outcome
            .output
            .as_deref()
            .map(|text| cap_utf8(text, MAX_OUTPUT_BYTES));

        self.audit(json!({
            "at": now_ms(), "callId": call.call_id, "decision": outcome.decision, "detail": cap_utf8(&detail, 1000).0,
            "status": outcome.status, "taintedBy": call.tainted_by, "thread": call.thread_title, "tool": call.tool,
        }));

        let mut result = json!({
            "v": 1, "kind": "result", "callId": call.call_id, "deviceId": pairing.device_id,
            "status": outcome.status, "decision": outcome.decision,
            "truncated": outcome.truncated || output.as_ref().is_some_and(|(_, truncated)| *truncated),
        });

        if let Some((text, _)) = output {
            result["output"] = json!(text);
        }

        if let Some(error) = outcome.error.filter(|error| !error.is_empty()) {
            result["error"] = json!(cap_utf8(&error, 1000).0);
        }

        if let Some(code) = outcome.exit_code {
            result["exitCode"] = json!(code);
        }

        Ok(envelope::sign_value(
            &pairing.secret,
            Domain::Result,
            &result,
        ))
    }

    fn emit_progress(&self, pairing: &Pairing, call_id: &str, phase: &str) {
        // Best effort: a lost report only leaves the chat saying "sent to the device".
        self.emit(Event::Progress(progress_report(
            &pairing.secret,
            &pairing.device_id,
            call_id,
            phase,
            now_ms(),
        )));
    }

    /// The signed tool list, for the backend to offer the agent.
    pub fn manifest(&self) -> Result<Signed, String> {
        let settings = self.settings();
        let pairing = settings
            .pairing
            .clone()
            .ok_or("this computer is not paired")?;
        let mut tools = builtin_tools(&shareable_roots(&settings.roots));
        let mut mcp_tools = HashMap::new();

        for server in &settings.mcp_servers {
            match self.mcp.with(server, |process| process.list_tools()) {
                Ok(listed) => {
                    for tool in listed {
                        let name = mcp::tool_name(&server.name, &tool.name);

                        if mcp_tools.contains_key(&name) || tools.len() >= 64 {
                            continue;
                        }

                        tools.push(json!({
                            "name": name, "kind": "mcp", "readOnly": tool.read_only, "inputSchema": tool.input_schema,
                            "description": format!("[Local MCP server \"{}\"] {}", server.name, cap_utf8(&tool.description, 1800).0),
                        }));
                        mcp_tools.insert(name, (server.name.clone(), tool.name, tool.read_only));
                    }
                }
                Err(error) => eprintln!(
                    "[device-core] MCP server {} unavailable: {error}",
                    server.name
                ),
            }
        }

        *self.mcp_tools.lock().unwrap() = mcp_tools;

        let issued_at = {
            let mut last = self.last_manifest_at.lock().unwrap();
            *last = now_ms().max(*last + 1);
            *last
        };

        Ok(envelope::sign_value(
            &pairing.secret,
            Domain::Manifest,
            &json!({ "v": 1, "kind": "manifest", "deviceId": pairing.device_id, "issuedAt": issued_at, "tools": tools }),
        ))
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Caps text at `max` bytes of UTF-8 without splitting a character.
pub fn cap_utf8(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_owned(), false);
    }

    let mut end = max;

    while !text.is_char_boundary(end) {
        end -= 1;
    }

    (text[..end].to_owned(), true)
}

/// Tools that may never skip the prompt: they change things irreversibly.
pub fn can_always_allow(tool: &str) -> bool {
    !matches!(tool, "shell_run" | "fs_write")
}

/// `(skip the prompt, offer "Always allow")` for one call. Only a read-only tool
/// (the MCP `readOnly` annotation, exactly true) can be allowed; a tainted call never.
pub fn decide(tool: &str, tainted: bool, read_only: bool, allow_rules: &[String]) -> (bool, bool) {
    let eligible = can_always_allow(tool) && read_only && !tainted;

    (
        eligible && allow_rules.iter().any(|rule| rule == tool),
        eligible,
    )
}

fn builtin_tools(roots: &[PathBuf]) -> Vec<Value> {
    if roots.is_empty() {
        return Vec::new();
    }

    let shared = roots
        .iter()
        .map(|root| root.to_string_lossy())
        .collect::<Vec<_>>()
        .join(", ");
    let path = json!({ "type": "string", "description": "Absolute path, or relative to the first shared folder" });

    vec![
        json!({ "name": "fs_list", "kind": "fs", "readOnly": true,
            "description": format!("List a folder on the user's computer. Shared folders: {shared}."),
            "inputSchema": { "type": "object", "properties": { "path": path } } }),
        json!({ "name": "fs_read", "kind": "fs", "readOnly": true,
            "description": format!("Read a text file (first 64 KiB) on the user's computer. Shared folders: {shared}."),
            "inputSchema": { "type": "object", "properties": { "path": path }, "required": ["path"] } }),
        json!({ "name": "fs_write", "kind": "fs", "readOnly": false,
            "description": format!("Write a text file on the user's computer (at most 1 MiB). Shared folders: {shared}."),
            "inputSchema": { "type": "object", "properties": { "path": path, "content": { "type": "string" },
                "overwrite": { "type": "boolean", "description": "Replace an existing file" } }, "required": ["path", "content"] } }),
        json!({ "name": "shell_run", "kind": "shell", "readOnly": false,
            "description": format!("Run one shell command on the user's computer and return its output (first 64 KiB). The working folder must be inside a shared folder: {shared}. The sandbox may block network access; if a command fails for lack of network, say so instead of retrying."),
            "inputSchema": { "type": "object", "properties": { "command": { "type": "string" }, "cwd": path,
                "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 600 } }, "required": ["command"] } }),
    ]
}

/// One call, planned and checked before the user is asked, so the prompt shows
/// exactly what will run (resolved paths, the command, the folder).
enum Action {
    List(PathBuf),
    Read(PathBuf),
    Write {
        content: String,
        overwrite: bool,
        path: PathBuf,
    },
    Shell {
        command: String,
        cwd: PathBuf,
        /// `None` = unsandboxed, which the user allowed.
        sandbox: Option<sandbox::Policy>,
        /// The prompt's line about the sandbox.
        sandbox_note: String,
        timeout: Duration,
    },
    Mcp {
        arguments: Value,
        read_only: bool,
        server: McpServerConfig,
        tool: String,
    },
}

impl Action {
    fn read_only(&self) -> bool {
        match self {
            Action::List(_) | Action::Read(_) => true,
            Action::Write { .. } | Action::Shell { .. } => false,
            Action::Mcp { read_only, .. } => *read_only,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Action::List(_) | Action::Read(_) | Action::Write { .. } => "fs",
            Action::Shell { .. } => "shell",
            Action::Mcp { .. } => "mcp",
        }
    }

    fn detail(&self) -> String {
        match self {
            Action::List(path) => format!("List the folder {}", path.display()),
            Action::Read(path) => format!("Read the file {}", path.display()),
            Action::Write {
                content,
                overwrite,
                path,
            } => format!(
                "{} {} ({} bytes):\n{}",
                if *overwrite { "Overwrite" } else { "Create" },
                path.display(),
                content.len(),
                cap_utf8(content, 2000).0
            ),
            Action::Shell {
                command,
                cwd,
                sandbox_note,
                timeout,
                ..
            } => {
                format!(
                    "{sandbox_note}\n\nRun in {} (stops after {} s):\n{command}",
                    cwd.display(),
                    timeout.as_secs()
                )
            }
            Action::Mcp {
                arguments,
                server,
                tool,
                ..
            } => {
                format!(
                    "Call {tool} on the local MCP server \"{}\" ({} {})",
                    server.name,
                    server.command,
                    server.args.join(" ")
                ) + &format!(
                    "\n{}",
                    serde_json::to_string_pretty(arguments).unwrap_or_default()
                )
            }
        }
    }
}

fn string_arg<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

fn plan(
    tool: &str,
    input: &Value,
    settings: &Settings,
    mcp_tools: &HashMap<String, (String, String, bool)>,
) -> Result<Action, String> {
    let roots = shareable_roots(&settings.roots);

    match tool {
        "fs_list" => Ok(Action::List(fs::resolve_existing(
            string_arg(input, "path").unwrap_or(""),
            &roots,
        )?)),
        "fs_read" => Ok(Action::Read(fs::resolve_existing(
            string_arg(input, "path").ok_or("path is required")?,
            &roots,
        )?)),
        "fs_write" => Ok(Action::Write {
            content: string_arg(input, "content")
                .ok_or("content is required")?
                .to_owned(),
            overwrite: input
                .get("overwrite")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            path: fs::resolve_for_write(
                string_arg(input, "path").ok_or("path is required")?,
                &roots,
            )?,
        }),
        "shell_run" => {
            let command = string_arg(input, "command")
                .map(str::trim)
                .filter(|command| !command.is_empty())
                .ok_or("command is required")?;

            if command.len() > 8000 {
                return Err("the command is too long".into());
            }

            let cwd = fs::resolve_existing(string_arg(input, "cwd").unwrap_or(""), &roots)?;

            if !cwd.is_dir() {
                return Err("cwd is not a folder".into());
            }

            let timeout = input
                .get("timeoutSeconds")
                .and_then(Value::as_u64)
                .map(Duration::from_secs)
                .unwrap_or(SHELL_DEFAULT_TIMEOUT)
                .min(SHELL_MAX_TIMEOUT);

            let support = sandbox::support();
            let policy = sandbox::policy_for_call(
                &support,
                settings.allow_unsandboxed_shell,
                settings.allow_shell_network,
                &roots,
                sandbox::home().as_deref(),
            )?;

            Ok(Action::Shell {
                command: command.to_owned(),
                cwd,
                sandbox_note: sandbox::describe(&support, policy.as_ref()),
                sandbox: policy,
                timeout,
            })
        }
        name => {
            let (server, tool, read_only) = mcp_tools
                .get(name)
                .ok_or_else(|| format!("{name} is not a tool of this device"))?;
            let server = settings
                .mcp_servers
                .iter()
                .find(|config| &config.name == server)
                .ok_or("that MCP server was removed")?
                .clone();

            Ok(Action::Mcp {
                arguments: input.clone(),
                read_only: *read_only,
                server,
                tool: tool.clone(),
            })
        }
    }
}

struct Outcome {
    decision: &'static str,
    error: Option<String>,
    exit_code: Option<i32>,
    output: Option<String>,
    status: &'static str,
    /// The tool itself cut its output (the shell's pipe cap).
    truncated: bool,
}

impl Outcome {
    fn failed(decision: &'static str, error: impl Into<String>) -> Self {
        Outcome {
            decision,
            error: Some(error.into()),
            exit_code: None,
            output: None,
            status: "failed",
            truncated: false,
        }
    }

    fn denied(decision: &'static str) -> Self {
        Outcome {
            decision,
            error: None,
            exit_code: None,
            output: None,
            status: "denied",
            truncated: false,
        }
    }
}

fn run_action(
    state: &DeviceState,
    action: Action,
    remaining: Duration,
    decision: &'static str,
) -> Outcome {
    let completed = |output: String| Outcome {
        decision,
        error: None,
        exit_code: None,
        output: Some(output),
        status: "completed",
        truncated: false,
    };

    match action {
        Action::List(path) => match fs::list(&path) {
            Ok(listing) => completed(serde_json::to_string_pretty(&listing).unwrap_or_default()),
            Err(error) => Outcome::failed(decision, error),
        },
        Action::Read(path) => {
            fs::read(&path).map_or_else(|error| Outcome::failed(decision, error), completed)
        }
        Action::Write {
            content,
            overwrite,
            path,
        } => fs::write(&path, &content, overwrite)
            .map_or_else(|error| Outcome::failed(decision, error), completed),
        Action::Shell {
            command,
            cwd,
            sandbox,
            timeout,
            ..
        } => match shell::run(
            &command,
            &cwd,
            timeout.min(remaining),
            MAX_OUTPUT_BYTES,
            sandbox.as_ref(),
        ) {
            Ok(result) if result.timed_out => Outcome {
                output: Some(result.output),
                truncated: result.truncated,
                ..Outcome::failed(
                    decision,
                    format!("stopped after {} s", timeout.min(remaining).as_secs()),
                )
            },
            Ok(result) => Outcome {
                exit_code: result.exit_code,
                truncated: result.truncated,
                ..completed(result.output)
            },
            Err(error) => Outcome::failed(decision, error),
        },
        Action::Mcp {
            arguments,
            server,
            tool,
            ..
        } => {
            match state.mcp.with(&server, |process| {
                process.call_tool(&tool, arguments.clone(), MCP_CALL_TIMEOUT.min(remaining))
            }) {
                Ok((text, false)) => completed(text),
                Ok((text, true)) => Outcome {
                    output: Some(text),
                    ..Outcome::failed(decision, "the tool reported an error")
                },
                Err(error) => Outcome::failed(decision, error),
            }
        }
    }
}

/// What the page relays for one progress step: the call it is about and the
/// signed report (`{ v, kind: "progress", callId, deviceId, phase, issuedAt }`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub call_id: String,
    pub payload: String,
    pub signature: String,
}

pub fn progress_report(
    secret: &str,
    device_id: &str,
    call_id: &str,
    phase: &str,
    issued_at: u64,
) -> ProgressEvent {
    let signed = envelope::sign_value(
        secret,
        Domain::Progress,
        &json!({ "v": 1, "kind": "progress", "callId": call_id, "deviceId": device_id, "phase": phase, "issuedAt": issued_at }),
    );

    ProgressEvent {
        call_id: call_id.to_owned(),
        payload: signed.payload,
        signature: signed.signature,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub account_label: Option<String>,
    pub device_id: Option<String>,
    pub platform: &'static str,
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn valid_pairing(device_id: &str, secret: &str, account_label: &str) -> bool {
    (1..=64).contains(&device_id.len())
        && device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && secret.len() == 64
        && secret
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && account_label.chars().count() <= 200
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub account_label: Option<String>,
    pub allow_rules: Vec<String>,
    pub allow_shell_network: bool,
    pub audit_path: String,
    pub mcp_servers: Vec<McpServerConfig>,
    pub paired: bool,
    pub require_shell_sandbox: bool,
    pub roots: Vec<String>,
    /// `None` when shell commands can be sandboxed here, else why not.
    pub sandbox_unavailable: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub allow_rules: Option<Vec<String>>,
    pub allow_shell_network: Option<bool>,
    pub mcp_servers: Option<Vec<McpServerConfig>>,
    pub require_shell_sandbox: Option<bool>,
    pub roots: Option<Vec<String>>,
    #[serde(default)]
    pub unpair: bool,
}

/// Why a canonical folder may not be shared, if it may not. The sandbox re-allows
/// reads and writes under every root, so a root holding `$HOME` would expose
/// `~/.ssh` and friends. A root INSIDE home is the user's choice.
fn refused_root(path: &Path, home: Option<&Path>) -> Option<&'static str> {
    if path.parent().is_none() {
        return Some("sharing a whole drive is not allowed");
    }

    home.filter(|home| home.starts_with(path))
        .map(|_| "sharing your home folder or one of its parents is not allowed")
}

fn canonical_home() -> Option<PathBuf> {
    sandbox::home().and_then(|home| stdfs::canonicalize(home).ok())
}

/// The shared roots that still exist, canonicalised, and that the home guard allows.
fn shareable_roots(roots: &[String]) -> Vec<PathBuf> {
    let home = canonical_home();

    fs::canonical_roots(roots)
        .into_iter()
        .filter(|root| refused_root(root, home.as_deref()).is_none())
        .collect()
}

/// Validates a new folder list: existing folders, canonical, never a filesystem root
/// or a folder holding the home folder.
pub fn validate_roots(roots: &[String]) -> Result<Vec<String>, String> {
    if roots.len() > MAX_ROOTS {
        return Err(format!("at most {MAX_ROOTS} folders"));
    }

    let home = canonical_home();
    let mut valid: Vec<String> = Vec::new();

    for root in roots {
        let path = stdfs::canonicalize(root).map_err(|_| format!("{root}: not found"))?;

        if !path.is_dir() {
            return Err(format!("{root}: not a folder"));
        }

        if let Some(reason) = refused_root(&path, home.as_deref()) {
            return Err(format!("{root}: {reason}"));
        }

        let path = path.to_string_lossy().into_owned();

        if !valid.contains(&path) {
            valid.push(path);
        }
    }

    Ok(valid)
}

pub fn validate_servers(servers: &[McpServerConfig]) -> Result<(), String> {
    if servers.len() > MAX_MCP_SERVERS {
        return Err(format!("at most {MAX_MCP_SERVERS} servers"));
    }

    for (index, server) in servers.iter().enumerate() {
        let name_ok = (1..=40).contains(&server.name.chars().count())
            && !servers[..index]
                .iter()
                .any(|other| other.name == server.name);

        if !name_ok
            || server.command.trim().is_empty()
            || server.command.len() > 1000
            || server.args.len() > 50
            || server.env.len() > 50
        {
            return Err(format!("server {}: invalid", index + 1));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changing_the_mcp_servers_forgets_the_cached_tool_metadata() {
        let dir =
            std::env::temp_dir().join(format!("neore-device-mcp-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = DeviceState::new(&dir, Box::new(|_| {}));

        state.mcp_tools.lock().unwrap().insert(
            "docs__search".to_owned(),
            ("docs".to_owned(), "search".to_owned(), true),
        );

        let unchanged: SettingsUpdate =
            serde_json::from_str(r#"{"allowShellNetwork":true}"#).unwrap();
        state.settings_update(unchanged).unwrap();
        assert_eq!(state.mcp_tools.lock().unwrap().len(), 1);

        let replaced: SettingsUpdate = serde_json::from_str(r#"{"mcpServers":[]}"#).unwrap();
        state.settings_update(replaced).unwrap();
        assert!(state.mcp_tools.lock().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_shell_network_setting_is_a_boolean_on_the_wire() {
        let on: SettingsUpdate = serde_json::from_str(r#"{"allowShellNetwork":true}"#).unwrap();

        assert_eq!(on.allow_shell_network, Some(true));
        assert!(serde_json::from_str::<SettingsUpdate>(r#"{"allowShellNetwork":"yes"}"#).is_err());
    }

    #[test]
    fn shell_and_writes_are_never_always_allowed() {
        let rules = vec![
            "shell_run".to_owned(),
            "fs_write".to_owned(),
            "fs_read".to_owned(),
        ];

        assert_eq!(decide("shell_run", false, false, &rules), (false, false));
        assert_eq!(decide("fs_write", false, false, &rules), (false, false));
        assert_eq!(decide("fs_read", false, true, &rules), (true, true));
    }

    #[test]
    fn a_tainted_call_always_asks_and_never_offers_always() {
        let rules = vec!["fs_read".to_owned()];

        assert_eq!(decide("fs_read", true, true, &rules), (false, false));
        assert_eq!(decide("mcp__git__status", true, true, &[]), (false, false));
    }

    #[test]
    fn an_untainted_call_without_a_rule_asks_and_offers_always() {
        assert_eq!(decide("mcp__git__status", false, true, &[]), (false, true));
    }

    #[test]
    fn a_read_only_mcp_tool_can_be_always_allowed() {
        let rules = vec!["mcp__git__status".to_owned()];

        assert_eq!(decide("mcp__git__status", false, true, &[]), (false, true));
        assert_eq!(
            decide("mcp__git__status", false, true, &rules),
            (true, true)
        );
    }

    #[test]
    fn a_non_read_only_mcp_tool_is_never_offered_always_nor_skips_its_prompt() {
        let rules = vec!["mcp__git__push".to_owned()];

        assert_eq!(decide("mcp__git__push", false, false, &[]), (false, false));
        assert_eq!(
            decide("mcp__git__push", false, false, &rules),
            (false, false)
        );
    }

    #[test]
    fn an_mcp_action_takes_its_read_only_flag_from_the_manifest() {
        let server = McpServerConfig {
            args: Vec::new(),
            command: "git".into(),
            env: Default::default(),
            name: "git".into(),
        };
        let mcp = |read_only| Action::Mcp {
            arguments: json!({}),
            read_only,
            server: server.clone(),
            tool: "status".into(),
        };

        assert!(mcp(true).read_only());
        assert!(!mcp(false).read_only());
    }

    #[test]
    fn caps_at_a_character_boundary() {
        assert_eq!(cap_utf8("héllo", 2), ("h".to_owned(), true));
        assert_eq!(cap_utf8("hi", 10), ("hi".to_owned(), false));
    }

    #[test]
    fn validates_pairing_input() {
        let secret = "a".repeat(64);

        assert!(valid_pairing("dev_1-x", &secret, "me@example.com"));
        assert!(!valid_pairing("../x", &secret, "me"));
        assert!(!valid_pairing("dev", "A".repeat(64).as_str(), "me"));
        assert!(!valid_pairing("dev", &secret, &"x".repeat(201)));
    }

    #[test]
    fn refuses_a_whole_drive_as_a_root() {
        assert!(validate_roots(&["/".to_owned()]).is_err());
        assert!(validate_roots(&[std::env::temp_dir().to_string_lossy().into_owned()]).is_ok());
    }

    #[test]
    fn refuses_a_root_that_holds_the_home_folder() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR"));

        assert!(refused_root(home, Some(home)).is_some());
        assert!(refused_root(home.parent().unwrap(), Some(home)).is_some());
        assert!(refused_root(&home.join("src"), Some(home)).is_none());
        // No home to protect: only the drive check applies.
        assert!(refused_root(home, None).is_none());
        assert!(refused_root(Path::new("/"), None).is_some());
    }

    #[test]
    fn shares_no_root_that_resolves_to_home_or_its_parent() {
        let home = canonical_home().expect("a home folder");
        let dir =
            std::env::temp_dir().join(format!("neore-device-shareable-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();

        let mut roots = vec![
            dir.to_string_lossy().into_owned(),
            format!("{}/..", home.display()),
        ];

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&home, dir.join("home-link")).unwrap();
            roots.push(dir.join("home-link").to_string_lossy().into_owned());
        }

        assert_eq!(
            shareable_roots(&roots),
            vec![stdfs::canonicalize(&dir).unwrap()]
        );
    }

    #[test]
    fn plans_only_inside_the_roots_and_only_known_tools() {
        let dir = std::env::temp_dir().join(format!("neore-device-plan-{}", std::process::id()));
        let _ = stdfs::create_dir_all(&dir);
        let settings = Settings {
            // Plans the same on a host without an OS sandbox.
            allow_unsandboxed_shell: true,
            roots: vec![dir.to_string_lossy().into_owned()],
            ..Settings::default()
        };
        let tools = HashMap::new();

        assert!(matches!(
            plan("fs_list", &json!({}), &settings, &tools),
            Ok(Action::List(_))
        ));
        assert!(plan(
            "fs_read",
            &json!({ "path": "/etc/passwd" }),
            &settings,
            &tools
        )
        .is_err());
        assert!(plan(
            "shell_run",
            &json!({ "command": "ls", "cwd": "/" }),
            &settings,
            &tools
        )
        .is_err());
        assert!(matches!(
            plan("shell_run", &json!({ "command": "ls", "timeoutSeconds": 99_999 }), &settings, &tools),
            Ok(Action::Shell { timeout, .. }) if timeout == SHELL_MAX_TIMEOUT
        ));
        assert!(plan("mcp__nope__x", &json!({}), &settings, &tools).is_err());
        assert!(plan("fs_list", &json!({}), &Settings::default(), &tools).is_err());
    }

    #[test]
    fn the_shell_prompt_says_whether_it_is_sandboxed() {
        let dir = std::env::temp_dir();
        let settings = Settings {
            roots: vec![dir.to_string_lossy().into_owned()],
            ..Settings::default()
        };

        match (
            sandbox::support(),
            plan(
                "shell_run",
                &json!({ "command": "ls" }),
                &settings,
                &HashMap::new(),
            ),
        ) {
            (sandbox::Support::Available(_), Ok(action)) => {
                assert!(action.detail().starts_with("Sandboxed ("));
                assert!(matches!(
                    action,
                    Action::Shell {
                        sandbox: Some(_),
                        ..
                    }
                ));
            }
            // Required by default: no sandbox, no run.
            (sandbox::Support::Unavailable(_), Err(error)) => {
                assert!(error.contains("Require sandbox for shell commands"));
            }
            (_, other) => panic!("unexpected plan: {:?}", other.map(|action| action.detail())),
        }
    }

    #[test]
    fn signs_progress_reports_for_the_backend() {
        let secret = "0123456789abcdef".repeat(4);
        let report = progress_report(&secret, "dev1", "call1", "prompting", 42);
        let parsed: Value = serde_json::from_str(&report.payload).unwrap();

        assert!(envelope::verify(
            &secret,
            Domain::Progress,
            &report.payload,
            &report.signature
        ));
        assert!(!envelope::verify(
            &secret,
            Domain::Result,
            &report.payload,
            &report.signature
        ));
        assert_eq!(parsed["kind"], "progress");
        assert_eq!(parsed["callId"], "call1");
        assert_eq!(parsed["deviceId"], "dev1");
        assert_eq!(parsed["phase"], "prompting");
        assert_eq!(parsed["issuedAt"], 42);

        let event = serde_json::to_value(&report).unwrap();
        assert_eq!(event["callId"], "call1");
        assert!(event["signature"].is_string());
    }

    #[test]
    fn offers_no_file_or_shell_tools_without_shared_folders() {
        assert!(builtin_tools(&[]).is_empty());
        assert_eq!(builtin_tools(&[std::env::temp_dir()]).len(), 4);
    }

    /// The approval gate end to end: a call waits for a person, a refusal runs
    /// nothing, and an approval runs it and returns a result the page cannot forge.
    #[test]
    fn a_call_runs_only_after_a_person_approves_it() {
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        crate::store::test_keychain::install();

        let dir = std::env::temp_dir().join(format!("neore-device-gate-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        stdfs::write(dir.join("a.txt"), "hello").unwrap();

        let secret = "0123456789abcdef".repeat(4);
        let root = dir.canonicalize().unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                pairing: Some(Pairing {
                    account_label: "me".into(),
                    device_id: "dev1".into(),
                    secret: secret.clone(),
                }),
                roots: vec![root.to_string_lossy().into_owned()],
                ..Settings::default()
            },
        )
        .unwrap();

        let (events, received) = channel();
        let state = Arc::new(DeviceState::new(
            &dir,
            Box::new(move |event| {
                let _ = events.send(event);
            }),
        ));
        let call = |call_id: &str, nonce: &str| {
            envelope::sign_value(
                &secret,
                Domain::Call,
                &json!({
                    "v": 1, "kind": "call", "callId": call_id, "deviceId": "dev1", "tool": "fs_read",
                    "input": { "path": "a.txt" }, "threadTitle": "T", "taintedBy": [],
                    "issuedAt": now_ms(), "expiresAt": now_ms() + 60_000, "nonce": nonce,
                }),
            )
        };

        for (nonce, answer, expected) in [("n1", "deny", "denied"), ("n2", "once", "completed")] {
            let signed = call(nonce, nonce);
            let worker = {
                let state = Arc::clone(&state);

                std::thread::spawn(move || state.execute(&signed))
            };
            let prompt = loop {
                match received.recv().unwrap() {
                    Event::Prompt { prompt } => break prompt,
                    _ => continue,
                }
            };

            state.prompt_answer(prompt.id, answer).unwrap();

            let result = worker.join().unwrap().unwrap();
            let parsed: Value = serde_json::from_str(&result.payload).unwrap();

            assert!(envelope::verify(
                &secret,
                Domain::Result,
                &result.payload,
                &result.signature
            ));
            assert_eq!(parsed["status"], expected);

            if expected == "completed" {
                assert_eq!(parsed["output"], "hello");
            }
        }

        let _ = stdfs::remove_dir_all(&dir);
    }
}
