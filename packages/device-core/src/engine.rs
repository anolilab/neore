//! The device engine: pairing, the signed relay, approvals, the sandboxed shell and local
//! MCP servers. Windows, notifications and dialogs belong to the host.
//!
//! The host (the Electron shell through `device-core-node`, or any other
//! embedder) owns the windows. It hands the engine an event sink and calls the
//! methods here; the engine never reaches into a UI. Every security decision —
//! envelope verification, the approval rules, root confinement, sandboxing,
//! output caps and the audit log — happens in this crate.

use std::collections::{HashMap, HashSet};
use std::fs as stdfs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::acp_permission::AcpPermissions;
use crate::actions::{
    self, canonical_home, plan_builtin, platform, refused_root, shareable_roots, Action,
    ShellSettings, MAX_ROOTS,
};
use crate::approval::{Answer, Prompt, PromptBody, Prompts, SandboxState};
use crate::envelope::{self, CallEnvelope, Domain, NonceSet, Signed};
use crate::install::{Bundle, Root};
use crate::mcp::{self, McpManager, McpServerConfig};
use crate::sandbox;
use crate::ssh::{HostLink, SshPaths, Target};
use crate::store::{self, Host, Pairing, Settings};

mod hosts;
mod reconnect;

pub use hosts::{HostProbe, HostSpec, HostUpdate};
pub use reconnect::ReconnectView;

pub use crate::actions::{cap_utf8, now_ms, MAX_OUTPUT_BYTES};

const MAX_MCP_SERVERS: usize = 20;
const AUDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// The one `acp_*` call kind handled here: stopping a turn needs no prompt. Starting, sending and answering come
/// with the remote-control slice.
const ACP_CANCEL_TOOL: &str = "acp_cancel";
const ACP_ID_MAX: usize = 128;
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
    /// A coding agent is asking for approval: show the device window. Read the requests with `acp_permissions`.
    AcpPermission { agent: String, tool: String },
    /// The backend asked this computer to cancel a coding agent's turn (a signed `acp_cancel` call).
    #[serde(rename_all = "camelCase")]
    AcpCancel { session_id: String, turn_id: String },
}

/// Receives [`Event`]s. Called from engine threads; must not block.
pub type Sink = Box<dyn Fn(Event) + Send + Sync>;

/// The same sink, shared with the threads that ask the user about an SSH connection.
type SharedSink = Arc<dyn Fn(Event) + Send + Sync>;

/// One MCP tool the manifest offered: its server, its own name on that server, and whether it declared itself read-only.
struct McpToolRef {
    server: String,
    tool: String,
    read_only: bool,
}

pub struct DeviceState {
    pub(crate) acp_permissions: AcpPermissions,
    audit_path: PathBuf,
    last_manifest_at: Mutex<u64>,
    mcp: McpManager,
    /// Manifest tool name → the MCP tool it names.
    mcp_tools: Mutex<HashMap<String, McpToolRef>>,
    /// Held across every read-change-save of the settings, so two writers cannot each save the other's stale copy.
    save_lock: Mutex<()>,
    /// Bumped by every `settings_update` that is saved, under the save lock. A call remembers the value it was planned under, so
    /// anything the owner changed since (folders, shell policy, servers, rules) is seen as one number.
    generation: AtomicU64,
    nonces: Mutex<NonceSet>,
    prompts: Arc<Prompts>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    sink: SharedSink,
    ssh: SshState,
}

#[cfg(test)]
type Connector =
    Box<dyn Fn(&Target) -> Result<Arc<dyn HostLink>, reconnect::ConnectError> + Send + Sync>;

/// What the engine keeps for the servers it reaches over SSH.
struct SshState {
    /// The remote path of `neore-host`; shell text, never taken from a page.
    binary: String,
    /// The host binaries this build ships, or why there are none (a build that did not package them).
    bundle: Result<Bundle, String>,
    /// The servers (`host:port`) with a "key changed" prompt on screen, so a retry does not queue another.
    changed_prompts: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Live connections by the server's device id.
    connections: Mutex<HashMap<String, Arc<dyn HostLink>>>,
    /// The servers (by device id) with a connection attempt running: at most one each, the person's or the keeper's.
    attempting: Arc<Mutex<HashSet<String>>>,
    /// The servers the person connected and has not disconnected, with where their reconnecting stands.
    keeps: Mutex<HashMap<String, crate::lifecycle::Keep>>,
    /// The launches of `neore-host` this computer started on each server, so the next session can stop the ones a
    /// lost connection left running. Never a host this computer did not start.
    launches: Mutex<HashMap<String, Vec<String>>>,
    /// Counts explicit disconnects, so a connect that was waiting (on a passphrase, say) can tell the user ended
    /// connections meanwhile and not install its link over that.
    disconnects: Mutex<HashMap<String, u64>>,
    paths: SshPaths,
    /// The connection a server was probed over, waiting for its pairing: at most one.
    probe: Mutex<Option<(Target, Arc<dyn HostLink>)>>,
    /// Where the host versions live on a server.
    root: Root,
    /// Stands in for ssh in tests that need a session they can pause.
    #[cfg(test)]
    connector: Option<Connector>,
    /// The servers (by device id) whose host software is being installed or upgraded. No session may start on one.
    upgrading: Mutex<Vec<(String, Target)>>,
}

impl DeviceState {
    pub fn new(data_dir: &Path, sink: Sink) -> Self {
        Self::with_host_binary(data_dir, sink, &crate::ssh::default_binary())
    }

    /// [`Self::new`] launching `binary` (remote shell text) on a server instead of the installed `neore-host`.
    /// For tests that run a throwaway server; nothing a page says reaches it.
    pub fn with_host_binary(data_dir: &Path, sink: Sink, binary: &str) -> Self {
        let settings_path = data_dir.join("device.json");
        // The stored roots are kept as they are: a folder that is unplugged now must survive a save. The
        // planner and the tools canonicalise and filter them at the point of use (`shareable_roots`).
        let settings = store::load(&settings_path);

        DeviceState {
            acp_permissions: AcpPermissions::default(),
            audit_path: data_dir.join("device-audit.jsonl"),
            last_manifest_at: Mutex::new(0),
            mcp: McpManager::default(),
            mcp_tools: Mutex::default(),
            save_lock: Mutex::default(),
            generation: AtomicU64::new(0),
            nonces: Mutex::new(NonceSet::persisted(
                &data_dir.join("device-nonces.json"),
                now_ms(),
            )),
            prompts: Arc::default(),
            settings: Mutex::new(settings),
            settings_path,
            sink: Arc::from(sink),
            ssh: SshState {
                binary: binary.to_owned(),
                attempting: Arc::default(),
                bundle: Err("this build ships no host software".to_owned()),
                changed_prompts: Arc::default(),
                keeps: Mutex::default(),
                launches: Mutex::default(),
                connections: Mutex::default(),
                disconnects: Mutex::default(),
                paths: SshPaths::under(data_dir, sandbox::home().as_deref()),
                probe: Mutex::default(),
                root: Root::Home,
                #[cfg(test)]
                connector: None,
                upgrading: Mutex::default(),
            },
        }
    }

    /// Gives this engine the host binaries to install, under `root` on a server. The binary it launches there is
    /// the pinned version in that folder.
    #[must_use]
    pub fn with_host_bundle(mut self, bundle: Result<Bundle, String>, root: Root) -> Self {
        self.ssh.binary = root.binary(crate::ssh::HOST_VERSION);
        self.ssh.bundle = bundle;
        self.ssh.root = root;

        self
    }

    pub(crate) fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    /// Changes the settings under the save lock: each writer reads what the last one saved, then saves its own change.
    pub(crate) fn change_settings<T>(
        &self,
        change: impl FnOnce(&mut Settings) -> Result<T, String>,
    ) -> Result<T, String> {
        self.change_settings_counted(false, change)
    }

    /// [`Self::change_settings`], bumping the generation once the change is validated AND saved, still under the
    /// lock: a failed update leaves the calls waiting on the old settings valid.
    fn change_settings_counted<T>(
        &self,
        bump: bool,
        change: impl FnOnce(&mut Settings) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self.save_lock.lock().unwrap();
        let mut settings = self.settings();
        let value = change(&mut settings)?;

        self.save(settings)?;

        if bump {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }

        Ok(value)
    }

    fn save(&self, settings: Settings) -> Result<(), String> {
        let previous = self.settings();

        store::save_over(&self.settings_path, &previous, &settings)?;
        *self.settings.lock().unwrap() = settings;

        Ok(())
    }

    pub(crate) fn emit(&self, event: Event) {
        (self.sink)(event);
    }

    pub fn reap_idle_servers(&self) {
        self.mcp.reap(&self.settings().mcp_servers);
    }

    pub fn stop_servers(&self) {
        self.mcp.stop_all();
        self.close_hosts();
    }

    pub(crate) fn audit(&self, entry: Value) {
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

    /// Answers a passphrase prompt with what the user typed.
    pub fn prompt_secret(&self, id: u64, secret: String) -> Result<(), String> {
        self.prompts.answer_secret(id, secret)
    }

    /// Closing the approval window is a "no" to everything it was asking.
    pub fn deny_prompts(&self) {
        self.prompts.deny_all();
        self.acp_decline_all();
    }

    pub fn status(&self) -> StatusView {
        let pairing = self.settings().pairing;

        StatusView {
            account_label: pairing
                .as_ref()
                .map(|pairing| pairing.account_label.clone()),
            device_id: pairing.map(|pairing| pairing.device_id),
            hosts: self.host_statuses(),
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

        // Counted: a call approved under the previous pairing must not run under this one.
        self.change_settings_counted(true, |settings| {
            // The servers belong to the pairing that registered them; another device id cannot speak for them.
            if settings
                .pairing
                .as_ref()
                .is_none_or(|current| current.device_id != device_id)
            {
                settings.hosts.clear();
            }

            settings.pairing = Some(Pairing {
                account_label,
                device_id: device_id.to_owned(),
                secret: secret.to_owned(),
            });
            settings.allow_rules.clear();

            Ok(())
        })?;
        self.drop_stale_connections();

        Ok(true)
    }

    pub fn settings_view(&self) -> SettingsView {
        let settings = self.settings();
        let hosts = self.host_views(&settings);

        SettingsView {
            account_label: settings
                .pairing
                .as_ref()
                .map(|pairing| pairing.account_label.clone()),
            allow_rules: settings.allow_rules,
            allow_shell_network: settings.allow_shell_network,
            audit_path: self.audit_path.to_string_lossy().into_owned(),
            hosts,
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

    /// Whether no `settings_update` has run since `generation` was read. Takes the save lock, so an update that is
    /// in flight has finished (and bumped) before this answers.
    #[cfg(test)]
    fn settings_unchanged(&self, generation: u64) -> bool {
        let _guard = self.save_lock.lock().unwrap();

        self.generation.load(Ordering::SeqCst) == generation
    }

    /// Whether the approval still covers the call right before it starts, under the save lock (an update in flight has
    /// finished first; the lock is not held while the action runs). Settings untouched since planning: yes. Changed
    /// meanwhile: the call is planned again from what is saved now and must come out as the very same action, so an
    /// unrelated change (another folder shared) lets it run while a removed folder, a shell policy or a replaced
    /// server does not. A call that skipped its prompt on an allow rule also needs that rule to still be there.
    fn approval_holds(
        &self,
        generation: u64,
        (tool, input, tainted): (&str, &Value, bool),
        action: &Action,
        rule_approved: bool,
        pairing: &Pairing,
    ) -> bool {
        let _guard = self.save_lock.lock().unwrap();
        let current = self.settings();

        // The call was verified and approved under one pairing; another (a re-pair, even of the same device) is
        // another secret, and nothing approved before it carries over.
        if current.pairing.as_ref() != Some(pairing) {
            return false;
        }

        if self.generation.load(Ordering::SeqCst) == generation {
            return true;
        }

        plan(tool, input, &current, &self.mcp_tools.lock().unwrap())
            .is_ok_and(|again| again == *action)
            && (!rule_approved || decide(tool, tainted, action.read_only(), &current.allow_rules).0)
    }

    pub fn settings_update(&self, update: SettingsUpdate) -> Result<SettingsView, String> {
        self.change_settings_counted(true, |settings| {
            if let Some(roots) = update.roots {
                settings.roots = validate_roots(&roots)?;
            }

            if let Some(servers) = update.mcp_servers {
                validate_servers(&servers)?;
                let changed = changed_server_names(&settings.mcp_servers, &servers);
                drop_rules_of_changed_servers(
                    &settings.mcp_servers,
                    &servers,
                    &mut settings.allow_rules,
                );
                settings.mcp_servers = servers;
                // The cached `readOnly` flags of a removed or changed server describe the old one. Dropping them
                // makes its MCP calls fail closed until the next manifest, so none can skip its prompt on stale
                // metadata; the tools of servers that did not change stay, so a call to one is not cancelled.
                self.mcp_tools
                    .lock()
                    .unwrap()
                    .retain(|_, tool| !changed.contains(&tool.server));
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

            if let Some(host) = &update.host {
                hosts::apply_update(settings, host)?;
            }

            if update.unpair {
                self.prompts.deny_all();
                settings.pairing = None;
                settings.hosts.clear();
                settings.allow_rules.clear();
            }

            Ok(())
        })?;
        self.drop_stale_connections();

        // A probe belongs to the pairing that is gone: the next account must not inherit an open connection.
        if update.unpair {
            self.close_probe();
        }

        // Forwarding is chosen when the master starts, so the master it changes for is ended, whoever else rides it.
        if let Some(host) = update.host.filter(|host| host.forward_agent.is_some()) {
            self.host_restart(&host.device_id);
        }

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
        // Read before the settings, so an update in between only ever makes the call look stale.
        let generation = self.generation.load(Ordering::SeqCst);
        let settings = self.settings();

        // A call for a server this computer speaks for: its envelope names the server, and only that server's
        // secret verifies it.
        if let Some(host) = hosts::host_named_by(&settings, &signed.payload) {
            return self.execute_host(host, signed);
        }

        let pairing = usable_pairing(&settings)?;
        let call = envelope::verify_call(
            &pairing.secret,
            &pairing.device_id,
            signed,
            now_ms(),
            &mut self.nonces.lock().unwrap(),
        )?;

        if call.tool == ACP_CANCEL_TOOL {
            return self.execute_acp_cancel(&pairing, &call);
        }

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
                        host: None,
                        input: serde_json::to_string_pretty(&call.input).unwrap_or_default(),
                        sandbox: sandbox_state(&action),
                        tainted_by: call.tainted_by.clone(),
                        thread_title: call.thread_title.clone(),
                        tool: call.tool.clone(),
                        tool_kind: action.kind().to_owned(),
                    };

                    self.prompts.ask(body, call.expires_at, wait, |prompt| {
                        self.emit_progress(
                            &pairing.secret,
                            &pairing.device_id,
                            &call.call_id,
                            "prompting",
                        );
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

                // The settings can change while the prompt is open (a folder unshared, shell network off, a
                // server replaced, a rule removed). The rule is saved only if nothing changed since the call was
                // planned, checked under the save lock, so a replaced server never inherits it; the dispatch below
                // checks again, so the call never starts under a policy the owner has since changed.
                if answer == Answer::Always && offer_always {
                    let _ = self.change_settings(|next| {
                        if next.pairing.as_ref() != Some(&pairing) {
                            return Err("the pairing changed while waiting".to_owned());
                        }

                        // Under the save lock, so nothing changes meanwhile: the tool must still plan to the very
                        // action that was approved (same server config included), or the rule is not saved.
                        if self.generation.load(Ordering::SeqCst) != generation
                            && !plan(
                                &call.tool,
                                &call.input,
                                next,
                                &self.mcp_tools.lock().unwrap(),
                            )
                            .is_ok_and(|again| again == action)
                        {
                            return Err("the settings changed while waiting".to_owned());
                        }

                        if !next.allow_rules.contains(&call.tool) {
                            next.allow_rules.push(call.tool.clone());
                        }

                        Ok(())
                    });
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
                    _ if !self.approval_holds(
                        generation,
                        (&call.tool, &call.input, tainted),
                        &action,
                        skip_prompt,
                        &pairing,
                    ) =>
                    {
                        Outcome::failed(
                        decision,
                            "the shared folders, shell settings, MCP server or allow rule changed while waiting",
                        )
                    }
                    _ if remaining == 0 => {
                        Outcome::failed(decision, "approved after the request expired")
                    }
                    _ => {
                        self.emit_progress(&pairing.secret, &pairing.device_id, &call.call_id, "running");
                        run_action(self, action, Duration::from_millis(remaining), decision)
                    }
                }
            }
        };

        Ok(self.signed_result(
            (&pairing.secret, &pairing.device_id, None),
            &call,
            &detail,
            outcome,
        ))
    }

    /// Audits one call and signs its result with the secret of the device it was for (`who` is that secret, the
    /// device id and, for a server, its name).
    fn signed_result(
        &self,
        who: (&str, &str, Option<&str>),
        call: &envelope::CallEnvelope,
        detail: &str,
        outcome: Outcome,
    ) -> Signed {
        let (secret, device_id, host) = who;
        let output = outcome
            .output
            .as_deref()
            .map(|text| cap_utf8(text, MAX_OUTPUT_BYTES));
        let mut audit = json!({
            "at": now_ms(), "callId": call.call_id, "decision": outcome.decision, "detail": cap_utf8(detail, 1000).0,
            "status": outcome.status, "taintedBy": call.tainted_by, "thread": call.thread_title, "tool": call.tool,
        });

        if let Some(host) = host {
            audit["host"] = json!(host);
        }

        self.audit(audit);

        let mut result = json!({
            "v": 1, "kind": "result", "callId": call.call_id, "deviceId": device_id,
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

        envelope::sign_value(secret, Domain::Result, &result)
    }

    /// A cancel needs no approval: it only stops a turn the user already started. The main process does the
    /// stopping when it receives the event; the signed result says the request was valid and handed on.
    fn execute_acp_cancel(&self, pairing: &Pairing, call: &CallEnvelope) -> Result<Signed, String> {
        let id = |key: &str| {
            call.input
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| (1..=ACP_ID_MAX).contains(&value.len()))
        };
        let outcome = match (id("sessionId"), id("turnId")) {
            (Some(session_id), Some(turn_id)) => {
                self.emit(Event::AcpCancel {
                    session_id: session_id.to_owned(),
                    turn_id: turn_id.to_owned(),
                });
                Outcome::done("accepted")
            }
            _ => Outcome::failed("denied", "refused: a cancel names a session and a turn"),
        };

        self.audit(json!({
            "at": now_ms(), "callId": call.call_id, "decision": outcome.decision,
            "status": outcome.status, "thread": call.thread_title, "tool": call.tool,
        }));

        let mut result = json!({
            "v": 1, "kind": "result", "callId": call.call_id, "deviceId": pairing.device_id,
            "status": outcome.status, "decision": outcome.decision, "truncated": false,
        });

        if let Some(output) = outcome.output {
            result["output"] = json!(output);
        }

        if let Some(error) = outcome.error {
            result["error"] = json!(error);
        }

        Ok(envelope::sign_value(
            &pairing.secret,
            Domain::Result,
            &result,
        ))
    }

    /// Signs one batch of coding-agent turn output for the backend's ingest route. Only a payload that names
    /// itself a turn post for THIS device is signed, so this is no general signing oracle.
    pub fn sign_turn(&self, payload: &str) -> Result<String, String> {
        let pairing = usable_pairing(&self.settings())?;
        let parsed: Value =
            serde_json::from_str(payload).map_err(|_| "the turn post is not JSON")?;

        if parsed.get("v") != Some(&json!(1))
            || parsed.get("kind") != Some(&json!("turn"))
            || parsed.get("deviceId").and_then(Value::as_str) != Some(pairing.device_id.as_str())
        {
            return Err("the post is not a turn post for this computer".into());
        }

        Ok(envelope::sign(&pairing.secret, Domain::Turn, payload))
    }

    /// A manifest time later than every one issued before, so the backend never sees one go backwards.
    fn next_manifest_time(&self) -> u64 {
        let mut last = self.last_manifest_at.lock().unwrap();

        *last = now_ms().max(*last + 1);

        *last
    }

    fn emit_progress(&self, secret: &str, device_id: &str, call_id: &str, phase: &str) {
        // Best effort: a lost report only leaves the chat saying "sent to the device".
        self.emit(Event::Progress(progress_report(
            secret,
            device_id,
            call_id,
            phase,
            now_ms(),
        )));
    }

    /// The signed tool list, for the backend to offer the agent.
    pub fn manifest(&self) -> Result<Signed, String> {
        self.manifest_for(None)
    }

    /// The signed tool list of this computer (`None`) or of one of its servers. A server's is signed with that
    /// server's own secret, so the backend sees it as a device of its own.
    pub fn manifest_for(&self, device_id: Option<&str>) -> Result<Signed, String> {
        let settings = self.settings();

        if let Some(device_id) = device_id.filter(|id| {
            settings
                .pairing
                .as_ref()
                .is_none_or(|pairing| pairing.device_id != *id)
        }) {
            return self.host_manifest(&settings, device_id);
        }

        let pairing = usable_pairing(&settings)?;
        let mut tools = builtin_tools(&shareable_roots(&settings.roots), "the user's computer");
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
                        mcp_tools.insert(
                            name,
                            McpToolRef {
                                server: server.name.clone(),
                                tool: tool.name,
                                read_only: tool.read_only,
                            },
                        );
                    }
                }
                Err(error) => eprintln!(
                    "[device-core] MCP server {} unavailable: {error}",
                    server.name
                ),
            }
        }

        // A server change that landed during the listing makes this snapshot stale: leave the cache empty (calls
        // then fail closed) rather than write read-only flags that belong to the servers it replaced.
        if self.settings().mcp_servers == settings.mcp_servers {
            *self.mcp_tools.lock().unwrap() = mcp_tools;
        }

        let issued_at = self.next_manifest_time();

        Ok(envelope::sign_value(
            &pairing.secret,
            Domain::Manifest,
            &json!({ "v": 1, "kind": "manifest", "deviceId": pairing.device_id, "issuedAt": issued_at, "tools": tools }),
        ))
    }
}

/// Names of the servers that were removed, changed or added.
fn changed_server_names(old: &[McpServerConfig], new: &[McpServerConfig]) -> Vec<String> {
    old.iter()
        .filter(|server| !new.contains(server))
        .chain(new.iter().filter(|server| !old.contains(server)))
        .map(|server| server.name.clone())
        .collect()
}

/// Forgets the "Always allow" rules of every MCP server that was removed, replaced or added. A rule is keyed on the
/// tool's manifest name, which only carries the server's NAME, so a different program under the same name would
/// otherwise inherit the approval the user gave the old one. `validate_servers` refuses names whose tool-name
/// prefixes overlap, so the server's exact prefix owns its rules and no other server's.
fn drop_rules_of_changed_servers(
    old: &[McpServerConfig],
    new: &[McpServerConfig],
    rules: &mut Vec<String>,
) {
    for name in changed_server_names(old, new) {
        let prefix = mcp::tool_name(&name, "");

        rules.retain(|rule| !rule.starts_with(&prefix));
    }
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

/// The built-in tools over `roots`, worded for where they run (`place`: this computer, or a server by name).
fn builtin_tools(roots: &[PathBuf], place: &str) -> Vec<Value> {
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
            "description": format!("List a folder on {place}. Shared folders: {shared}."),
            "inputSchema": { "type": "object", "properties": { "path": path } } }),
        json!({ "name": "fs_read", "kind": "fs", "readOnly": true,
            "description": format!("Read a text file (first 64 KiB) on {place}. Shared folders: {shared}."),
            "inputSchema": { "type": "object", "properties": { "path": path }, "required": ["path"] } }),
        json!({ "name": "fs_write", "kind": "fs", "readOnly": false,
            "description": format!("Write a text file on {place} (at most 1 MiB). Shared folders: {shared}."),
            "inputSchema": { "type": "object", "properties": { "path": path, "content": { "type": "string" },
                "overwrite": { "type": "boolean", "description": "Replace an existing file" } }, "required": ["path", "content"] } }),
        json!({ "name": "shell_run", "kind": "shell", "readOnly": false,
            "description": format!("Run one shell command on {place} and return its output (first 64 KiB). The working folder must be inside a shared folder: {shared}. The sandbox may block network access; if a command fails for lack of network, say so instead of retrying."),
            "inputSchema": { "type": "object", "properties": { "command": { "type": "string" }, "cwd": path,
                "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 600 } }, "required": ["command"] } }),
    ]
}

/// The prompt's line about the sandbox, for an action that runs a shell command.
fn sandbox_state(action: &Action) -> Option<SandboxState> {
    match action {
        Action::Shell {
            sandbox,
            sandbox_note,
            ..
        } => Some(SandboxState {
            confined: sandbox.is_some(),
            note: sandbox_note.clone(),
        }),
        _ => None,
    }
}

fn plan(
    tool: &str,
    input: &Value,
    settings: &Settings,
    mcp_tools: &HashMap<String, McpToolRef>,
) -> Result<Action, String> {
    let roots = shareable_roots(&settings.roots);
    let shell = ShellSettings {
        allow_unsandboxed: settings.allow_unsandboxed_shell,
        allow_network: settings.allow_shell_network,
    };

    if let Some(planned) = plan_builtin(tool, input, &roots, shell) {
        return planned;
    }

    let McpToolRef {
        server,
        tool,
        read_only,
    } = mcp_tools
        .get(tool)
        .ok_or_else(|| format!("{tool} is not a tool of this device"))?;
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
        Outcome::of(decision, actions::Outcome::failed(error))
    }

    fn done(output: &str) -> Self {
        Outcome {
            decision: "rule",
            error: None,
            exit_code: None,
            output: Some(output.to_owned()),
            status: "completed",
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

    fn of(decision: &'static str, done: actions::Outcome) -> Self {
        Outcome {
            decision,
            error: done.error,
            exit_code: done.exit_code,
            output: done.output,
            status: done.status,
            truncated: done.truncated,
        }
    }
}

fn run_action(
    state: &DeviceState,
    action: Action,
    remaining: Duration,
    decision: &'static str,
) -> Outcome {
    let roots = shareable_roots(&state.settings().roots);

    Outcome::of(
        decision,
        actions::run(action, &roots, remaining, Some(&state.mcp)),
    )
}

/// What the page relays for one progress step: the call it is about and the
/// signed report (`{ v, kind: "progress", callId, deviceId, phase, issuedAt }`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub call_id: String,
    /// The device the report is for: this computer, or one of its servers.
    pub device_id: String,
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
        device_id: device_id.to_owned(),
        payload: signed.payload,
        signature: signed.signature,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub account_label: Option<String>,
    pub device_id: Option<String>,
    /// The servers this computer speaks for, and whether each is connected right now.
    pub hosts: Vec<hosts::HostStatus>,
    pub platform: &'static str,
}

/// The pairing, when its secret is usable. A pairing whose keychain entry could not be read loads with an empty secret;
/// an HMAC keyed with the empty string is public, so such a pairing must refuse every call and manifest until the
/// keychain answers on a later load.
fn usable_pairing(settings: &Settings) -> Result<Pairing, String> {
    let pairing = settings
        .pairing
        .clone()
        .ok_or("this computer is not paired")?;

    if pairing.secret.is_empty() {
        return Err("the pairing secret is unavailable: the keychain could not be read".into());
    }

    Ok(pairing)
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
    pub hosts: Vec<hosts::HostView>,
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
    /// One server's folders and shell policy.
    pub host: Option<HostUpdate>,
    pub mcp_servers: Option<Vec<McpServerConfig>>,
    pub require_shell_sandbox: Option<bool>,
    pub roots: Option<Vec<String>>,
    #[serde(default)]
    pub unpair: bool,
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

/// Whether two server names could produce the same tool name: a tool name is `mcp__<server>__<tool>` over the
/// sanitised names, so `a` and `a__x` (or `a` and `a_`) both reach `mcp__a__x__t` and could not be told apart.
fn names_overlap(a: &str, b: &str) -> bool {
    let (a, b) = (
        format!("{}__", mcp::sanitize(a)),
        format!("{}__", mcp::sanitize(b)),
    );

    a.starts_with(&b) || b.starts_with(&a)
}

pub fn validate_servers(servers: &[McpServerConfig]) -> Result<(), String> {
    if servers.len() > MAX_MCP_SERVERS {
        return Err(format!("at most {MAX_MCP_SERVERS} servers"));
    }

    for (index, server) in servers.iter().enumerate() {
        let name_ok = (1..=40).contains(&server.name.chars().count());

        if let Some(other) = servers[..index]
            .iter()
            .find(|other| names_overlap(&other.name, &server.name))
        {
            return Err(format!(
                "servers \"{}\" and \"{}\" would share tool names; rename one",
                other.name, server.name
            ));
        }

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
    use crate::actions::SHELL_MAX_TIMEOUT;

    #[test]
    fn a_pairing_whose_secret_is_unavailable_is_not_usable() {
        let unavailable = Settings {
            pairing: Some(Pairing {
                account_label: "me".into(),
                device_id: "dev1".into(),
                secret: String::new(),
            }),
            ..Default::default()
        };
        let usable = Settings {
            pairing: Some(Pairing {
                account_label: "me".into(),
                device_id: "dev1".into(),
                secret: "k".repeat(64),
            }),
            ..Default::default()
        };

        assert!(usable_pairing(&unavailable).is_err());
        assert!(usable_pairing(&usable).is_ok());
        assert!(usable_pairing(&Settings::default()).is_err());
    }

    #[test]
    fn a_disconnected_shared_folder_survives_an_unrelated_save() {
        let dir = std::env::temp_dir().join(format!("neore-device-roots-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("drive-not-mounted").to_string_lossy().into_owned();
        store::save(
            &dir.join("device.json"),
            &Settings {
                roots: vec![missing.clone()],
                ..Default::default()
            },
        )
        .unwrap();

        let state = DeviceState::new(&dir, Box::new(|_| {}));
        let unrelated: SettingsUpdate =
            serde_json::from_str(r#"{"allowShellNetwork":true}"#).unwrap();
        state.settings_update(unrelated).unwrap();

        assert_eq!(store::load(&dir.join("device.json")).roots, vec![missing]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changing_the_mcp_servers_forgets_the_cached_tool_metadata() {
        let dir =
            std::env::temp_dir().join(format!("neore-device-mcp-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                mcp_servers: vec![server("docs", "docs-mcp")],
                ..Settings::default()
            },
        )
        .unwrap();
        let state = DeviceState::new(&dir, Box::new(|_| {}));

        state.mcp_tools.lock().unwrap().insert(
            "docs__search".to_owned(),
            McpToolRef {
                server: "docs".to_owned(),
                tool: "search".to_owned(),
                read_only: true,
            },
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

    fn turn_secret() -> String {
        "0123456789abcdef".repeat(4)
    }

    fn paired_state(name: &str) -> (DeviceState, PathBuf, std::sync::Arc<Mutex<Vec<Event>>>) {
        let dir = std::env::temp_dir().join(format!("neore-device-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                pairing: Some(Pairing {
                    account_label: "me".into(),
                    device_id: "dev1".into(),
                    secret: turn_secret(),
                }),
                ..Default::default()
            },
        )
        .unwrap();

        let events = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = std::sync::Arc::clone(&events);
        let state = DeviceState::new(
            &dir,
            Box::new(move |event| seen.lock().unwrap().push(event)),
        );

        (state, dir, events)
    }

    #[test]
    fn signs_only_a_turn_post_for_this_device() {
        let (state, dir, _) = paired_state("sign-turn");
        let post = r#"{"v":1,"kind":"turn","deviceId":"dev1","events":[]}"#;

        assert_eq!(
            state.sign_turn(post).unwrap(),
            envelope::sign(&turn_secret(), Domain::Turn, post)
        );
        assert!(state
            .sign_turn(r#"{"v":1,"kind":"call","deviceId":"dev1"}"#)
            .is_err());
        assert!(state
            .sign_turn(r#"{"v":1,"kind":"turn","deviceId":"dev2"}"#)
            .is_err());
        assert!(state
            .sign_turn(r#"{"kind":"turn","deviceId":"dev1"}"#)
            .is_err());
        assert!(state.sign_turn("not json").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A nonce no two calls share, as a real caller's would be.
    fn fresh_nonce() -> String {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

        format!(
            "nonce-{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    }

    fn signed_call(tool: &str, input: Value, nonce: &str) -> Signed {
        envelope::sign_value(
            &turn_secret(),
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": "c1", "deviceId": "dev1", "tool": tool,
                "input": input, "threadId": "t1", "threadTitle": "T", "taintedBy": [],
                "issuedAt": 1, "expiresAt": now_ms() + 60_000, "nonce": nonce
            }),
        )
    }

    #[test]
    fn a_signed_cancel_is_handed_to_the_main_process_without_a_prompt() {
        let (state, dir, events) = paired_state("acp-cancel");
        let result = state
            .execute(&signed_call(
                "acp_cancel",
                json!({ "sessionId": "s1", "turnId": "u1" }),
                &fresh_nonce(),
            ))
            .unwrap();
        let result: Value = serde_json::from_str(&result.payload).unwrap();

        assert_eq!(result["status"], "completed");
        assert!(matches!(
            events.lock().unwrap().as_slice(),
            [Event::AcpCancel { session_id, turn_id }] if session_id == "s1" && turn_id == "u1"
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cancel_that_names_no_turn_is_refused_and_cancels_nothing() {
        let (state, dir, events) = paired_state("acp-cancel-bad");
        let result = state
            .execute(&signed_call(
                "acp_cancel",
                json!({ "sessionId": "s1" }),
                &fresh_nonce(),
            ))
            .unwrap();
        let result: Value = serde_json::from_str(&result.payload).unwrap();

        assert_eq!(result["status"], "failed");
        assert!(events.lock().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn server(name: &str, command: &str) -> McpServerConfig {
        McpServerConfig {
            args: Vec::new(),
            command: command.to_owned(),
            env: Default::default(),
            name: name.to_owned(),
        }
    }

    #[test]
    fn a_replaced_or_removed_mcp_server_loses_its_allow_rules() {
        let old = vec![server("git", "git-mcp"), server("docs", "docs-mcp")];
        let rules = || {
            vec![
                "fs_read".to_owned(),
                "mcp__git__status".to_owned(),
                "mcp__docs__search".to_owned(),
            ]
        };

        // Unchanged servers keep their rules.
        let mut kept = rules();
        drop_rules_of_changed_servers(&old, &old, &mut kept);
        assert_eq!(kept, rules());

        // Same name, different program: the rule goes, the other server's stays.
        let mut replaced = rules();
        let swapped = vec![server("git", "evil"), server("docs", "docs-mcp")];
        drop_rules_of_changed_servers(&old, &swapped, &mut replaced);
        assert_eq!(replaced, vec!["fs_read", "mcp__docs__search"]);

        // Removed outright.
        let mut removed = rules();
        drop_rules_of_changed_servers(&old, &old[1..], &mut removed);
        assert_eq!(removed, vec!["fs_read", "mcp__docs__search"]);
    }

    #[test]
    fn replacing_a_server_through_settings_update_drops_its_saved_rule() {
        let dir =
            std::env::temp_dir().join(format!("neore-device-mcp-rules-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                allow_rules: vec!["mcp__git__status".to_owned()],
                mcp_servers: vec![server("git", "git-mcp")],
                ..Default::default()
            },
        )
        .unwrap();

        let state = DeviceState::new(&dir, Box::new(|_| {}));
        let same: SettingsUpdate =
            serde_json::from_str(r#"{"mcpServers":[{"name":"git","command":"git-mcp"}]}"#).unwrap();
        assert_eq!(state.settings_update(same).unwrap().allow_rules.len(), 1);

        let swapped: SettingsUpdate =
            serde_json::from_str(r#"{"mcpServers":[{"name":"git","command":"evil"}]}"#).unwrap();
        assert!(state
            .settings_update(swapped)
            .unwrap()
            .allow_rules
            .is_empty());

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
        assert_eq!(event["deviceId"], "dev1");
        assert!(event["signature"].is_string());
    }

    #[test]
    fn offers_no_file_or_shell_tools_without_shared_folders() {
        assert!(builtin_tools(&[], "here").is_empty());
        assert_eq!(builtin_tools(&[std::env::temp_dir()], "here").len(), 4);
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

    /// The action vectors `neore-host` is checked with (`tests/host_stdio.rs`), through the whole engine: signed,
    /// approved by a person, run, signed again. This is the path the napi addon calls, so the host and the desktop
    /// give the same result for the same action.
    #[test]
    fn the_action_vectors_give_the_results_the_host_gives() {
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        use crate::vectors::{self, Observed};

        crate::store::test_keychain::install();

        let sandbox = vectors::sandbox();
        let root = vectors::fixture("engine");
        let dir = root.parent().unwrap().to_path_buf();
        let secret = "0123456789abcdef".repeat(4);

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
        let person = Arc::clone(&state);

        std::thread::spawn(move || {
            while let Ok(event) = received.recv_timeout(Duration::from_secs(60)) {
                if let Event::Prompt { prompt } = event {
                    person.prompt_answer(prompt.id, "once").unwrap();
                }
            }
        });

        for (index, vector) in vectors::vectors().iter().enumerate() {
            if !vector.applies(sandbox) {
                continue;
            }

            let signed = envelope::sign_value(
                &secret,
                Domain::Call,
                &json!({
                    "v": 1, "kind": "call", "callId": format!("c{index}"), "deviceId": "dev1", "tool": vector.tool,
                    "input": vector.input, "threadTitle": "T", "taintedBy": [],
                    "issuedAt": now_ms(), "expiresAt": now_ms() + 60_000, "nonce": format!("n{index}"),
                }),
            );
            let result: Value =
                serde_json::from_str(&state.execute(&signed).unwrap().payload).unwrap();

            vectors::assert_observed(
                vector,
                &root,
                &Observed {
                    error: result["error"].as_str().map(str::to_owned),
                    exit_code: result["exitCode"].as_i64(),
                    output: result["output"].as_str().map(str::to_owned),
                    status: result["status"].as_str().unwrap().to_owned(),
                },
            );
        }

        vectors::assert_nothing_escaped(&root);
        let _ = stdfs::remove_dir_all(&dir);
    }

    /// Approving must not run a call under folders the owner withdrew while the prompt was open.
    #[test]
    fn an_approval_is_refused_when_the_shared_folder_was_removed_while_asking() {
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        crate::store::test_keychain::install();

        let dir = std::env::temp_dir().join(format!("neore-device-revoke-{}", std::process::id()));
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
        let signed = envelope::sign_value(
            &secret,
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": "c1", "deviceId": "dev1", "tool": "fs_read",
                "input": { "path": "a.txt" }, "threadTitle": "T", "taintedBy": [],
                "issuedAt": now_ms(), "expiresAt": now_ms() + 60_000, "nonce": "n1",
            }),
        );
        let worker = {
            let state = Arc::clone(&state);

            std::thread::spawn(move || state.execute(&signed))
        };
        let prompt = loop {
            if let Event::Prompt { prompt } = received.recv().unwrap() {
                break prompt;
            }
        };

        state
            .settings_update(serde_json::from_str(r#"{"roots":[]}"#).unwrap())
            .unwrap();
        state.prompt_answer(prompt.id, "always").unwrap();

        let result = worker.join().unwrap().unwrap();
        let parsed: Value = serde_json::from_str(&result.payload).unwrap();

        assert_eq!(parsed["status"], "failed");
        assert!(parsed.get("output").is_none());
        assert!(state.settings().allow_rules.is_empty());

        let _ = stdfs::remove_dir_all(&dir);
    }

    /// A replaced server must not pick up the rule an answer to the OLD server was about to save.
    #[test]
    fn an_always_answer_is_not_saved_for_a_server_replaced_while_asking() {
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        crate::store::test_keychain::install();

        let dir = std::env::temp_dir().join(format!("neore-device-race-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();

        let secret = "0123456789abcdef".repeat(4);
        store::save(
            &dir.join("device.json"),
            &Settings {
                pairing: Some(Pairing {
                    account_label: "me".into(),
                    device_id: "dev1".into(),
                    secret: secret.clone(),
                }),
                mcp_servers: vec![server("git", "git-mcp")],
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
        state.mcp_tools.lock().unwrap().insert(
            "mcp__git__status".to_owned(),
            McpToolRef {
                server: "git".to_owned(),
                tool: "status".to_owned(),
                read_only: true,
            },
        );
        let signed = envelope::sign_value(
            &secret,
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": "c1", "deviceId": "dev1", "tool": "mcp__git__status",
                "input": {}, "threadTitle": "T", "taintedBy": [],
                "issuedAt": now_ms(), "expiresAt": now_ms() + 60_000, "nonce": "n1",
            }),
        );
        let worker = {
            let state = Arc::clone(&state);

            std::thread::spawn(move || state.execute(&signed))
        };
        let prompt = loop {
            if let Event::Prompt { prompt } = received.recv().unwrap() {
                break prompt;
            }
        };

        state
            .settings_update(
                serde_json::from_str(r#"{"mcpServers":[{"name":"git","command":"evil"}]}"#)
                    .unwrap(),
            )
            .unwrap();
        state.prompt_answer(prompt.id, "always").unwrap();

        let result = worker.join().unwrap().unwrap();
        let parsed: Value = serde_json::from_str(&result.payload).unwrap();

        assert_eq!(parsed["status"], "failed");
        assert!(state.settings().allow_rules.is_empty());

        let _ = stdfs::remove_dir_all(&dir);
    }

    /// Any settings change after a call was planned (a removed rule, a shell policy) is seen right before dispatch.
    #[test]
    fn a_settings_update_invalidates_the_generation_a_call_was_planned_under() {
        let dir = std::env::temp_dir().join(format!("neore-device-gen-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        let state = DeviceState::new(&dir, Box::new(|_| {}));
        let planned = state.generation.load(Ordering::SeqCst);

        assert!(state.settings_unchanged(planned));

        state
            .settings_update(serde_json::from_str(r#"{"allowShellNetwork":true}"#).unwrap())
            .unwrap();
        assert!(!state.settings_unchanged(planned));

        let planned = state.generation.load(Ordering::SeqCst);
        state
            .settings_update(serde_json::from_str(r#"{"allowRules":[]}"#).unwrap())
            .unwrap();
        assert!(!state.settings_unchanged(planned));

        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rejected_settings_update_leaves_waiting_calls_valid() {
        let dir = std::env::temp_dir().join(format!("neore-device-badgen-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        let state = DeviceState::new(&dir, Box::new(|_| {}));
        let planned = state.generation.load(Ordering::SeqCst);

        let invalid: SettingsUpdate =
            serde_json::from_str(r#"{"mcpServers":[{"name":"","command":"x"}]}"#).unwrap();

        assert!(state.settings_update(invalid).is_err());
        assert!(state.settings_unchanged(planned));

        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn changing_a_server_keeps_the_rules_of_an_unrelated_server() {
        let old = vec![server("a", "one"), server("ab", "two")];
        let new = vec![server("a", "changed"), server("ab", "two")];
        let mut rules = vec!["mcp__a__q".to_owned(), "mcp__ab__t".to_owned()];

        drop_rules_of_changed_servers(&old, &new, &mut rules);

        assert_eq!(rules, vec!["mcp__ab__t"]);
    }

    #[test]
    fn server_names_whose_tool_names_could_collide_are_refused() {
        for (a, b) in [
            ("my-server", "my_server"),
            ("a", "a__x"),
            ("a__x", "a"),
            ("a", "a_"),
        ] {
            assert!(
                validate_servers(&[server(a, "x"), server(b, "y")]).is_err(),
                "{a} {b}"
            );
        }

        assert!(
            validate_servers(&[server("a", "x"), server("ab", "y"), server("a_b", "z")]).is_ok()
        );
    }

    /// A paired device with one shared folder, a call to `tool` waiting in its prompt, and the way to answer it.
    fn open_prompt(
        name: &str,
        tool: &str,
        input: Value,
        settings: impl FnOnce(&mut Settings, &Path),
    ) -> (
        std::sync::Arc<DeviceState>,
        std::thread::JoinHandle<Result<Signed, String>>,
        u64,
        PathBuf,
    ) {
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        crate::store::test_keychain::install();

        let dir = std::env::temp_dir().join(format!("neore-device-{name}-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(dir.join("extra")).unwrap();
        stdfs::write(dir.join("a.txt"), "hello").unwrap();

        let secret = "0123456789abcdef".repeat(4);
        let root = dir.canonicalize().unwrap();
        let mut saved = Settings {
            pairing: Some(Pairing {
                account_label: "me".into(),
                device_id: "dev1".into(),
                secret: secret.clone(),
            }),
            roots: vec![root.to_string_lossy().into_owned()],
            ..Settings::default()
        };
        settings(&mut saved, &root);
        store::save(&dir.join("device.json"), &saved).unwrap();

        let (events, received) = channel();
        let state = Arc::new(DeviceState::new(
            &dir,
            Box::new(move |event| {
                let _ = events.send(event);
            }),
        ));
        let signed = envelope::sign_value(
            &secret,
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": "c1", "deviceId": "dev1", "tool": tool,
                "input": input, "threadTitle": "T", "taintedBy": [],
                "issuedAt": now_ms(), "expiresAt": now_ms() + 60_000, "nonce": "n1",
            }),
        );
        let worker = {
            let state = Arc::clone(&state);

            std::thread::spawn(move || state.execute(&signed))
        };
        let prompt = loop {
            if let Event::Prompt { prompt } = received.recv().unwrap() {
                break prompt;
            }
        };

        (state, worker, prompt.id, dir)
    }

    fn finish(
        state: &DeviceState,
        worker: std::thread::JoinHandle<Result<Signed, String>>,
        prompt: u64,
    ) -> Value {
        state.prompt_answer(prompt, "once").unwrap();

        serde_json::from_str(&worker.join().unwrap().unwrap().payload).unwrap()
    }

    #[test]
    fn an_unrelated_settings_change_while_asking_does_not_cancel_the_call() {
        let (state, worker, prompt, dir) = open_prompt(
            "unrelated",
            "fs_read",
            json!({ "path": "a.txt" }),
            |_, _| {},
        );
        let root = dir.canonicalize().unwrap();

        // Another folder is shared while the prompt is open.
        state
            .settings_update(
                serde_json::from_value(json!({ "roots": [root, root.join("extra")] })).unwrap(),
            )
            .unwrap();

        let parsed = finish(&state, worker, prompt);

        assert_eq!(parsed["status"], "completed");
        assert_eq!(parsed["output"], "hello");

        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn turning_the_shell_network_off_while_asking_refuses_the_call() {
        if matches!(sandbox::support(), sandbox::Support::Unavailable(_)) {
            return;
        }

        let (state, worker, prompt, dir) = open_prompt(
            "netoff",
            "shell_run",
            json!({ "command": "echo hi" }),
            |settings, _| settings.allow_shell_network = true,
        );

        state
            .settings_update(serde_json::from_str(r#"{"allowShellNetwork":false}"#).unwrap())
            .unwrap();

        let parsed = finish(&state, worker, prompt);

        assert_eq!(parsed["status"], "failed");
        assert!(parsed.get("output").is_none());

        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn a_removed_allow_rule_stops_a_call_that_skipped_its_prompt() {
        crate::store::test_keychain::install();
        let dir = std::env::temp_dir().join(format!("neore-device-rule-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        stdfs::write(dir.join("a.txt"), "hello").unwrap();
        let root = dir.canonicalize().unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                allow_rules: vec!["fs_read".to_owned()],
                pairing: Some(Pairing {
                    account_label: "me".into(),
                    device_id: "dev-rule".into(),
                    secret: "s".repeat(64),
                }),
                roots: vec![root.to_string_lossy().into_owned()],
                ..Settings::default()
            },
        )
        .unwrap();

        let state = DeviceState::new(&dir, Box::new(|_| {}));
        let input = json!({ "path": "a.txt" });
        let settings = state.settings();
        let action = plan("fs_read", &input, &settings, &HashMap::new()).unwrap();
        let (skip, _) = decide("fs_read", false, action.read_only(), &settings.allow_rules);
        let pairing = settings.pairing.clone().unwrap();
        let planned = state.generation.load(Ordering::SeqCst);

        assert!(skip);
        assert!(state.approval_holds(planned, ("fs_read", &input, false), &action, true, &pairing));

        state
            .settings_update(serde_json::from_str(r#"{"allowRules":[]}"#).unwrap())
            .unwrap();

        assert!(!state.approval_holds(
            planned,
            ("fs_read", &input, false),
            &action,
            true,
            &pairing
        ));
        // The same change does not matter to a call a person approved in a prompt.
        assert!(state.approval_holds(
            planned,
            ("fs_read", &input, false),
            &action,
            false,
            &pairing
        ));

        let _ = stdfs::remove_dir_all(&dir);
    }

    /// A call verified under one pairing must not run, nor save a rule, after the device was paired again.
    #[test]
    fn a_repair_of_the_same_device_cancels_calls_approved_before_it() {
        use std::sync::mpsc::channel;
        use std::sync::Arc;

        crate::store::test_keychain::install();

        let dir = std::env::temp_dir().join(format!("neore-device-repair-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        stdfs::write(dir.join("a.txt"), "hello").unwrap();
        let root = dir.canonicalize().unwrap();
        let old = Pairing {
            account_label: "me".into(),
            device_id: "dev-repair".into(),
            secret: "a".repeat(64),
        };
        store::save(
            &dir.join("device.json"),
            &Settings {
                allow_rules: vec!["fs_read".to_owned()],
                pairing: Some(old.clone()),
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
        let input = json!({ "path": "a.txt" });
        let settings = state.settings();
        let old = settings.pairing.clone().unwrap();
        let action = plan("fs_read", &input, &settings, &HashMap::new()).unwrap();
        let planned = state.generation.load(Ordering::SeqCst);

        assert!(state.approval_holds(planned, ("fs_read", &input, false), &action, true, &old));

        // The same device is paired again, with a new secret (the person confirms it in the window).
        let worker = {
            let state = Arc::clone(&state);

            std::thread::spawn(move || state.pair("dev-repair", &"b".repeat(64), "me"))
        };
        let prompt = loop {
            if let Event::Prompt { prompt } = received.recv().unwrap() {
                break prompt;
            }
        };
        state.prompt_answer(prompt.id, "once").unwrap();
        assert!(worker.join().unwrap().unwrap());

        // Prompted and rule-approved calls both stop, and the new pairing starts without rules.
        assert_ne!(state.generation.load(Ordering::SeqCst), planned);
        assert!(!state.approval_holds(planned, ("fs_read", &input, false), &action, false, &old));
        assert!(!state.approval_holds(planned, ("fs_read", &input, false), &action, true, &old));
        assert!(state.settings().allow_rules.is_empty());

        let _ = stdfs::remove_dir_all(&dir);
    }

    /// Adding a server must not cancel a pending call to another one: only the changed servers lose their tools.
    #[test]
    fn adding_a_server_keeps_a_pending_call_to_another_server_valid() {
        let dir = std::env::temp_dir().join(format!("neore-device-addsrv-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                mcp_servers: vec![server("x", "x-mcp")],
                ..Settings::default()
            },
        )
        .unwrap();

        let state = DeviceState::new(&dir, Box::new(|_| {}));
        state.mcp_tools.lock().unwrap().insert(
            "mcp__x__t".to_owned(),
            McpToolRef {
                server: "x".to_owned(),
                tool: "t".to_owned(),
                read_only: false,
            },
        );
        let input = json!({});
        let action = plan(
            "mcp__x__t",
            &input,
            &state.settings(),
            &state.mcp_tools.lock().unwrap(),
        )
        .unwrap();
        let planned = state.generation.load(Ordering::SeqCst);

        state
            .settings_update(
                serde_json::from_str(
                    r#"{"mcpServers":[{"name":"x","command":"x-mcp"},{"name":"y","command":"y-mcp"}]}"#,
                )
                .unwrap(),
            )
            .unwrap();

        assert_ne!(state.generation.load(Ordering::SeqCst), planned);
        assert!(state.mcp_tools.lock().unwrap().contains_key("mcp__x__t"));
        assert!(plan(
            "mcp__x__t",
            &input,
            &state.settings(),
            &state.mcp_tools.lock().unwrap()
        )
        .is_ok_and(|again| again == action));

        // Replacing x itself still refuses it.
        state
            .settings_update(
                serde_json::from_str(r#"{"mcpServers":[{"name":"x","command":"evil"}]}"#).unwrap(),
            )
            .unwrap();
        assert!(!state.mcp_tools.lock().unwrap().contains_key("mcp__x__t"));

        let _ = stdfs::remove_dir_all(&dir);
    }
}
