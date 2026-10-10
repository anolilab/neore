//! Device execution: the agent's tools that run on THIS computer
//! (`docs/plans/device-execution.md`).
//!
//! The web page relays signed call envelopes from the backend to
//! `device_execute` and relays the signed results back. Everything that
//! matters happens here, out of the page's reach:
//!
//! - the envelope's HMAC, device id, expiry and nonce are verified
//!   (`envelope.rs`);
//! - the user approves the call in the LOCAL `device` window (`approval.rs`),
//!   unless they set an allow rule for that tool — never for `shell_run` or
//!   `fs_write`, and never when the call follows untrusted content (`taintedBy`);
//! - files are confined to the shared folders (`fs.rs`); shell commands run in
//!   the OS sandbox (`sandbox.rs`) or, unless the user turned the requirement
//!   off, not at all; shell output and every result are capped, and each
//!   decision is appended to a local audit log.
//!
//! Pairing, shared folders, MCP servers and allow rules change only through the
//! local window's commands or a confirmed pairing prompt.

pub mod approval;
pub mod envelope;
pub mod fs;
pub mod hmac;
pub mod mcp;
pub mod sandbox;
pub mod shell;
pub mod store;

use std::collections::HashMap;
use std::fs as stdfs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

use approval::{Answer, Prompt, PromptBody, Prompts};
use envelope::{Domain, NonceSet, Signed};
use mcp::{McpManager, McpServerConfig};
use store::{Pairing, Settings};

pub const DEVICE_WINDOW: &str = "device";
/// To the device window: the prompt queue changed.
pub const PROMPT_EVENT: &str = "neore:device-prompt";
/// To the main window: the tool set changed, send a fresh manifest.
pub const CHANGED_EVENT: &str = "neore:device-changed";
/// To the main window: a SIGNED report of where a call is (`prompting` /
/// `running`), which the page relays to `reportDeviceCallProgress` so the chat
/// can say "waiting for approval" rather than just "running".
pub const PROGRESS_EVENT: &str = "neore:device-progress";

/// Output cap for every result; the backend re-caps anyway.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const SHELL_DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const SHELL_MAX_TIMEOUT: Duration = Duration::from_secs(600);
const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ROOTS: usize = 20;
const MAX_MCP_SERVERS: usize = 20;
const AUDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;

pub struct DeviceState {
    audit_path: PathBuf,
    last_manifest_at: Mutex<u64>,
    mcp: McpManager,
    /// Manifest tool name → (server, the server's own tool name).
    mcp_tools: Mutex<HashMap<String, (String, String)>>,
    nonces: Mutex<NonceSet>,
    pub prompts: Prompts,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
}

impl DeviceState {
    pub fn new(data_dir: &Path) -> Self {
        let settings_path = data_dir.join("device.json");

        DeviceState {
            audit_path: data_dir.join("device-audit.jsonl"),
            last_manifest_at: Mutex::new(0),
            mcp: McpManager::default(),
            mcp_tools: Mutex::default(),
            nonces: Mutex::default(),
            prompts: Prompts::default(),
            settings: Mutex::new(store::load(&settings_path)),
            settings_path,
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

        if let Ok(mut file) = stdfs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.audit_path)
        {
            let _ = writeln!(file, "{entry}");
        }
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

/// `(skip the prompt, offer "Always allow")` for one call.
pub fn decide(tool: &str, tainted: bool, allow_rules: &[String]) -> (bool, bool) {
    let eligible = can_always_allow(tool) && !tainted;

    (
        eligible && allow_rules.iter().any(|rule| rule == tool),
        eligible,
    )
}

// ─── Tools ──────────────────────────────────────────────────────────────────

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
            "description": format!("Run one shell command on the user's computer and return its output (first 64 KiB). The working folder must be inside a shared folder: {shared}."),
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
        server: McpServerConfig,
        tool: String,
    },
}

impl Action {
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
    mcp_tools: &HashMap<String, (String, String)>,
) -> Result<Action, String> {
    let roots = fs::canonical_roots(&settings.roots);

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
            let (server, tool) = mcp_tools
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

/// Verifies, asks, runs and signs one call. Runs on a blocking thread.
fn execute<R: Runtime>(app: &AppHandle<R>, signed: &Signed) -> Result<Signed, String> {
    let state = app.state::<DeviceState>();
    let settings = state.settings();
    let pairing = settings
        .pairing
        .clone()
        .ok_or("this computer is not paired")?;
    let call = envelope::verify_call(
        &pairing.secret,
        &pairing.device_id,
        signed,
        now_ms(),
        &mut state.nonces.lock().unwrap(),
    )?;
    let tainted = !call.tainted_by.is_empty();
    let planned = plan(
        &call.tool,
        &call.input,
        &settings,
        &state.mcp_tools.lock().unwrap(),
    );
    let mut detail = String::new();

    let outcome = match planned {
        Err(error) => Outcome::failed("denied", error),
        Ok(action) => {
            detail = action.detail();

            let (skip_prompt, offer_always) = decide(&call.tool, tainted, &settings.allow_rules);
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

                state.prompts.ask(body, call.expires_at, wait, |prompt| {
                    emit_progress(app, &pairing, &call.call_id, "prompting");
                    show_prompt(app, prompt)
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
                let mut next = state.settings();

                if !next.allow_rules.contains(&call.tool) {
                    next.allow_rules.push(call.tool.clone());
                    let _ = state.save(next);
                }
            }

            let remaining = call.expires_at.saturating_sub(now_ms());

            match answer {
                Answer::Deny | Answer::Timeout => Outcome::denied(decision),
                _ if remaining == 0 => {
                    Outcome::failed(decision, "approved after the request expired")
                }
                _ => {
                    emit_progress(app, &pairing, &call.call_id, "running");
                    run_action(&state, action, Duration::from_millis(remaining), decision)
                }
            }
        }
    };

    let output = outcome
        .output
        .as_deref()
        .map(|text| cap_utf8(text, MAX_OUTPUT_BYTES));

    state.audit(json!({
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

/// What the page relays for one progress step: the call it is about and the
/// signed report (`{ v, kind: "progress", callId, deviceId, phase, issuedAt }`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    call_id: String,
    payload: String,
    signature: String,
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

/// Best effort: a lost report only leaves the chat saying "sent to the device".
fn emit_progress<R: Runtime>(app: &AppHandle<R>, pairing: &Pairing, call_id: &str, phase: &str) {
    let report = progress_report(
        &pairing.secret,
        &pairing.device_id,
        call_id,
        phase,
        now_ms(),
    );
    let _ = app.emit_to(crate::MAIN_WINDOW, PROGRESS_EVENT, report);
}

fn manifest(state: &DeviceState) -> Result<Signed, String> {
    let settings = state.settings();
    let pairing = settings
        .pairing
        .clone()
        .ok_or("this computer is not paired")?;
    let mut tools = builtin_tools(&fs::canonical_roots(&settings.roots));
    let mut mcp_tools = HashMap::new();

    for server in &settings.mcp_servers {
        match state.mcp.with(server, |process| process.list_tools()) {
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
                    mcp_tools.insert(name, (server.name.clone(), tool.name));
                }
            }
            Err(error) => crate::log(&format!("MCP server {} unavailable: {error}", server.name)),
        }
    }

    *state.mcp_tools.lock().unwrap() = mcp_tools;

    let issued_at = {
        let mut last = state.last_manifest_at.lock().unwrap();
        *last = now_ms().max(*last + 1);
        *last
    };

    Ok(envelope::sign_value(
        &pairing.secret,
        Domain::Manifest,
        &json!({ "v": 1, "kind": "manifest", "deviceId": pairing.device_id, "issuedAt": issued_at, "tools": tools }),
    ))
}

// ─── The local window ───────────────────────────────────────────────────────

pub fn open_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(DEVICE_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();

        return;
    }

    // A LOCAL page (`src/device.html`): the remote app cannot script it, and
    // only this window's capability grants the answer and settings commands.
    let built =
        WebviewWindowBuilder::new(app, DEVICE_WINDOW, WebviewUrl::App("device.html".into()))
            .title("Neore — this computer")
            .inner_size(560.0, 600.0)
            .min_inner_size(420.0, 420.0)
            .always_on_top(true)
            .center()
            .focused(true)
            .build();

    match built {
        Ok(window) => {
            let handle = app.clone();

            // Closing the window is a "no" to everything it was asking.
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { .. } = event {
                    handle.state::<DeviceState>().prompts.deny_all();
                }
            });
        }
        Err(error) => crate::log(&format!("could not open the device window: {error}")),
    }
}

fn show_prompt<R: Runtime>(app: &AppHandle<R>, prompt: &Prompt) {
    open_window(app);
    let _ = app.emit_to(DEVICE_WINDOW, PROMPT_EVENT, ());

    let body = match &prompt.body {
        PromptBody::Pairing { .. } => "Confirm pairing this computer".to_owned(),
        PromptBody::Call {
            tool, thread_title, ..
        } => format!("{tool} — {thread_title}"),
    };
    let _ = app
        .notification()
        .builder()
        .title("Neore is asking for your approval")
        .body(body)
        .show();
}

fn notify_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to(crate::MAIN_WINDOW, CHANGED_EVENT, ());
}

// ─── Remote commands (the web app in the main window) ───────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    account_label: Option<String>,
    device_id: Option<String>,
    platform: &'static str,
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

#[tauri::command]
pub fn device_status(state: State<'_, DeviceState>) -> StatusView {
    let pairing = state.settings().pairing;

    StatusView {
        account_label: pairing
            .as_ref()
            .map(|pairing| pairing.account_label.clone()),
        device_id: pairing.map(|pairing| pairing.device_id),
        platform: platform(),
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

/// Stores a pairing — only after the user confirms it in the local window.
#[tauri::command]
pub async fn device_pair<R: Runtime>(
    app: AppHandle<R>,
    device_id: String,
    secret: String,
    account_label: String,
) -> Result<bool, String> {
    let account_label = account_label.trim().to_owned();

    if !valid_pairing(&device_id, &secret, &account_label) {
        return Err("invalid pairing".into());
    }

    if app
        .state::<DeviceState>()
        .prompts
        .current()
        .is_some_and(|prompt| matches!(prompt.body, PromptBody::Pairing { .. }))
    {
        return Err("already waiting for a pairing confirmation".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DeviceState>();
        let answer = state.prompts.ask(
            PromptBody::Pairing {
                account_label: account_label.clone(),
            },
            now_ms() + 5 * 60_000,
            Duration::from_secs(5 * 60),
            |prompt| show_prompt(&app, prompt),
        );

        if !matches!(answer, Answer::Once | Answer::Always) {
            return Ok(false);
        }

        let mut settings = state.settings();

        settings.pairing = Some(Pairing {
            account_label,
            device_id,
            secret,
        });
        settings.allow_rules.clear();
        state.save(settings)?;

        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The signed tool list, for the backend to offer the agent.
#[tauri::command]
pub async fn device_manifest<R: Runtime>(app: AppHandle<R>) -> Result<Signed, String> {
    tauri::async_runtime::spawn_blocking(move || manifest(&app.state::<DeviceState>()))
        .await
        .map_err(|error| error.to_string())?
}

/// Verifies, asks about, runs and signs one call the page relayed.
#[tauri::command]
pub async fn device_execute<R: Runtime>(
    app: AppHandle<R>,
    envelope: String,
    signature: String,
) -> Result<Signed, String> {
    let signed = Signed {
        payload: envelope,
        signature,
    };

    tauri::async_runtime::spawn_blocking(move || execute(&app, &signed))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn device_open_settings<R: Runtime>(app: AppHandle<R>) {
    open_window(&app);
}

// ─── Local commands (the `device` window only) ──────────────────────────────

#[tauri::command]
pub fn device_prompt_current(state: State<'_, DeviceState>) -> Option<Prompt> {
    state.prompts.current()
}

#[tauri::command]
pub fn device_prompt_answer(
    state: State<'_, DeviceState>,
    id: u64,
    answer: String,
) -> Result<(), String> {
    state
        .prompts
        .answer(id, Answer::parse(&answer).ok_or("unknown answer")?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    account_label: Option<String>,
    allow_rules: Vec<String>,
    audit_path: String,
    mcp_servers: Vec<McpServerConfig>,
    paired: bool,
    require_shell_sandbox: bool,
    roots: Vec<String>,
    /// `None` when shell commands can be sandboxed here, else why not.
    sandbox_unavailable: Option<String>,
}

fn settings_view(state: &DeviceState) -> SettingsView {
    let settings = state.settings();

    SettingsView {
        account_label: settings
            .pairing
            .as_ref()
            .map(|pairing| pairing.account_label.clone()),
        allow_rules: settings.allow_rules,
        audit_path: state.audit_path.to_string_lossy().into_owned(),
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

#[tauri::command]
pub fn device_settings_get(state: State<'_, DeviceState>) -> SettingsView {
    settings_view(&state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    allow_rules: Option<Vec<String>>,
    mcp_servers: Option<Vec<McpServerConfig>>,
    require_shell_sandbox: Option<bool>,
    roots: Option<Vec<String>>,
    #[serde(default)]
    unpair: bool,
}

/// Validates a new folder list: existing folders, canonical, never a filesystem root.
pub fn validate_roots(roots: &[String]) -> Result<Vec<String>, String> {
    if roots.len() > MAX_ROOTS {
        return Err(format!("at most {MAX_ROOTS} folders"));
    }

    let mut valid: Vec<String> = Vec::new();

    for root in roots {
        let path = stdfs::canonicalize(root).map_err(|_| format!("{root}: not found"))?;

        if !path.is_dir() {
            return Err(format!("{root}: not a folder"));
        }

        if path.parent().is_none() {
            return Err(format!("{root}: sharing a whole drive is not allowed"));
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

#[tauri::command]
pub fn device_settings_update<R: Runtime>(
    app: AppHandle<R>,
    update: SettingsUpdate,
) -> Result<SettingsView, String> {
    let state = app.state::<DeviceState>();
    let mut settings = state.settings();

    if let Some(roots) = update.roots {
        settings.roots = validate_roots(&roots)?;
    }

    if let Some(servers) = update.mcp_servers {
        validate_servers(&servers)?;
        settings.mcp_servers = servers;
    }

    if let Some(required) = update.require_shell_sandbox {
        settings.allow_unsandboxed_shell = !required;
    }

    // Rules are only ever REMOVED here; one is added by answering "Always allow".
    if let Some(rules) = update.allow_rules {
        settings.allow_rules.retain(|rule| rules.contains(rule));
    }

    if update.unpair {
        settings.pairing = None;
        settings.allow_rules.clear();
    }

    state.save(settings)?;
    state.reap_idle_servers();
    notify_changed(&app);

    Ok(settings_view(&state))
}

#[tauri::command]
pub async fn device_pick_folder<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|folder| folder.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub fn device_audit_tail(state: State<'_, DeviceState>) -> Vec<String> {
    let text = stdfs::read_to_string(&state.audit_path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();

    lines[lines.len().saturating_sub(200)..]
        .iter()
        .rev()
        .map(|line| (*line).to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_and_writes_are_never_always_allowed() {
        let rules = vec![
            "shell_run".to_owned(),
            "fs_write".to_owned(),
            "fs_read".to_owned(),
        ];

        assert_eq!(decide("shell_run", false, &rules), (false, false));
        assert_eq!(decide("fs_write", false, &rules), (false, false));
        assert_eq!(decide("fs_read", false, &rules), (true, true));
    }

    #[test]
    fn a_tainted_call_always_asks_and_never_offers_always() {
        let rules = vec!["fs_read".to_owned()];

        assert_eq!(decide("fs_read", true, &rules), (false, false));
        assert_eq!(decide("mcp__git__status", true, &[]), (false, false));
    }

    #[test]
    fn an_untainted_call_without_a_rule_asks_and_offers_always() {
        assert_eq!(decide("mcp__git__status", false, &[]), (false, true));
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
}
