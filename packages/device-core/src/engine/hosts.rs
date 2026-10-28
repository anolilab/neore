//! The servers this computer reaches over SSH: pairing one, connecting it, signing its manifest and running its
//! calls. A server is a device of its own on the backend with a secret of its own, and only this computer holds
//! it, so the calls and the results are verified and signed HERE, with the server's secret; what goes down the pipe
//! is the already approved action (`host.rs` runs it).

use std::path::PathBuf;
use std::thread;

use super::reconnect::{Attempt, AttemptGuard, ConnectError, ReconnectView};
use super::*;
use crate::install::{self, Installed, Remote};
use crate::ssh::{
    Hello, HostConnection, HostKey, Interact, DOWNLOAD_IDLE, HOST_VERSION, MULTIPLEXING,
};

/// At most as many servers as the backend lets one account pair devices.
const MAX_HOSTS: usize = 10;
/// How long a page of a folder or a file may take.
const FILES_WAIT: Duration = Duration::from_secs(30);

/// What a page asks to connect to. Validated here: it is the only thing of the connection a page supplies. Agent
/// forwarding is not part of it: that is turned on for a paired server in the local window alone.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSpec {
    pub address: String,
    #[serde(default)]
    pub identity_file: Option<String>,
    pub name: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
}

fn default_port() -> u16 {
    22
}

impl HostSpec {
    fn target(&self) -> Result<Target, String> {
        let name = self.name.trim();

        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(
                "the server's name must be 1-80 characters without control characters".into(),
            );
        }

        let target = Target {
            address: self.address.clone(),
            forward_agent: false,
            identity_file: self.identity_file.clone(),
            port: self.port,
            user: self.user.clone(),
        };

        target.validate()?;

        Ok(target)
    }
}

/// What a connected server reported about itself.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProbe {
    pub platform: String,
    pub sandbox_available: bool,
    pub sandbox_detail: String,
    pub version: String,
}

impl HostProbe {
    fn of(hello: &Hello) -> Self {
        HostProbe {
            platform: hello.platform.clone(),
            sandbox_available: hello.sandbox.available,
            sandbox_detail: hello.sandbox.detail.clone(),
            version: hello.version.clone(),
        }
    }
}

/// What an install or upgrade of a server's host software did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUpgrade {
    /// The server already had this exact binary: nothing was uploaded.
    pub already_current: bool,
    pub version: String,
}

/// Marks a server as being installed or upgraded until dropped, so no session starts on it meanwhile.
struct UpgradeGuard<'a> {
    device_id: String,
    state: &'a DeviceState,
    target: Target,
}

impl Drop for UpgradeGuard<'_> {
    fn drop(&mut self) {
        self.state
            .ssh
            .upgrading
            .lock()
            .unwrap()
            .retain(|(id, target)| !(*id == self.device_id && *target == self.target));
    }
}

const INSTALLING: &str = "that server's host software is being installed; try again in a moment";

/// What the relay needs of a server: whether to beat for it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub connected: bool,
    pub device_id: String,
    pub name: String,
    /// Set while a server the person connected is being reconnected, or after it gave up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconnect: Option<ReconnectView>,
}

/// A server as the local window lists it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub address: String,
    pub allow_shell_network: bool,
    pub connected: bool,
    pub device_id: String,
    pub forward_agent: bool,
    pub identity_file: Option<String>,
    /// Whether Neore shares one connection between sessions to the server. It does not on Windows, where each
    /// server has an ssh process of its own.
    pub multiplexed: bool,
    pub name: String,
    pub platform: Option<String>,
    pub port: u16,
    pub reconnect: Option<ReconnectView>,
    pub require_shell_sandbox: bool,
    pub roots: Vec<String>,
    pub sandbox_detail: Option<String>,
    pub user: String,
}

/// One server's folders and shell policy, edited only in the local window.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUpdate {
    pub allow_shell_network: Option<bool>,
    pub device_id: String,
    /// Lets the server's session use this computer's SSH agent. Takes effect on the next connection.
    pub forward_agent: Option<bool>,
    pub require_shell_sandbox: Option<bool>,
    pub roots: Option<Vec<String>>,
}

/// Folders on a server are plain absolute paths: this computer cannot canonicalise them, and the server checks
/// every one against its own filesystem (the home guard included) each time it runs a call.
fn validate_host_roots(roots: &[String]) -> Result<Vec<String>, String> {
    if roots.len() > MAX_ROOTS {
        return Err(format!("at most {MAX_ROOTS} folders"));
    }

    let mut valid: Vec<String> = Vec::new();

    for root in roots {
        let trimmed = root.trim_end_matches('/');

        if !root.starts_with('/')
            || trimmed.is_empty()
            || root.len() > 1000
            || root.contains(['\0', '\n', '\r'])
        {
            return Err(format!("{root}: use an absolute folder path on the server"));
        }

        if !valid.iter().any(|seen| seen == trimmed) {
            valid.push(trimmed.to_owned());
        }
    }

    Ok(valid)
}

pub(super) fn apply_update(settings: &mut Settings, update: &HostUpdate) -> Result<(), String> {
    let roots = update
        .roots
        .as_deref()
        .map(validate_host_roots)
        .transpose()?;
    let host = settings
        .hosts
        .iter_mut()
        .find(|host| host.device_id == update.device_id)
        .ok_or("that server is not paired with this computer")?;

    if let Some(roots) = roots {
        host.roots = roots;
    }

    if let Some(required) = update.require_shell_sandbox {
        host.allow_unsandboxed_shell = !required;
    }

    if let Some(allowed) = update.allow_shell_network {
        host.allow_shell_network = allowed;
    }

    if let Some(forward) = update.forward_agent {
        host.forward_agent = forward;
    }

    Ok(())
}

/// The server a signed payload names, if it is one of ours. Only picks the secret to verify with: nothing in the
/// payload is trusted until that secret has verified it.
pub(super) fn host_named_by(settings: &Settings, payload: &str) -> Option<Host> {
    let named: Value = serde_json::from_str(payload).ok()?;
    let device_id = named.get("deviceId")?.as_str()?;

    settings
        .hosts
        .iter()
        .find(|host| host.device_id == device_id)
        .cloned()
}

/// Whether two targets reach the same account on the same server: the host software lives in that account's home,
/// whatever key or forwarding a session logs in with.
fn same_server(a: &Target, b: &Target) -> bool {
    a.address == b.address && a.user == b.user && a.port == b.port
}

fn holds(slot: &Option<(Target, Arc<dyn HostLink>)>, link: &Arc<dyn HostLink>) -> bool {
    slot.as_ref()
        .is_some_and(|(_, held)| std::ptr::addr_eq(Arc::as_ptr(held), Arc::as_ptr(link)))
}

/// An upgrade in the way ends by itself, so a connect refused for it is tried again, unlike a login nobody can fix.
fn upgrading(name: &str) -> ConnectError {
    ConnectError {
        message: format!("{name}'s host software is being upgraded; connect again in a moment"),
        retryable: true,
    }
}

pub(super) fn target_of(host: &Host) -> Target {
    Target {
        address: host.address.clone(),
        forward_agent: host.forward_agent,
        identity_file: host.identity_file.clone(),
        port: host.port,
        user: host.user.clone(),
    }
}

/// Asks the person at the local window what an SSH connection needs a person for.
struct AskUser {
    changed_prompts: Arc<Mutex<HashSet<String>>>,
    /// False for a reconnect in the background, which asks nobody anything: no trust prompt, no passphrase.
    interactive: bool,
    prompts: Arc<Prompts>,
    sink: SharedSink,
}

impl AskUser {
    fn expires_at() -> u64 {
        now_ms() + PAIRING_WAIT.as_millis() as u64
    }

    fn show(&self, prompt: &Prompt) {
        (self.sink)(Event::Prompt {
            prompt: prompt.clone(),
        });
    }
}

impl Interact for AskUser {
    fn trust_key(&self, target: &Target, key: &HostKey) -> bool {
        if !self.interactive {
            return false;
        }

        let body = PromptBody::HostKey {
            fingerprint: key.fingerprint(),
            host: target.address.clone(),
            identity_file: target.identity_file.clone(),
            key_type: key.label(),
            port: target.port,
        };

        matches!(
            self.prompts
                .ask(body, Self::expires_at(), PAIRING_WAIT, |prompt| self
                    .show(prompt)),
            Answer::Once | Answer::Always
        )
    }

    fn key_changed(&self, target: &Target, pinned: &[String], presented: &[String]) {
        // A background attempt gives up on a changed key and waits for a manual retry, which asks.
        if !self.interactive {
            return;
        }

        let spec = target.host_spec();

        // One notice per server: a page that keeps retrying a refused connection must not stack them.
        if !self.changed_prompts.lock().unwrap().insert(spec.clone()) {
            return;
        }

        let body = PromptBody::HostKeyChanged {
            host: target.address.clone(),
            pinned: pinned.to_vec(),
            port: target.port,
            presented: presented.to_vec(),
        };
        let ask = AskUser {
            changed_prompts: Arc::clone(&self.changed_prompts),
            interactive: true,
            prompts: Arc::clone(&self.prompts),
            sink: Arc::clone(&self.sink),
        };

        // Nothing is decided here, so the connection error does not wait for the window to be dismissed.
        thread::spawn(move || {
            ask.prompts
                .ask(body, Self::expires_at(), PAIRING_WAIT, |prompt| {
                    ask.show(prompt);
                });
            ask.changed_prompts.lock().unwrap().remove(&spec);
        });
    }

    fn passphrase(&self, target: &Target, prompt: &str) -> Option<String> {
        if !self.interactive {
            return None;
        }

        let body = PromptBody::Passphrase {
            host: format!("{}@{}", target.user, target.address),
            prompt: prompt.chars().take(300).collect(),
        };

        self.prompts
            .ask_secret(body, Self::expires_at(), PAIRING_WAIT, |queued| {
                self.show(queued)
            })
    }
}

/// What a call will do on the server, worded from its input alone: this computer has no view of the server's
/// filesystem, so the server does the real planning and checking. `None` for a tool a server does not have.
struct Described {
    detail: String,
    kind: &'static str,
}

fn describe_call(tool: &str, input: &Value, host: &str) -> Result<Described, String> {
    let text = |key: &str| input.get(key).and_then(Value::as_str);
    let path = || {
        text("path")
            .filter(|path| !path.is_empty())
            .ok_or_else(|| "path is required".to_owned())
    };

    Ok(match tool {
        "fs_list" => Described {
            detail: format!(
                "List the folder {} on {host}",
                text("path")
                    .filter(|path| !path.is_empty())
                    .unwrap_or("(the first shared folder)")
            ),
            kind: "fs",
        },
        "fs_read" => Described {
            detail: format!("Read the file {} on {host}", path()?),
            kind: "fs",
        },
        "fs_write" => {
            let content = text("content").ok_or("content is required")?;
            let overwrite = input.get("overwrite").and_then(Value::as_bool) == Some(true);

            Described {
                detail: format!(
                    "{} {} on {host} ({} bytes):\n{}",
                    if overwrite { "Overwrite" } else { "Create" },
                    path()?,
                    content.len(),
                    cap_utf8(content, 2000).0
                ),
                kind: "fs",
            }
        }
        "shell_run" => {
            let command = text("command")
                .map(str::trim)
                .filter(|command| !command.is_empty())
                .ok_or("command is required")?;

            if command.len() > 8000 {
                return Err("the command is too long".into());
            }

            Described {
                detail: format!(
                    "Run on {host} in {}:\n{command}",
                    text("cwd")
                        .map(str::trim)
                        .filter(|cwd| !cwd.is_empty())
                        .unwrap_or("the first shared folder"),
                ),
                kind: "shell",
            }
        }
        _ => return Err(format!("{tool} is not a tool of this server")),
    })
}

/// The prompt's line about the sandbox, from what the server reported (the desktop's own is no evidence) and
/// the server's setting.
fn host_sandbox(host: &Host, hello: &Hello) -> SandboxState {
    let (name, detail) = (&host.name, &hello.sandbox.detail);

    if hello.sandbox.available {
        return SandboxState {
            confined: true,
            note: format!("Runs in a sandbox on {name}: {detail}"),
        };
    }

    SandboxState {
        confined: false,
        note: if host.allow_unsandboxed_shell {
            format!("{name} has no sandbox ({detail}). You turned the requirement off, so this command runs with full access to that server.")
        } else {
            format!("{name} has no sandbox ({detail}), so this command will be refused.")
        },
    }
}

fn completed_or_failed(status: &str) -> &'static str {
    if status == "completed" {
        "completed"
    } else {
        "failed"
    }
}

impl DeviceState {
    pub(super) fn connection(&self, device_id: &str) -> Option<Arc<dyn HostLink>> {
        self.ssh.connections.lock().unwrap().get(device_id).cloned()
    }

    fn ask_user(&self) -> Arc<dyn Interact> {
        self.ask_user_as(true)
    }

    fn ask_user_as(&self, interactive: bool) -> Arc<dyn Interact> {
        Arc::new(AskUser {
            changed_prompts: Arc::clone(&self.ssh.changed_prompts),
            interactive,
            prompts: Arc::clone(&self.prompts),
            sink: Arc::clone(&self.sink),
        })
    }

    pub(super) fn host_statuses(&self) -> Vec<HostStatus> {
        self.settings()
            .hosts
            .iter()
            .map(|host| HostStatus {
                connected: self
                    .connection(&host.device_id)
                    .is_some_and(|link| link.is_alive()),
                device_id: host.device_id.clone(),
                name: host.name.clone(),
                reconnect: self.reconnect_view(&host.device_id),
            })
            .collect()
    }

    pub(super) fn host_views(&self, settings: &Settings) -> Vec<HostView> {
        settings
            .hosts
            .iter()
            .map(|host| {
                let link = self
                    .connection(&host.device_id)
                    .filter(|link| link.is_alive());

                HostView {
                    address: host.address.clone(),
                    allow_shell_network: host.allow_shell_network,
                    connected: link.is_some(),
                    device_id: host.device_id.clone(),
                    forward_agent: host.forward_agent,
                    identity_file: host.identity_file.clone(),
                    multiplexed: MULTIPLEXING,
                    name: host.name.clone(),
                    platform: link.as_ref().map(|link| link.hello().platform.clone()),
                    port: host.port,
                    reconnect: self.reconnect_view(&host.device_id),
                    require_shell_sandbox: !host.allow_unsandboxed_shell,
                    roots: host.roots.clone(),
                    sandbox_detail: link
                        .as_ref()
                        .map(|link| link.hello().sandbox.detail.clone()),
                    user: host.user.clone(),
                }
            })
            .collect()
    }

    /// Ends a session, and the server's master with it when no other session still rides it (a probe of the same
    /// server, a reconnect that already took its place). Not while host software is being installed there: the
    /// install runs over that same master, and exits it itself.
    pub(super) fn retire(&self, link: &Arc<dyn HostLink>) {
        link.close();
        self.forget_launch(link);
        self.release_master(link);
    }

    /// A session closed on purpose leaves its host finishing the commands in flight under their own timeouts; the
    /// next session must not reap it. Only a session the connection lost ([`Self::retire_lost`]) stays remembered.
    fn forget_launch(&self, link: &Arc<dyn HostLink>) {
        let Some(id) = link.launch_id() else { return };

        for known in self.ssh.launches.lock().unwrap().values_mut() {
            known.retain(|launch| launch != id);
        }
    }

    /// Ends a session that the connection dropped. Its master goes only when ssh gave the connection up (the
    /// network went away and the master may be wedged); a host that merely ended leaves a healthy master for the
    /// next session to share.
    pub(super) fn retire_lost(&self, link: &Arc<dyn HostLink>) {
        link.close();

        if link.master_suspect() {
            self.release_master(link);
        }
    }

    /// Ends `link`'s master unless another live session of the same server rides it.
    fn release_master(&self, link: &Arc<dyn HostLink>) {
        let Some(target) = link.target() else { return };
        let shared = self
            .ssh
            .connections
            .lock()
            .unwrap()
            .values()
            .cloned()
            .chain(
                self.ssh
                    .probe
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(_, other)| Arc::clone(other)),
            )
            .any(|other| {
                !std::ptr::addr_eq(Arc::as_ptr(&other), Arc::as_ptr(link))
                    && other.is_alive()
                    && other.target() == Some(target)
            });

        if !shared && !self.upgrade_running(target) {
            link.exit_master();
        }
    }

    /// Closes the connection of every server that is no longer one of ours.
    pub(super) fn drop_stale_connections(&self) {
        let settings = self.settings();
        let stale: Vec<Arc<dyn HostLink>> = {
            let mut connections = self.ssh.connections.lock().unwrap();
            let gone: Vec<String> = connections
                .keys()
                .filter(|id| !settings.hosts.iter().any(|host| host.device_id == **id))
                .cloned()
                .collect();

            gone.iter()
                .filter_map(|id| connections.remove(id))
                .collect()
        };

        for link in stale {
            self.retire(&link);
        }

        let settings = self.settings();

        self.ssh
            .keeps
            .lock()
            .unwrap()
            .retain(|id, _| settings.hosts.iter().any(|host| host.device_id == *id));
    }

    pub(super) fn close_probe(&self) {
        let probe = self.ssh.probe.lock().unwrap().take();

        if let Some((_, link)) = probe {
            self.retire(&link);
        }
    }

    pub(super) fn close_hosts(&self) {
        self.keep_forget_all();

        let links: Vec<Arc<dyn HostLink>> = self
            .ssh
            .connections
            .lock()
            .unwrap()
            .drain()
            .map(|(_, link)| link)
            .chain(self.ssh.probe.lock().unwrap().take().map(|(_, link)| link))
            .collect();

        for link in links {
            self.retire(&link);
        }
    }

    fn connect_target(
        &self,
        target: &Target,
        interactive: bool,
    ) -> Result<Arc<dyn HostLink>, ConnectError> {
        #[cfg(test)]
        if let Some(connector) = &self.ssh.connector {
            return connector(target);
        }

        let link: Arc<dyn HostLink> = Arc::new(HostConnection::connect_within(
            target,
            &self.ssh.paths,
            &self.ssh.binary,
            &self.ask_user_as(interactive),
            Self::attempt_patience(interactive),
        )?);

        Ok(link)
    }

    /// Whether host software is being installed on `target` right now.
    pub(super) fn upgrade_running(&self, target: &Target) -> bool {
        self.ssh
            .upgrading
            .lock()
            .unwrap()
            .iter()
            .any(|(_, upgrading)| same_server(upgrading, target))
    }

    /// Marks `target` as being installed on, or `None` when it already is. `id` names the mark.
    fn begin_upgrade(&self, id: &str, target: &Target) -> Option<UpgradeGuard<'_>> {
        let mut upgrading = self.ssh.upgrading.lock().unwrap();

        if upgrading
            .iter()
            .any(|(_, running)| same_server(running, target))
        {
            return None;
        }

        upgrading.push((id.to_owned(), target.clone()));

        Some(UpgradeGuard {
            device_id: id.to_owned(),
            state: self,
            target: target.clone(),
        })
    }

    /// Runs `commit` (which makes a session visible) unless host software is being installed on `target`, with the
    /// `upgrading` lock held across both. An upgrade marks the server before it looks for open sessions, so it
    /// sees either this session or this refusal, never neither.
    fn commit_unless_upgrading<T>(&self, target: &Target, commit: impl FnOnce() -> T) -> Option<T> {
        let upgrading = self.ssh.upgrading.lock().unwrap();

        if upgrading
            .iter()
            .any(|(_, running)| same_server(running, target))
        {
            return None;
        }

        let committed = commit();

        drop(upgrading);

        Some(committed)
    }

    /// Whether a live connection (not a probe) is open to `target`.
    fn connection_open(&self, target: &Target) -> bool {
        self.ssh.connections.lock().unwrap().values().any(|link| {
            link.is_alive()
                && link
                    .target()
                    .is_some_and(|other| same_server(other, target))
        })
    }

    /// Whether a session (a live connection or the probe, which a pairing in flight stays in) is open to `target`.
    fn session_open(&self, target: &Target) -> bool {
        self.connection_open(target)
            || self
                .ssh
                .probe
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|(_, link)| {
                    link.is_alive()
                        && link
                            .target()
                            .is_some_and(|other| same_server(other, target))
                })
    }

    fn probe_holds(&self, link: &Arc<dyn HostLink>) -> bool {
        holds(&self.ssh.probe.lock().unwrap(), link)
    }

    /// Takes `link` out of the probe slot, if it is still what the slot holds.
    fn leave_probe(&self, link: &Arc<dyn HostLink>) {
        let mut probe = self.ssh.probe.lock().unwrap();

        if holds(&probe, link) {
            *probe = None;
        }
    }

    /// Connects to a server that is not paired yet, so the page can register it (it needs the server's platform)
    /// and then call [`Self::host_pair`]. Nothing leaves this computer before the person at the local window
    /// approves the connection: a page alone must not scan hosts or log in anywhere. Then asks to trust the
    /// server's key on first use, and for a key passphrase.
    pub fn host_probe(&self, spec: &HostSpec) -> Result<HostProbe, String> {
        let target = spec.target()?;
        usable_pairing(&self.settings()).map_err(|_| "pair this computer first")?;

        let answer = self.prompts.ask(
            PromptBody::HostConnect {
                address: target.address.clone(),
                identity_file: target.identity_file.clone(),
                install_version: self.ssh.bundle.is_ok().then(|| HOST_VERSION.to_owned()),
                name: spec.name.trim().to_owned(),
                port: target.port,
                user: target.user.clone(),
            },
            now_ms() + PAIRING_WAIT.as_millis() as u64,
            PAIRING_WAIT,
            |prompt| {
                self.emit(Event::Prompt {
                    prompt: prompt.clone(),
                });
            },
        );

        if !matches!(answer, Answer::Once | Answer::Always) {
            return Err("the connection was not approved on this computer".into());
        }

        // The person agreed above to the connection, which includes putting the host software there if the pinned
        // version is not. Removing other versions is not part of it: that is `host_upgrade`, from the local window.
        if self.upgrade_running(&target) {
            return Err(INSTALLING.into());
        }

        if let Ok(bundle) = &self.ssh.bundle {
            let marked = self
                .begin_upgrade(&format!("probe:{}", target.host_spec()), &target)
                .ok_or(INSTALLING)?;

            // A session on the binary being replaced is the same hazard as in an upgrade.
            if self.connection_open(&target) {
                return Err(format!(
                    "{} has an open session. Disconnect it before installing its host software.",
                    spec.name.trim()
                ));
            }

            // An earlier probe of this server that was never paired is replaced by this one anyway; it must not
            // keep a session on the binary being replaced.
            let earlier = {
                let mut probe = self.ssh.probe.lock().unwrap();

                match probe.as_ref() {
                    Some((_, link))
                        if link
                            .target()
                            .is_some_and(|other| same_server(other, &target)) =>
                    {
                        probe.take()
                    }
                    _ => None,
                }
            };

            let earlier = earlier.map(|(_, link)| link);

            if let Some(link) = &earlier {
                self.retire(link);
            }

            let interact = self.ask_user();
            let remote = Remote {
                interact: &interact,
                paths: &self.ssh.paths,
                target: &target,
            };

            if let Err(error) = install::install(&remote, bundle, &self.ssh.root) {
                // The retired probe left its master up for the install; with the install over, nothing else holds it.
                if let Some(link) = &earlier {
                    link.exit_master();
                }

                return Err(error);
            }

            drop(marked);
        }

        let link = self.connect_target(&target, true)?;

        // Unpaired while the person was answering or the connection was opening: nothing may keep it.
        if usable_pairing(&self.settings()).is_err() {
            self.retire(&link);

            return Err("this computer was unpaired meanwhile".into());
        }

        let probe = HostProbe::of(link.hello());
        let committed = self.commit_unless_upgrading(&target, || {
            self.ssh
                .probe
                .lock()
                .unwrap()
                .replace((target.clone(), Arc::clone(&link)))
        });

        match committed {
            Some(replaced) => {
                if let Some((_, previous)) = replaced {
                    self.retire(&previous);
                }

                Ok(probe)
            }
            None => {
                self.retire(&link);

                Err(INSTALLING.into())
            }
        }
    }

    /// Stores a server as a device of its own once the user confirms it here. `secret` is the one the backend
    /// minted for it; it goes into the keychain and is never given to the server. `Ok(false)` when declined.
    pub fn host_pair(
        &self,
        spec: &HostSpec,
        device_id: &str,
        secret: &str,
    ) -> Result<bool, String> {
        let target = spec.target()?;
        let name = spec.name.trim().to_owned();

        if !valid_pairing(device_id, secret, "") {
            return Err("invalid pairing".into());
        }

        let desktop = usable_pairing(&self.settings())?;

        // The id is the server's own device: this computer's id would make a call for the server verify as one
        // for this computer.
        if device_id == desktop.device_id {
            return Err("that id is this computer's own".into());
        }

        // The link stays in the probe slot while the person decides, so an upgrade of this server still sees an
        // open session. A second probe replacing it ends it (see `host_probe`) and the pairing then fails.
        let link = match &*self.ssh.probe.lock().unwrap() {
            Some((probed, link)) if *probed == target => Arc::clone(link),
            _ => return Err("connect to the server first".into()),
        };

        // A forwarding change can end the master this probe rode: a dead link is no connection to pair.
        if !link.is_alive() {
            self.leave_probe(&link);
            self.retire(&link);

            return Err("the connection to the server dropped; connect to it again".into());
        }

        let answer = self.prompts.ask(
            PromptBody::HostPairing {
                address: target.address.clone(),
                identity_file: target.identity_file.clone(),
                name: name.clone(),
                port: target.port,
                user: target.user.clone(),
            },
            now_ms() + PAIRING_WAIT.as_millis() as u64,
            PAIRING_WAIT,
            |prompt| {
                self.emit(Event::Prompt {
                    prompt: prompt.clone(),
                });
            },
        );

        if !matches!(answer, Answer::Once | Answer::Always) {
            self.leave_probe(&link);
            self.retire(&link);

            return Ok(false);
        }

        // Another probe took the slot meanwhile and ended this link.
        if !self.probe_holds(&link) {
            return Err("the connection changed while waiting; connect to the server again".into());
        }

        let saved = self.change_settings_counted(true, |settings| {
            if settings.pairing.as_ref() != Some(&desktop) {
                return Err("the pairing changed while waiting".to_owned());
            }

            settings.hosts.retain(|host| host.device_id != device_id);

            if settings.hosts.len() >= MAX_HOSTS {
                return Err(format!("at most {MAX_HOSTS} servers"));
            }

            settings.hosts.push(Host {
                address: target.address.clone(),
                allow_shell_network: false,
                allow_unsandboxed_shell: false,
                device_id: device_id.to_owned(),
                forward_agent: target.forward_agent,
                identity_file: target.identity_file.clone(),
                name: name.clone(),
                port: target.port,
                roots: Vec::new(),
                secret: secret.to_owned(),
                user: target.user.clone(),
            });

            Ok(())
        });

        if let Err(error) = saved {
            self.leave_probe(&link);
            self.retire(&link);

            return Err(error);
        }

        // An upgrade can mark the server during the prompt and check connections before this insert and the probe
        // after the link left it. Then the server is paired but not connected: it waits for that upgrade, as
        // `host_connect` does. The two lock steps inside are sequential, never nested, like `session_open`'s.
        // A second probe can also have replaced this one since the check above, which ends the link. `probe_holds`
        // is read under the same `upgrading` lock the probe's replacement takes, so it is either still ours here or
        // already gone, and a closed link is never recorded for the new server.
        let committed = self
            .commit_unless_upgrading(&target, || {
                if !self.probe_holds(&link) {
                    return None;
                }

                let previous = self
                    .ssh
                    .connections
                    .lock()
                    .unwrap()
                    .insert(device_id.to_owned(), Arc::clone(&link));

                self.leave_probe(&link);

                Some(previous)
            })
            .flatten();

        match committed {
            Some(previous) => {
                if let Some(previous) = previous {
                    self.retire(&previous);
                }

                self.note_connected(device_id, &link, true);
            }
            None => {
                self.leave_probe(&link);
                self.retire(&link);
            }
        }

        self.emit(Event::Changed);

        Ok(true)
    }

    /// Connects a paired server (after a restart, or again once reconnecting gave up). From here on the server is
    /// kept connected until it is disconnected: a lost link is retried in the background. `retry` is the Retry of
    /// the local window and starts the attempts over; a page's connect counts as one more attempt of the window.
    pub fn host_connect(&self, device_id: &str, retry: bool) -> Result<HostProbe, String> {
        let Some(slot) = self.begin_attempt(device_id) else {
            return Err("that server is already connecting; wait a moment".into());
        };

        self.keep_manual(device_id, retry)?;

        let result = self.connect_host(device_id, Attempt::Manual, &slot);

        if let Err(error) = &result {
            self.keep_failed(device_id, error);
        }

        self.emit(Event::Changed);

        result.map_err(|error| error.message)
    }

    /// One connection attempt, holding the server's attempt `slot` (the person's or the keeper's: at most one per
    /// server). A manual attempt may ask for a passphrase and starts keeping the server; a background one runs
    /// silent, notices a disconnect that landed after it was scheduled, and never creates the keeping.
    pub(super) fn connect_host(
        &self,
        device_id: &str,
        attempt: Attempt,
        _slot: &AttemptGuard,
    ) -> Result<HostProbe, ConnectError> {
        let (interactive, disconnects) = match attempt {
            Attempt::Manual => (true, self.disconnects_of(device_id)),
            Attempt::Background { disconnects } => (false, disconnects),
        };
        let host = self
            .settings()
            .hosts
            .into_iter()
            .find(|host| host.device_id == device_id)
            .ok_or("that server is not paired with this computer")?;

        if let Some(link) = self.connection(device_id).filter(|link| link.is_alive()) {
            self.note_connected(device_id, &link, interactive);

            return Ok(HostProbe::of(link.hello()));
        }

        let target = target_of(&host);

        if self.upgrade_running(&target) {
            return Err(upgrading(&host.name));
        }

        let link = self.connect_target(&target, interactive)?;
        let probe = HostProbe::of(link.hello());

        // Disconnected while the connect was waiting: the user asked for that, and it stays asked. A disconnect
        // removes the keeping, so one still present means the count moved for a restart (a setting changed): the
        // link is dropped but the next try, with the new setting, is not.
        if self.disconnects_of(device_id) != disconnects {
            self.retire(&link);

            return Err(ConnectError {
                message: "that server was disconnected meanwhile".into(),
                retryable: self.ssh.keeps.lock().unwrap().contains_key(device_id),
            });
        }

        // Dropped from the settings while the user was typing a passphrase: nothing to keep. The same id paired
        // again with another server is no longer this link's server either.
        match self
            .settings()
            .hosts
            .iter()
            .find(|current| current.device_id == device_id)
        {
            None => {
                self.retire(&link);

                return Err("that server was removed meanwhile".into());
            }
            Some(current) if target_of(current) != target => {
                self.retire(&link);

                return Err(ConnectError {
                    message: "that server was changed meanwhile".into(),
                    retryable: true,
                });
            }
            Some(_) => {}
        }

        // An upgrade can begin while this was connecting (a passphrase prompt can take a while). It looks for open
        // sessions after it marks the server, so the last check and the insert are one step under that lock.
        let committed = self.commit_unless_upgrading(&target, || {
            self.ssh
                .connections
                .lock()
                .unwrap()
                .insert(device_id.to_owned(), Arc::clone(&link))
        });
        let Some(previous) = committed else {
            self.retire(&link);

            return Err(upgrading(&host.name));
        };

        if let Some(previous) = previous {
            self.retire(&previous);
        }

        // A disconnect between the check above and the insert removed the keeping: the link has no one to serve.
        // A manual connect creates the keeping, so a disconnect that landed since the count was read must not be
        // undone by it. The slot is ours, so a keeping present now is the one just made.
        if !self.note_connected(device_id, &link, interactive)
            || self.disconnects_of(device_id) != disconnects
        {
            self.keep_forget(device_id);
            self.drop_connection(device_id, &link);

            return Err("that server was disconnected meanwhile".into());
        }

        self.emit(Event::Changed);

        Ok(probe)
    }

    /// The `ssh` arguments of a shell on a paired server, after connecting it: that asks to trust its key on first
    /// use and for a key passphrase, in the local window, so an untrusted server gets no terminal. The shell rides
    /// the connection's master, so it ends with it.
    pub fn host_terminal(&self, device_id: &str) -> Result<Vec<String>, String> {
        let host = self.paired_host(device_id)?;

        self.host_connect(device_id, false)?;

        crate::ssh::terminal_args(&target_of(&host), &self.ssh.paths)
    }

    /// The same arguments, for a new shell on a connection that is still up. It never connects: restarting a
    /// shell must not bring a server back that the user disconnected, so a lost connection is the user's to make
    /// again, in the device window.
    pub fn host_terminal_attach(&self, device_id: &str) -> Result<Vec<String>, String> {
        let host = self.paired_host(device_id)?;

        crate::ssh::terminal_args(&target_of(&host), &self.ssh.paths)
            .map_err(|error| format!("{error}; connect it in the device window first"))
    }

    fn paired_host(&self, device_id: &str) -> Result<Host, String> {
        self.settings()
            .hosts
            .into_iter()
            .find(|host| host.device_id == device_id)
            .ok_or_else(|| "that server is not paired with this computer".to_owned())
    }

    /// Takes `link` out of the connections, if it is still what holds the server's place, and ends it.
    fn drop_connection(&self, device_id: &str, link: &Arc<dyn HostLink>) {
        let removed = {
            let mut connections = self.ssh.connections.lock().unwrap();

            if connections
                .get(device_id)
                .is_some_and(|current| std::ptr::addr_eq(Arc::as_ptr(current), Arc::as_ptr(link)))
            {
                connections.remove(device_id)
            } else {
                None
            }
        };

        if removed.is_some() {
            self.retire(link);
        }
    }

    pub fn host_disconnect(&self, device_id: &str) {
        self.note_disconnect(device_id);

        let kept = self.keep_forget(device_id);
        let link = self.ssh.connections.lock().unwrap().remove(device_id);

        if let Some(link) = &link {
            self.retire(link);
        }

        // Another window shows the server as reconnecting (or gave up) until it hears the keeping is gone.
        if kept || link.is_some() {
            self.emit(Event::Changed);
        }
    }

    /// Ends a server's connection and the master under it, even when another session still rides that master: for
    /// a change ssh only reads when the master starts.
    pub(super) fn host_restart(&self, device_id: &str) {
        // A connect still waiting (on a passphrase) was opened with the settings from before this change; it must not
        // be installed afterwards with, say, agent forwarding the owner has just turned off.
        self.note_disconnect(device_id);

        let link = self.ssh.connections.lock().unwrap().remove(device_id);

        if let Some(link) = link {
            link.close();
            self.forget_launch(&link);
            link.exit_master();
            self.emit(Event::Changed);
        }
    }

    /// Forgets a server here: its secret, its folders and, unless another server is at the same address, its
    /// pinned key stay on no disk of this computer. The backend row is the web's to revoke.
    pub fn host_remove(&self, device_id: &str) -> Result<(), String> {
        let removed = self
            .settings()
            .hosts
            .into_iter()
            .find(|host| host.device_id == device_id);

        self.change_settings_counted(true, |settings| {
            settings.hosts.retain(|host| host.device_id != device_id);

            Ok(())
        })?;
        self.drop_stale_connections();

        if let Some(removed) = removed {
            let spec = target_of(&removed).host_spec();

            // A key left behind would refuse the server once it is added again after a reinstall.
            if !self
                .settings()
                .hosts
                .iter()
                .any(|host| target_of(host).host_spec() == spec)
            {
                crate::ssh::forget_keys(&self.ssh.paths, &spec)
                    .map_err(|error| error.to_string())?;
            }
        }

        self.emit(Event::Changed);

        Ok(())
    }

    /// Drops the pinned key of a server so the next connection asks to trust whatever it presents. The only way
    /// back after a server's key legitimately changed.
    pub fn host_forget_key(&self, device_id: &str) -> Result<(), String> {
        let host = self
            .settings()
            .hosts
            .into_iter()
            .find(|host| host.device_id == device_id)
            .ok_or("that server is not paired with this computer")?;

        self.host_disconnect(device_id);

        crate::ssh::forget_keys(&self.ssh.paths, &target_of(&host).host_spec())
            .map_err(|error| error.to_string())
    }

    /// Installs (or reinstalls) the pinned `neore-host` on a paired server and removes its other versions. Local
    /// window only. Refused while any session is open to that server, this computer's or the probe's, and no
    /// session can start meanwhile. The old versions go only after the new binary answered its handshake.
    pub fn host_upgrade(&self, device_id: &str) -> Result<HostUpgrade, String> {
        let host = self
            .settings()
            .hosts
            .into_iter()
            .find(|host| host.device_id == device_id)
            .ok_or("that server is not paired with this computer")?;
        let bundle = self.ssh.bundle.as_ref().map_err(Clone::clone)?;
        let target = target_of(&host);
        let _guard = self
            .begin_upgrade(device_id, &target)
            .ok_or_else(|| format!("{} is already being upgraded", host.name))?;

        // Checked after the mark above, so a session that starts now sees the mark and yields.
        if self.session_open(&target) {
            return Err(format!(
                "{} has an open session. Disconnect it before upgrading its host software.",
                host.name
            ));
        }

        let interact = self.ask_user();
        let remote = Remote {
            interact: &interact,
            paths: &self.ssh.paths,
            target: &target,
        };
        let installed = install::install(&remote, bundle, &self.ssh.root)?;
        let link = HostConnection::connect(
            &target,
            &self.ssh.paths,
            &self.ssh.root.binary(HOST_VERSION),
            &interact,
        )?;
        let version = link.hello().version.clone();

        link.close();

        if version != HOST_VERSION {
            link.exit_master();

            return Err(format!(
                "the installed host reports version {version}, not {HOST_VERSION}; the old versions were kept"
            ));
        }

        // The master stays up for the prune, which would otherwise log in again (and ask for the key's passphrase again).
        let pruned = install::prune(&remote, &self.ssh.root);

        link.exit_master();
        pruned?;
        self.emit(Event::Changed);

        Ok(HostUpgrade {
            already_current: installed == Installed::Current,
            version,
        })
    }

    /// The server and its live connection, for what the local window asks of it directly.
    fn files_link(&self, device_id: &str) -> Result<(Host, Arc<dyn HostLink>), String> {
        let host = self
            .settings()
            .hosts
            .into_iter()
            .find(|host| host.device_id == device_id)
            .ok_or("that server is not paired with this computer")?;
        let link = self
            .connection(device_id)
            .filter(|link| link.is_alive())
            .ok_or_else(|| format!("this computer is not connected to {}", host.name))?;

        Ok((host, link))
    }

    /// One page of a folder on a connected server, for the file tree of the local window: `path` empty is its
    /// first shared folder, `after` the last name of the page before. Nothing is prompted, because the person at
    /// the window is the one asking, and it is not reachable from a page. The server keeps the paths inside the
    /// folders shared for it. What comes back is the server's word and is labelled with its name; the window shows
    /// it as text and an agent never sees it.
    pub fn host_files_list(
        &self,
        device_id: &str,
        path: &str,
        after: Option<&str>,
    ) -> Result<Value, String> {
        let (host, link) = self.files_link(device_id)?;
        let params = json!({ "after": after, "path": path, "roots": host.roots });
        let mut page = link.list_files(&params, FILES_WAIT)?;

        page["host"] = json!(host.name);

        Ok(page)
    }

    /// A file of a connected server as text (the first megabyte), by the same action an agent's `fs_read` runs.
    pub fn host_file_read(&self, device_id: &str, path: &str) -> Result<Value, String> {
        let (host, link) = self.files_link(device_id)?;
        let params = json!({
            "input": { "path": path },
            "remainingMs": FILES_WAIT.as_millis() as u64,
            "roots": host.roots,
            "tool": "fs_read",
        });
        let remote = link.run(&params, FILES_WAIT + Duration::from_secs(10))?;

        if remote.status != "completed" {
            return Err(remote
                .error
                .unwrap_or_else(|| "the file cannot be read".into()));
        }

        Ok(json!({
            "host": host.name,
            "path": path,
            "text": remote.output.unwrap_or_default(),
            "truncated": remote.truncated,
        }))
    }

    /// Downloads a folder of a connected server as one tar archive into `destination`, a path the person chose.
    /// The archive is written beside it and moved into place only when complete, and is never unpacked here: it is
    /// the server's content, and a symlink or a `..` in it would be the server's to plant. The server leaves
    /// symlinks and special files out.
    pub fn host_download(
        &self,
        device_id: &str,
        path: &str,
        destination: &Path,
    ) -> Result<Value, String> {
        let (host, link) = self.files_link(device_id)?;
        let name = destination
            .file_name()
            .filter(|_| destination.is_absolute())
            .ok_or("the destination is not a file path")?;
        let partial = destination.with_file_name({
            let mut partial = name.to_owned();

            partial.push(".part");
            partial
        });
        let file = stdfs::File::create(&partial).map_err(|error| error.to_string())?;
        let mut file = std::io::BufWriter::with_capacity(256 * 1024, file);
        let params = json!({ "path": path, "roots": host.roots });
        let result = link
            .download(&params, &mut file, DOWNLOAD_IDLE)
            .and_then(|summary| {
                file.into_inner()
                    .map_err(|error| error.to_string())?
                    .sync_all()
                    .and_then(|()| stdfs::rename(&partial, destination))
                    .map_err(|error| error.to_string())?;

                Ok(summary)
            });

        if result.is_err() {
            let _ = stdfs::remove_file(&partial);
        }

        self.audit(json!({
            "at": now_ms(), "host": host.name, "path": path, "tool": "files_download",
            "status": if result.is_ok() { "completed" } else { "failed" },
        }));

        result.map(|mut summary| {
            summary["host"] = json!(host.name);

            summary
        })
    }

    /// A server's signed tool list: its built-in tools over ITS folders, worded for it, signed with its secret.
    /// Only while connected, so the backend never offers a server this computer cannot reach.
    pub(super) fn host_manifest(
        &self,
        settings: &Settings,
        device_id: &str,
    ) -> Result<Signed, String> {
        let host = settings
            .hosts
            .iter()
            .find(|host| host.device_id == device_id)
            .ok_or("that server is not paired with this computer")?;

        if host.secret.is_empty() {
            return Err(
                "the server's secret is unavailable: the keychain could not be read".into(),
            );
        }

        if !self
            .connection(device_id)
            .is_some_and(|link| link.is_alive())
        {
            return Err("this computer is not connected to that server".into());
        }

        let roots: Vec<PathBuf> = host.roots.iter().map(PathBuf::from).collect();
        let tools = builtin_tools(&roots, &format!("the server \"{}\"", host.name));

        Ok(envelope::sign_value(
            &host.secret,
            Domain::Manifest,
            &json!({ "v": 1, "kind": "manifest", "deviceId": host.device_id, "issuedAt": self.next_manifest_time(), "tools": tools }),
        ))
    }

    /// Verifies, asks about, runs on the server and signs one call for it. The approval is the same local one a
    /// call for this computer gets, naming the server; "Always allow" is not offered for a server yet.
    pub(super) fn execute_host(&self, host: Host, signed: &Signed) -> Result<Signed, String> {
        if host.secret.is_empty() {
            return Err(
                "the server's secret is unavailable: the keychain could not be read".into(),
            );
        }

        let call = envelope::verify_call(
            &host.secret,
            &host.device_id,
            signed,
            now_ms(),
            &mut self.nonces.lock().unwrap(),
        )?;
        let link = self
            .connection(&host.device_id)
            .filter(|link| link.is_alive());
        let mut detail = String::new();
        let outcome = match (describe_call(&call.tool, &call.input, &host.name), link) {
            (Err(error), _) => Outcome::failed("denied", error),
            (Ok(_), None) => Outcome::failed(
                "denied",
                format!("this computer is not connected to {}", host.name),
            ),
            (Ok(described), Some(link)) => {
                detail.clone_from(&described.detail);

                let wait = Duration::from_millis(call.expires_at.saturating_sub(now_ms()));
                let answer = self.prompts.ask(
                    PromptBody::Call {
                        allow_always: false,
                        detail: described.detail,
                        host: Some(host.name.clone()),
                        input: serde_json::to_string_pretty(&call.input).unwrap_or_default(),
                        sandbox: (described.kind == "shell")
                            .then(|| host_sandbox(&host, link.hello())),
                        tainted_by: call.tainted_by.clone(),
                        thread_title: call.thread_title.clone(),
                        tool: call.tool.clone(),
                        tool_kind: described.kind.to_owned(),
                    },
                    call.expires_at,
                    wait,
                    |prompt| {
                        self.emit_progress(
                            &host.secret,
                            &host.device_id,
                            &call.call_id,
                            "prompting",
                        );
                        self.emit(Event::Prompt {
                            prompt: prompt.clone(),
                        });
                    },
                );

                match answer {
                    Answer::Deny => Outcome::denied("denied"),
                    Answer::Timeout => Outcome::denied("timeout"),
                    Answer::Once | Answer::Always => {
                        let remaining = call.expires_at.saturating_sub(now_ms());

                        if !self.host_approval_holds(&host, &link) {
                            Outcome::failed(
                                "once",
                                "the server's settings or connection changed while waiting",
                            )
                        } else if remaining == 0 {
                            Outcome::failed("once", "approved after the request expired")
                        } else {
                            self.emit_progress(
                                &host.secret,
                                &host.device_id,
                                &call.call_id,
                                "running",
                            );
                            run_on_host(&host, link.as_ref(), &call, remaining)
                        }
                    }
                }
            }
        };

        Ok(self.signed_result(
            (&host.secret, &host.device_id, Some(&host.name)),
            &call,
            &detail,
            outcome,
        ))
    }

    /// Whether the approval still covers the server: nothing about it changed while the prompt was open, and the
    /// connection is the one the prompt described.
    fn host_approval_holds(&self, host: &Host, link: &Arc<dyn HostLink>) -> bool {
        let _guard = self.save_lock.lock().unwrap();

        self.settings().hosts.iter().any(|current| current == host)
            && self.connection(&host.device_id).is_some_and(|current| {
                std::ptr::addr_eq(Arc::as_ptr(&current), Arc::as_ptr(link)) && current.is_alive()
            })
    }
}

fn run_on_host(
    host: &Host,
    link: &dyn HostLink,
    call: &envelope::CallEnvelope,
    remaining_ms: u64,
) -> Outcome {
    let params = json!({
        "allowShellNetwork": host.allow_shell_network,
        "allowUnsandboxedShell": host.allow_unsandboxed_shell,
        "input": call.input,
        "remainingMs": remaining_ms,
        "roots": host.roots,
        "tool": call.tool,
    });
    // The server stops its own command at the deadline; this only waits a little longer for it to say so.
    let wait = Duration::from_millis(remaining_ms) + Duration::from_secs(10);

    match link.run(&params, wait) {
        Ok(remote) => Outcome::of(
            "once",
            actions::Outcome {
                error: remote.error,
                exit_code: remote.exit_code,
                output: remote.output,
                status: completed_or_failed(&remote.status),
                truncated: remote.truncated,
            },
        ),
        Err(error) => Outcome::failed("once", error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::Phase;
    use crate::ssh::{RemoteOutcome, RemoteSandbox};
    use crate::store::test_keychain;
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::sync::Barrier;
    use std::time::Instant;

    const DESKTOP_SECRET: &str = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";
    const HOST_SECRET: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";

    /// A server that answers from a script and records what it was asked.
    struct FakeLink {
        alive: AtomicBool,
        hello: Hello,
        outcome: Mutex<Result<RemoteOutcome, String>>,
        runs: Mutex<Vec<Value>>,
        closed: AtomicUsize,
        master_exits: AtomicUsize,
        launch: Option<String>,
        /// The launches the engine asked this session to stop, one list per request.
        reaped: Mutex<Vec<Vec<String>>>,
        /// What `master_suspect` answers.
        suspect: AtomicBool,
        /// What `list_files` answers, and what it was asked.
        listing: Mutex<Result<Value, String>>,
        listed: Mutex<Vec<Value>>,
        /// What `download` writes, or why it fails after writing `partial`.
        archive: Mutex<Result<Vec<u8>, String>>,
        /// Makes the first `hello()` rendezvous twice with the test, which acts in between.
        gate: Mutex<Option<Arc<Barrier>>>,
        target: Option<Target>,
    }

    impl FakeLink {
        fn new(sandbox: bool) -> Arc<FakeLink> {
            Self::launched(sandbox, None)
        }

        /// A session that started `neore-host` under the launch id `launch`.
        fn launched(sandbox: bool, launch: Option<&str>) -> Arc<FakeLink> {
            Arc::new(FakeLink {
                alive: AtomicBool::new(true),
                archive: Mutex::new(Ok(b"TAR".to_vec())),
                listed: Mutex::default(),
                listing: Mutex::new(Ok(json!({ "entries": [], "next": null }))),
                closed: AtomicUsize::new(0),
                gate: Mutex::default(),
                launch: launch.map(str::to_owned),
                master_exits: AtomicUsize::new(0),
                reaped: Mutex::default(),
                suspect: AtomicBool::new(false),
                target: Some(target_of(&server("host-1"))),
                hello: Hello {
                    platform: "linux".into(),
                    protocol: 1,
                    sandbox: RemoteSandbox {
                        available: sandbox,
                        detail: "Landlock".into(),
                    },
                    version: "0.1.0".into(),
                },
                outcome: Mutex::new(Ok(RemoteOutcome {
                    error: None,
                    exit_code: None,
                    output: Some("from the server".into()),
                    status: "completed".into(),
                    truncated: false,
                })),
                runs: Mutex::default(),
            })
        }
    }

    impl HostLink for FakeLink {
        fn close(&self) {
            self.closed.fetch_add(1, Ordering::SeqCst);
            self.alive.store(false, Ordering::SeqCst);
        }

        fn exit_master(&self) {
            self.master_exits.fetch_add(1, Ordering::SeqCst);
        }

        fn launch_id(&self) -> Option<&str> {
            self.launch.as_deref()
        }

        fn master_suspect(&self) -> bool {
            self.suspect.load(Ordering::SeqCst)
        }

        fn reap(&self, ids: &[String]) -> Result<crate::launch::Reaped, String> {
            self.reaped.lock().unwrap().push(ids.to_vec());

            Ok(crate::launch::Reaped {
                stopped: ids.to_vec(),
                ..Default::default()
            })
        }

        fn hello(&self) -> &Hello {
            let gate = self.gate.lock().unwrap().take();

            if let Some(gate) = gate {
                gate.wait();
                gate.wait();
            }

            &self.hello
        }

        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }

        fn target(&self) -> Option<&Target> {
            self.target.as_ref()
        }

        fn run(&self, params: &Value, _wait: Duration) -> Result<RemoteOutcome, String> {
            self.runs.lock().unwrap().push(params.clone());
            self.outcome.lock().unwrap().clone()
        }

        fn list_files(&self, params: &Value, _wait: Duration) -> Result<Value, String> {
            self.listed.lock().unwrap().push(params.clone());
            self.listing.lock().unwrap().clone()
        }

        fn download(
            &self,
            params: &Value,
            out: &mut dyn Write,
            _idle: Duration,
        ) -> Result<Value, String> {
            self.listed.lock().unwrap().push(params.clone());

            match self.archive.lock().unwrap().clone() {
                Ok(bytes) => {
                    out.write_all(&bytes).map_err(|error| error.to_string())?;

                    Ok(json!({ "files": 1 }))
                }
                Err(error) => {
                    out.write_all(b"HALF").map_err(|error| error.to_string())?;

                    Err(error)
                }
            }
        }
    }

    fn server(device_id: &str) -> Host {
        Host {
            address: "build.example.com".into(),
            allow_shell_network: false,
            allow_unsandboxed_shell: false,
            device_id: device_id.into(),
            forward_agent: false,
            identity_file: None,
            name: "build-box".into(),
            port: 22,
            roots: vec!["/srv/app".into()],
            secret: HOST_SECRET.into(),
            user: "deploy".into(),
        }
    }

    // The keychain stand-in is shared by every test of the process and a test's ids name its entries, so each test
    // gets ids of its own: one test forgetting its server's secret must not take another's.
    fn host_id(test: &str) -> String {
        format!("hs-{test}-host")
    }

    fn desk_id(test: &str) -> String {
        format!("hs-{test}-desk")
    }

    fn other_id(test: &str) -> String {
        format!("hs-{test}-other")
    }

    /// A paired desktop and its server, with the server connected over `link`. Their ids are `desk_id(name)` and
    /// `host_id(name)`.
    fn engine(name: &str, link: &Arc<FakeLink>) -> (DeviceState, PathBuf, Arc<Mutex<Vec<Event>>>) {
        test_keychain::install();

        let dir = std::env::temp_dir().join(format!("neore-hosts-{name}-{}", std::process::id()));
        let _ = stdfs::remove_dir_all(&dir);
        stdfs::create_dir_all(&dir).unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                hosts: vec![server(&host_id(name))],
                pairing: Some(Pairing {
                    account_label: "me".into(),
                    device_id: desk_id(name),
                    secret: DESKTOP_SECRET.into(),
                }),
                ..Settings::default()
            },
        )
        .unwrap();

        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        let state = DeviceState::new(
            &dir,
            Box::new(move |event| seen.lock().unwrap().push(event)),
        );
        let link: Arc<dyn HostLink> = Arc::clone(link) as Arc<dyn HostLink>;

        state
            .ssh
            .connections
            .lock()
            .unwrap()
            .insert(host_id(name), link);

        (state, dir, events)
    }

    /// Answers every prompt the way the person at the window would, and keeps what it saw.
    fn answering(state: &Arc<DeviceState>, answer: &'static str) -> Arc<Mutex<Vec<Prompt>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (state, record) = (Arc::clone(state), Arc::clone(&seen));

        thread::spawn(move || loop {
            if let Some(prompt) = state.prompt_current() {
                record.lock().unwrap().push(prompt.clone());
                let _ = state.prompt_answer(prompt.id, answer);
            }

            thread::sleep(Duration::from_millis(5));
        });

        seen
    }

    fn call_for(
        secret: &str,
        device_id: &str,
        tool: &str,
        input: Value,
        tainted: &[&str],
    ) -> Signed {
        envelope::sign_value(
            secret,
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": format!("call-{tool}-{}", now_ms()), "deviceId": device_id,
                "expiresAt": now_ms() + 60_000, "issuedAt": now_ms(), "nonce": format!("{:?}", std::time::Instant::now()),
                "input": input, "taintedBy": tainted, "threadTitle": "Deploy", "tool": tool,
            }),
        )
    }

    fn result_of(signed: &Signed) -> Value {
        serde_json::from_str(&signed.payload).unwrap()
    }

    #[test]
    fn a_servers_call_runs_there_and_the_result_is_signed_with_the_servers_secret() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("run", &link);
        let state = Arc::new(state);
        let prompts = answering(&state, "once");
        let call = call_for(
            HOST_SECRET,
            host_id("run").as_str(),
            "shell_run",
            json!({ "command": "make test", "cwd": "/srv/app" }),
            &[],
        );
        let signed = state.execute(&call).unwrap();
        let result = result_of(&signed);

        assert_eq!(result["status"], "completed");
        assert_eq!(result["output"], "from the server");
        assert_eq!(result["deviceId"], host_id("run").as_str());
        // Only the server's own secret signs it: this computer's pairing secret cannot, so a computer that does
        // not hold the server's secret has no way to produce a result the backend would accept.
        assert!(envelope::verify(
            HOST_SECRET,
            Domain::Result,
            &signed.payload,
            &signed.signature
        ));
        assert!(!envelope::verify(
            DESKTOP_SECRET,
            Domain::Result,
            &signed.payload,
            &signed.signature
        ));

        // What went down the pipe: the call's own input with the SERVER's folders and policy, nothing local.
        let runs = link.runs.lock().unwrap();

        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["tool"], "shell_run");
        assert_eq!(runs[0]["roots"], json!(["/srv/app"]));
        assert_eq!(runs[0]["input"]["command"], "make test");
        assert_eq!(runs[0]["allowUnsandboxedShell"], false);
        assert_eq!(runs[0]["allowShellNetwork"], false);

        // The prompt named the server, was a shell prompt with the server's sandbox, and offered no "Always".
        let prompts = prompts.lock().unwrap();
        let PromptBody::Call {
            allow_always,
            detail,
            host,
            sandbox,
            ..
        } = &prompts[0].body
        else {
            panic!("expected a call prompt");
        };

        assert_eq!(host.as_deref(), Some("build-box"));
        assert!(!allow_always);
        assert!(detail.contains("build-box") && detail.contains("make test"));
        assert!(sandbox.as_ref().unwrap().confined);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_call_signed_with_another_secret_is_refused_whichever_device_it_names() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("secret", &link);

        // The desktop's secret naming the server, and the server's secret naming the desktop: neither verifies.
        let forged = call_for(
            DESKTOP_SECRET,
            host_id("secret").as_str(),
            "fs_list",
            json!({}),
            &[],
        );
        let swapped = call_for(
            HOST_SECRET,
            desk_id("secret").as_str(),
            "fs_list",
            json!({}),
            &[],
        );

        assert!(state.execute(&forged).is_err());
        assert!(state.execute(&swapped).is_err());
        assert!(link.runs.lock().unwrap().is_empty());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_denied_call_never_reaches_the_server() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("deny", &link);
        let state = Arc::new(state);

        answering(&state, "deny");

        let result = result_of(
            &state
                .execute(&call_for(
                    HOST_SECRET,
                    host_id("deny").as_str(),
                    "fs_read",
                    json!({ "path": "/srv/app/a" }),
                    &[],
                ))
                .unwrap(),
        );

        assert_eq!(result["status"], "denied");
        assert!(link.runs.lock().unwrap().is_empty());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_call_after_untrusted_content_still_asks_and_says_so() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("taint", &link);
        let state = Arc::new(state);
        let prompts = answering(&state, "once");

        // A read-only tool: on this computer a rule could skip the prompt; a tainted call never.
        state
            .execute(&call_for(
                HOST_SECRET,
                host_id("taint").as_str(),
                "fs_read",
                json!({ "path": "/srv/app/a" }),
                &["device"],
            ))
            .unwrap();

        let prompts = prompts.lock().unwrap();
        let PromptBody::Call { tainted_by, .. } = &prompts[0].body else {
            panic!("expected a call prompt");
        };

        assert_eq!(tainted_by, &["device"]);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_server_that_is_not_connected_fails_the_call_in_its_name_without_asking() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("offline", &link);

        link.close();

        let signed = state
            .execute(&call_for(
                HOST_SECRET,
                host_id("offline").as_str(),
                "fs_list",
                json!({}),
                &[],
            ))
            .unwrap();
        let result = result_of(&signed);

        assert_eq!(result["status"], "failed");
        assert!(result["error"].as_str().unwrap().contains("not connected"));
        assert!(state.prompt_current().is_none());
        assert!(envelope::verify(
            HOST_SECRET,
            Domain::Result,
            &signed.payload,
            &signed.signature
        ));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_server_without_a_sandbox_is_said_to_refuse_the_command_in_the_prompt() {
        let link = FakeLink::new(false);
        let (state, dir, _) = engine("nosandbox", &link);
        let state = Arc::new(state);
        let prompts = answering(&state, "deny");

        state
            .execute(&call_for(
                HOST_SECRET,
                host_id("nosandbox").as_str(),
                "shell_run",
                json!({ "command": "ls" }),
                &[],
            ))
            .unwrap();

        let prompts = prompts.lock().unwrap();
        let PromptBody::Call { sandbox, .. } = &prompts[0].body else {
            panic!("expected a call prompt");
        };
        let sandbox = sandbox.as_ref().unwrap();

        assert!(!sandbox.confined && sandbox.note.contains("will be refused"));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_tool_a_server_does_not_have_is_refused_before_asking() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("unknown", &link);
        let result = result_of(
            &state
                .execute(&call_for(
                    HOST_SECRET,
                    host_id("unknown").as_str(),
                    "mcp__x__y",
                    json!({}),
                    &[],
                ))
                .unwrap(),
        );

        assert_eq!(result["status"], "failed");
        assert!(state.prompt_current().is_none());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_servers_manifest_is_signed_with_its_own_secret_over_its_own_folders() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("manifest", &link);
        let signed = state
            .manifest_for(Some(host_id("manifest").as_str()))
            .unwrap();
        let manifest: Value = serde_json::from_str(&signed.payload).unwrap();

        assert!(envelope::verify(
            HOST_SECRET,
            Domain::Manifest,
            &signed.payload,
            &signed.signature
        ));
        assert!(!envelope::verify(
            DESKTOP_SECRET,
            Domain::Manifest,
            &signed.payload,
            &signed.signature
        ));
        assert_eq!(manifest["deviceId"], host_id("manifest").as_str());

        let tools = manifest["tools"].as_array().unwrap();

        assert_eq!(tools.len(), 4);
        assert!(tools[0]["description"]
            .as_str()
            .unwrap()
            .contains("build-box"));
        assert!(tools[0]["description"]
            .as_str()
            .unwrap()
            .contains("/srv/app"));

        // The desktop's own manifest stays the desktop's: no shared folders, so no tools, signed with its secret.
        let own = state.manifest_for(None).unwrap();

        assert!(envelope::verify(
            DESKTOP_SECRET,
            Domain::Manifest,
            &own.payload,
            &own.signature
        ));

        // Issued times only go up, across devices, so the backend never sees one go back.
        let again: Value = serde_json::from_str(
            &state
                .manifest_for(Some(host_id("manifest").as_str()))
                .unwrap()
                .payload,
        )
        .unwrap();

        assert!(again["issuedAt"].as_u64() > manifest["issuedAt"].as_u64());

        link.close();
        assert!(state
            .manifest_for(Some(host_id("manifest").as_str()))
            .is_err());
        assert!(state.manifest_for(Some("not-ours")).is_err());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_servers_folders_are_absolute_paths_on_the_server_and_nothing_else() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("roots", &link);
        let update = |roots: &[&str]| -> SettingsUpdate {
            serde_json::from_value(
                json!({ "host": { "deviceId": host_id("roots").as_str(), "roots": roots } }),
            )
            .unwrap()
        };

        assert!(state.settings_update(update(&["relative"])).is_err());
        assert!(state.settings_update(update(&["/"])).is_err());
        assert!(state.settings_update(update(&[])).is_ok());

        let view = state
            .settings_update(update(&["/srv/app/", "/srv/app", "/data"]))
            .unwrap();

        assert_eq!(view.hosts[0].roots, ["/srv/app", "/data"]);
        // Persisted, and the server's folders did not touch this computer's own.
        assert_eq!(
            store::load(&dir.join("device.json")).hosts[0].roots,
            ["/srv/app", "/data"]
        );
        assert!(view.roots.is_empty());

        let policy: SettingsUpdate =
            serde_json::from_value(json!({ "host": { "deviceId": host_id("roots").as_str(), "requireShellSandbox": false, "allowShellNetwork": true } })).unwrap();
        let view = state.settings_update(policy).unwrap();

        assert!(!view.hosts[0].require_shell_sandbox && view.hosts[0].allow_shell_network);
        assert!(state
            .settings_update(
                serde_json::from_value(json!({ "host": { "deviceId": "other", "roots": [] } }))
                    .unwrap()
            )
            .is_err());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn unpairing_this_computer_forgets_its_servers_and_closes_them() {
        let link = FakeLink::new(true);
        let (state, dir, events) = engine("unpair", &link);

        assert!(test_keychain::holds(host_id("unpair").as_str()));

        let view = state
            .settings_update(serde_json::from_value(json!({ "unpair": true })).unwrap())
            .unwrap();

        assert!(view.hosts.is_empty());
        assert!(store::load(&dir.join("device.json")).hosts.is_empty());
        assert!(
            !test_keychain::holds(host_id("unpair").as_str()),
            "the server's secret stayed in the keychain"
        );
        assert_eq!(link.closed.load(Ordering::SeqCst), 1);
        assert!(state
            .manifest_for(Some(host_id("unpair").as_str()))
            .is_err());
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::Changed)));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn pairing_as_another_device_drops_the_servers_of_the_old_one() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("repair", &link);
        let state = Arc::new(state);

        answering(&state, "once");

        let other = "b2".repeat(32);

        assert!(state
            .pair(other_id("repair").as_str(), &other, "me")
            .unwrap());
        assert!(state.settings().hosts.is_empty());
        assert_eq!(link.closed.load(Ordering::SeqCst), 1);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn the_status_lists_each_server_and_whether_it_is_connected() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("status", &link);

        assert_eq!(
            serde_json::to_value(state.status()).unwrap()["hosts"],
            json!([{ "connected": true, "deviceId": host_id("status").as_str(), "name": "build-box" }])
        );
        link.close();
        assert_eq!(
            serde_json::to_value(state.status()).unwrap()["hosts"][0]["connected"],
            false
        );

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_terminal_is_only_for_a_paired_server_with_a_connection_that_is_up() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("terminal", &link);

        assert_eq!(
            state.host_terminal("nobody").unwrap_err(),
            "that server is not paired with this computer"
        );
        // The stand-in link has no ssh master behind it, so nothing is offered to run.
        // (Windows has no multiplexed connection at all, and says so instead.)
        let reason = if cfg!(unix) {
            "is not up"
        } else {
            "needs a multiplexed connection"
        };
        assert!(state
            .host_terminal(host_id("terminal").as_str())
            .unwrap_err()
            .contains(reason));

        // Attaching to a connection never makes one, and says where to make it.
        assert_eq!(
            state.host_terminal_attach("nobody").unwrap_err(),
            "that server is not paired with this computer"
        );
        assert!(state
            .host_terminal_attach(host_id("terminal").as_str())
            .unwrap_err()
            .contains(if cfg!(unix) {
                "is not up; connect it in the device window first"
            } else {
                "needs a multiplexed connection"
            }));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn disconnecting_ends_the_master_only_when_no_other_session_rides_it() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("master", &link);
        let probed = FakeLink::new(true);

        // A probe of the same server is still using the master: only this session ends.
        *state.ssh.probe.lock().unwrap() = Some((
            target_of(&server(host_id("master").as_str())),
            Arc::clone(&probed) as Arc<dyn HostLink>,
        ));
        state.host_disconnect(host_id("master").as_str());

        assert_eq!(link.closed.load(Ordering::SeqCst), 1);
        assert_eq!(link.master_exits.load(Ordering::SeqCst), 0);

        // Nothing else on it any more: the master goes too.
        state.ssh.connections.lock().unwrap().insert(
            host_id("master").as_str().into(),
            Arc::clone(&link) as Arc<dyn HostLink>,
        );
        state.ssh.probe.lock().unwrap().take();
        state.host_disconnect(host_id("master").as_str());

        assert_eq!(link.master_exits.load(Ordering::SeqCst), 1);

        let _ = stdfs::remove_dir_all(dir);
    }

    /// A bundle with one entry, in a folder of its own. Nothing here reaches a server.
    fn bundle_in(dir: &std::path::Path) -> crate::install::Bundle {
        let folder = dir.join("bundle");

        stdfs::create_dir_all(&folder).unwrap();
        stdfs::write(
            folder.join("manifest.json"),
            json!({
                "version": HOST_VERSION,
                "targets": { "x86_64-unknown-linux-musl": { "file": "neore-host-linux", "sha256": "0".repeat(64) } },
            })
            .to_string(),
        )
        .unwrap();

        crate::install::Bundle::load(&folder).unwrap()
    }

    #[test]
    fn an_upgrade_is_refused_while_any_session_is_open_to_the_server() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("upgrade", &link);
        let state = state.with_host_bundle(
            Ok(bundle_in(&dir)),
            crate::install::Root::dir("/neore-test/remote").unwrap(),
        );
        let id = host_id("upgrade");

        // The server's own connection.
        let error = state.host_upgrade(&id).unwrap_err();

        assert!(error.contains("open session"), "{error}");
        assert_eq!(
            link.closed.load(Ordering::SeqCst),
            0,
            "the session was ended for it"
        );

        // A probe of the same server counts as well.
        link.close();

        let probed = FakeLink::new(true);

        *state.ssh.probe.lock().unwrap() = Some((
            target_of(&server(&id)),
            Arc::clone(&probed) as Arc<dyn HostLink>,
        ));

        assert!(state
            .host_upgrade(&id)
            .unwrap_err()
            .contains("open session"));

        // The same account reached with another key is the same server: the host software is shared.
        *state.ssh.probe.lock().unwrap() = Some((
            Target {
                identity_file: Some("/keys/other".into()),
                ..target_of(&server(&id))
            },
            FakeLink::new(true) as Arc<dyn HostLink>,
        ));
        assert!(state
            .host_upgrade(&id)
            .unwrap_err()
            .contains("open session"));
        assert!(
            state.ssh.upgrading.lock().unwrap().is_empty(),
            "a refused upgrade left the server marked"
        );

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn an_upgrade_needs_the_host_software_to_be_part_of_the_build() {
        let link = FakeLink::new(false);
        let (state, dir, _) = engine("nobundle", &link);

        link.close();

        assert!(state
            .host_upgrade(&host_id("nobundle"))
            .unwrap_err()
            .contains("no host software"));
        assert!(state
            .host_upgrade("not-a-server")
            .unwrap_err()
            .contains("not paired"));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn no_session_starts_on_a_server_while_its_host_software_is_upgraded() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("during", &link);
        let id = host_id("during");

        link.close();
        state
            .ssh
            .upgrading
            .lock()
            .unwrap()
            .push((id.clone(), target_of(&server(&id))));

        let error = state.host_connect(&id, true).unwrap_err();

        assert!(error.contains("being upgraded"), "{error}");

        let _ = stdfs::remove_dir_all(dir);
    }

    /// The paired server of `engine(name, ..)` as a page names it.
    fn spec_of_server() -> HostSpec {
        serde_json::from_value(
            json!({ "address": "build.example.com", "name": "build-box", "user": "deploy" }),
        )
        .unwrap()
    }

    /// Makes the engine "connect" to `link` instead of running ssh.
    fn connecting_to(state: &mut DeviceState, link: &Arc<FakeLink>) {
        let link = Arc::clone(link);

        state.ssh.connector = Some(Box::new(
            move |_| Ok(Arc::clone(&link) as Arc<dyn HostLink>),
        ));
    }

    #[test]
    fn a_probe_does_not_land_on_a_server_an_upgrade_began_on_after_it_connected() {
        let paired = FakeLink::new(true);
        let (mut state, dir, _) = engine("race-probe", &paired);
        let id = host_id("race-probe");
        let probed = FakeLink::new(true);
        let gate = Arc::new(Barrier::new(2));

        paired.close();
        *probed.gate.lock().unwrap() = Some(Arc::clone(&gate));
        connecting_to(&mut state, &probed);

        let state = Arc::new(state);

        answering(&state, "once");

        let probing = {
            let state = Arc::clone(&state);

            thread::spawn(move || state.host_probe(&spec_of_server()))
        };

        // The probe is connected and has not yet taken its place. An upgrade marks the server now and, finding
        // no session, goes on to replace the binary.
        gate.wait();
        state
            .ssh
            .upgrading
            .lock()
            .unwrap()
            .push((id.clone(), target_of(&server(&id))));
        assert!(!state.session_open(&target_of(&server(&id))));
        gate.wait();

        let error = probing.join().unwrap().unwrap_err();

        assert!(error.contains("being installed"), "{error}");
        assert!(state.ssh.probe.lock().unwrap().is_none());
        assert_eq!(probed.closed.load(Ordering::SeqCst), 1);
        assert_eq!(probed.master_exits.load(Ordering::SeqCst), 0);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_reconnect_does_not_land_on_a_server_an_upgrade_began_on_after_it_connected() {
        let paired = FakeLink::new(true);
        let (mut state, dir, _) = engine("race-connect", &paired);
        let id = host_id("race-connect");
        let again = FakeLink::new(true);
        let gate = Arc::new(Barrier::new(2));

        paired.close();
        *again.gate.lock().unwrap() = Some(Arc::clone(&gate));
        connecting_to(&mut state, &again);

        let state = Arc::new(state);
        let connecting = {
            let (state, id) = (Arc::clone(&state), id.clone());

            thread::spawn(move || state.host_connect(&id, true))
        };

        gate.wait();
        state
            .ssh
            .upgrading
            .lock()
            .unwrap()
            .push((id.clone(), target_of(&server(&id))));
        gate.wait();

        let error = connecting.join().unwrap().unwrap_err();

        assert!(error.contains("being upgraded"), "{error}");
        assert!(!state.connection(&id).is_some_and(|link| link.is_alive()));
        assert_eq!(again.closed.load(Ordering::SeqCst), 1);
        assert_eq!(again.master_exits.load(Ordering::SeqCst), 0);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_server_being_paired_still_counts_as_a_session_to_an_upgrade() {
        let paired = FakeLink::new(true);
        let (state, dir, _) = engine("race-pair", &paired);
        let state = state.with_host_bundle(
            Ok(bundle_in(&dir)),
            crate::install::Root::dir("/neore-test/remote").unwrap(),
        );
        let (id, new_id) = (host_id("race-pair"), other_id("race-pair"));
        let target = target_of(&server(&id));
        let probed = FakeLink::new(true);

        paired.close();
        *state.ssh.probe.lock().unwrap() =
            Some((target.clone(), Arc::clone(&probed) as Arc<dyn HostLink>));

        let state = Arc::new(state);
        let pairing = {
            let (state, new_id) = (Arc::clone(&state), new_id.clone());

            thread::spawn(move || state.host_pair(&spec_of_server(), &new_id, HOST_SECRET))
        };
        let prompt = loop {
            if let Some(prompt) = state.prompt_current() {
                break prompt;
            }

            thread::sleep(Duration::from_millis(5));
        };

        // The person is still deciding: the session is in neither the connections nor lost.
        assert!(state.session_open(&target));
        assert!(state
            .host_upgrade(&id)
            .unwrap_err()
            .contains("open session"));

        state.prompt_answer(prompt.id, "once").unwrap();
        assert!(pairing.join().unwrap().unwrap());
        assert!(state.ssh.probe.lock().unwrap().is_none());
        assert!(state
            .connection(&new_id)
            .is_some_and(|link| link.is_alive()));
        assert!(state.session_open(&target));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_pairing_that_commits_during_an_upgrade_is_paired_but_not_connected() {
        let paired = FakeLink::new(true);
        let (state, dir, _) = engine("race-commit", &paired);
        let (id, new_id) = (host_id("race-commit"), other_id("race-commit"));
        let target = target_of(&server(&id));
        let probed = FakeLink::new(true);

        paired.close();
        *state.ssh.probe.lock().unwrap() =
            Some((target.clone(), Arc::clone(&probed) as Arc<dyn HostLink>));

        let state = Arc::new(state);
        let pairing = {
            let (state, new_id) = (Arc::clone(&state), new_id.clone());

            thread::spawn(move || state.host_pair(&spec_of_server(), &new_id, HOST_SECRET))
        };
        let prompt = loop {
            if let Some(prompt) = state.prompt_current() {
                break prompt;
            }

            thread::sleep(Duration::from_millis(5));
        };

        // An upgrade marks the server while the probe is still the open session.
        state
            .ssh
            .upgrading
            .lock()
            .unwrap()
            .push((id.clone(), target));
        state.prompt_answer(prompt.id, "once").unwrap();

        assert!(pairing.join().unwrap().unwrap());
        assert!(state
            .settings()
            .hosts
            .iter()
            .any(|host| host.device_id == new_id));
        assert!(!state
            .connection(&new_id)
            .is_some_and(|link| link.is_alive()));
        assert!(state.ssh.probe.lock().unwrap().is_none());
        assert_eq!(probed.closed.load(Ordering::SeqCst), 1);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_first_install_is_refused_while_a_session_is_open_to_the_server() {
        let paired = FakeLink::new(true);
        let (mut state, dir, _) = engine("race-install", &paired);
        let spare = FakeLink::new(true);

        connecting_to(&mut state, &spare);

        let state = Arc::new(state.with_host_bundle(
            Ok(bundle_in(&dir)),
            crate::install::Root::dir("/neore-test/remote").unwrap(),
        ));

        answering(&state, "once");

        let error = state.host_probe(&spec_of_server()).unwrap_err();

        assert!(error.contains("open session"), "{error}");
        assert!(
            state.ssh.upgrading.lock().unwrap().is_empty(),
            "a refused install left the server marked"
        );
        assert_eq!(paired.closed.load(Ordering::SeqCst), 0);
        assert!(state.ssh.probe.lock().unwrap().is_none());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn agent_forwarding_is_the_local_windows_to_turn_on_and_restarts_the_connection() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("forward", &link);
        let probed = FakeLink::new(true);

        // Another session rides the same master, which ssh configured with the old forwarding.
        *state.ssh.probe.lock().unwrap() = Some((
            target_of(&server(&host_id("forward"))),
            Arc::clone(&probed) as Arc<dyn HostLink>,
        ));
        let turn_on: SettingsUpdate = serde_json::from_value(
            json!({ "host": { "deviceId": host_id("forward").as_str(), "forwardAgent": true } }),
        )
        .unwrap();

        assert!(!state.settings().hosts[0].forward_agent);

        let view = state.settings_update(turn_on).unwrap();

        assert!(view.hosts[0].forward_agent);
        assert!(
            !view.hosts[0].connected,
            "the connection kept running without the change"
        );
        assert_eq!(
            link.master_exits.load(Ordering::SeqCst),
            1,
            "the master kept the old forwarding for the session that shares it"
        );
        // A page that asks for it is refused outright, not ignored.
        assert!(serde_json::from_value::<HostSpec>(
            json!({ "address": "a", "name": "x", "user": "u", "forwardAgent": true })
        )
        .is_err());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn removing_a_server_forgets_its_pinned_key_unless_another_server_shares_it() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("forget", &link);
        let paths = &state.ssh.paths;
        let key = "AAAAC3NzaC1lZDI1NTE5AAAAIEP+YmaNKEEP9QIxWrDvG/5Np6vN9WsgVWIYBUUjdBTH";

        stdfs::create_dir_all(paths.known_hosts.parent().unwrap()).unwrap();
        stdfs::write(
            &paths.known_hosts,
            format!("build.example.com ssh-ed25519 {key}\n"),
        )
        .unwrap();
        state
            .change_settings(|settings| {
                settings.hosts.push(Host {
                    device_id: other_id("forget").as_str().into(),
                    name: "twin".into(),
                    ..server(other_id("forget").as_str())
                });

                Ok(())
            })
            .unwrap();

        state.host_remove(host_id("forget").as_str()).unwrap();
        assert_eq!(
            crate::ssh::pinned_keys(paths, "build.example.com").len(),
            1,
            "the key the other server needs was dropped"
        );

        state.host_remove(other_id("forget").as_str()).unwrap();
        assert!(crate::ssh::pinned_keys(paths, "build.example.com").is_empty());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_page_cannot_smuggle_an_ssh_option_through_the_spec() {
        let spec = |address: &str, user: &str| {
            serde_json::from_value::<HostSpec>(
                json!({ "address": address, "name": "x", "user": user }),
            )
            .unwrap()
            .target()
        };

        assert!(spec("build.example.com", "deploy").is_ok());
        assert!(spec("-oProxyCommand=x", "deploy").is_err());
        assert!(spec("build.example.com", "-oProxyCommand=x").is_err());
        assert!(serde_json::from_value::<HostSpec>(
            json!({ "address": "a", "name": "x", "user": "u", "command": "x" })
        )
        .is_err());
    }

    fn spec_for(port: u16) -> HostSpec {
        serde_json::from_value(
            json!({ "address": "127.0.0.1", "name": "build-box", "port": port, "user": "deploy" }),
        )
        .unwrap()
    }

    #[test]
    fn a_probe_nobody_approved_makes_no_network_call() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("probe", &link);
        let state = Arc::new(state);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        listener.set_nonblocking(true).unwrap();

        let prompts = answering(&state, "deny");
        let error = state.host_probe(&spec_for(port)).unwrap_err();

        assert!(error.contains("not approved"), "{error}");
        assert!(
            matches!(
                listener.accept(),
                Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock
            ),
            "ssh reached the server before anyone approved it"
        );
        assert!(state.ssh.probe.lock().unwrap().is_none());

        let seen = prompts.lock().unwrap();

        assert!(matches!(
            seen.as_slice(),
            [Prompt { body: PromptBody::HostConnect { user, port: asked, .. }, .. }] if user == "deploy" && *asked == port
        ));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn an_unpaired_computer_refuses_a_probe_without_asking() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("probe-unpaired", &link);

        state
            .change_settings(|settings| {
                settings.pairing = None;

                Ok(())
            })
            .unwrap();

        // Unpaired: refused before even asking, so a page cannot make a prompt appear on a computer with no account.
        assert_eq!(
            state.host_probe(&spec_for(22)).unwrap_err(),
            "pair this computer first"
        );
        assert!(state.prompts.current().is_none());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_server_name_with_a_control_character_is_refused() {
        let mut spec = spec_for(22);
        spec.name = "prod\n\nApprove?".into();

        assert!(spec.target().is_err());
        assert!(spec_for(22).target().is_ok());
    }

    #[test]
    fn unpairing_closes_the_probe_connection() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("unpair-probe", &link);

        *state.ssh.probe.lock().unwrap() = Some((
            spec_for(22).target().unwrap(),
            Arc::clone(&link) as Arc<dyn HostLink>,
        ));
        state.close_probe();

        assert!(state.ssh.probe.lock().unwrap().is_none());
        assert_eq!(link.closed.load(Ordering::SeqCst), 1);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_server_cannot_be_paired_under_this_computers_own_id() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("own-id", &link);
        let spec = spec_for(22);
        let probed = FakeLink::new(true);

        *state.ssh.probe.lock().unwrap() = Some((
            spec.target().unwrap(),
            Arc::clone(&probed) as Arc<dyn HostLink>,
        ));

        let error = state
            .host_pair(&spec, &desk_id("own-id"), HOST_SECRET)
            .unwrap_err();

        assert!(error.contains("own"), "{error}");
        // Refused before the probe was used up, and nothing was added.
        assert!(state.ssh.probe.lock().unwrap().is_some());
        assert_eq!(state.settings().hosts.len(), 1);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_retried_connection_shows_one_key_changed_notice_per_server() {
        let link = FakeLink::new(true);
        let (state, dir, events) = engine("changed", &link);
        let ask = state.ask_user();
        let target = target_of(&server(&host_id("changed")));
        let shown = || {
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, Event::Prompt { .. }))
                .count()
        };
        let notices = |expected: usize| {
            for _ in 0..200 {
                if shown() == expected {
                    return;
                }

                thread::sleep(Duration::from_millis(10));
            }

            panic!("{} notices, not {expected}", shown());
        };

        ask.key_changed(&target, &["a".into()], &["b".into()]);
        ask.key_changed(&target, &["a".into()], &["b".into()]);
        notices(1);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(shown(), 1, "a retry stacked another notice");

        // Dismissed: the next refusal is news again.
        state.prompts.deny_all();
        while !state.ssh.changed_prompts.lock().unwrap().is_empty() {
            thread::sleep(Duration::from_millis(10));
        }
        ask.key_changed(&target, &["a".into()], &["b".into()]);
        notices(2);
        state.prompts.deny_all();

        let _ = stdfs::remove_dir_all(dir);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Waits for `condition` for up to two seconds.
    fn eventually(what: &str, condition: impl Fn() -> bool) {
        for _ in 0..400 {
            if condition() {
                return;
            }

            thread::sleep(Duration::from_millis(5));
        }

        panic!("{what}");
    }

    /// An engine whose server was connected by hand over `first` (so the keeper has it) and which connects over
    /// whatever `connector` hands out afterwards.
    fn kept(
        name: &str,
        first: &Arc<FakeLink>,
        connector: impl Fn() -> Result<Arc<dyn HostLink>, ConnectError> + Send + Sync + 'static,
    ) -> (Arc<DeviceState>, PathBuf) {
        let (mut state, dir, _) = engine(name, first);

        state.ssh.connector = Some(Box::new(move |_| connector()));
        state.note_connected(
            &host_id(name),
            &(Arc::clone(first) as Arc<dyn HostLink>),
            true,
        );

        (Arc::new(state), dir)
    }

    fn phase_of(state: &DeviceState, name: &str) -> Option<ReconnectView> {
        state.reconnect_view(&host_id(name))
    }

    #[test]
    fn a_lost_link_is_replaced_in_the_background_old_session_first() {
        let first = FakeLink::new(true);
        let second = FakeLink::new(true);
        let next = Arc::clone(&second);
        let (state, dir) = kept("lost", &first, move || {
            Ok(Arc::clone(&next) as Arc<dyn HostLink>)
        });
        let now = Instant::now();

        // The network went away: ssh gave up on the connection, so the master may be wedged.
        first.alive.store(false, Ordering::SeqCst);
        first.suspect.store(true, Ordering::SeqCst);
        state.reconnect_tick(now);

        let waiting = phase_of(&state, "lost").unwrap();

        assert_eq!((waiting.phase, waiting.attempt), ("waiting", Some(1)));
        assert_eq!(
            first.closed.load(Ordering::SeqCst),
            1,
            "the old session stayed open"
        );
        assert_eq!(
            first.master_exits.load(Ordering::SeqCst),
            1,
            "a wedged master was kept"
        );
        assert!(state.connection(&host_id("lost")).is_none());

        // Not before the wait is over.
        state.reconnect_tick(now + Duration::from_secs(1));
        assert_eq!(second.closed.load(Ordering::SeqCst), 0);
        assert!(state.connection(&host_id("lost")).is_none());

        state.reconnect_tick(now + Duration::from_secs(2));
        eventually("the server was not reconnected", || {
            state.connection(&host_id("lost")).is_some()
        });
        state.reconnect_tick(now + Duration::from_secs(3));

        assert!(
            phase_of(&state, "lost").is_none(),
            "{:?}",
            phase_of(&state, "lost")
        );

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_host_that_merely_ended_leaves_the_master_for_the_next_session_to_share() {
        let first = FakeLink::new(true);
        let (state, dir) = kept("ended", &first, || Err("down".into()));

        first.alive.store(false, Ordering::SeqCst);
        state.reconnect_tick(Instant::now());

        assert_eq!(first.closed.load(Ordering::SeqCst), 1);
        assert_eq!(first.master_exits.load(Ordering::SeqCst), 0);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn attempts_back_off_and_a_failure_that_needs_a_person_waits_for_a_retry() {
        let first = FakeLink::new(true);
        let failures = Arc::new(Mutex::new(vec![
            ConnectError {
                message: "no route".into(),
                retryable: true,
            },
            ConnectError {
                message: "the login was refused".into(),
                retryable: false,
            },
        ]));
        let queue = Arc::clone(&failures);
        let (state, dir) = kept("backoff", &first, move || {
            Err(queue.lock().unwrap().remove(0))
        });
        let start = Instant::now();

        first.alive.store(false, Ordering::SeqCst);
        state.reconnect_tick(start);

        // First attempt after two seconds; it fails and the next wait is four.
        state.reconnect_tick(start + Duration::from_secs(2));
        eventually("the first attempt did not finish", || {
            failures.lock().unwrap().len() == 1
        });
        eventually("the wait did not double", || {
            phase_of(&state, "backoff")
                .is_some_and(|view| view.attempt == Some(2) && view.phase == "waiting")
        });

        let waiting = phase_of(&state, "backoff").unwrap();
        let in_ms = waiting.next_attempt_at.unwrap().saturating_sub(now_ms());

        assert!((3_000..=4_000).contains(&in_ms), "{in_ms}");

        // A login nobody can fix by waiting stops the attempts at once.
        state.reconnect_tick(start + Duration::from_secs(60));
        eventually("the refusal did not stop the attempts", || {
            phase_of(&state, "backoff").is_some_and(|view| view.phase == "gaveUp")
        });
        assert_eq!(
            phase_of(&state, "backoff").unwrap().reason.as_deref(),
            Some("the login was refused")
        );
        state.reconnect_tick(start + Duration::from_secs(3600));
        assert!(
            failures.lock().unwrap().is_empty(),
            "it tried again by itself"
        );

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_retry_starts_the_attempts_over_and_a_disconnect_ends_the_keeping() {
        let first = FakeLink::new(true);
        let back = FakeLink::new(true);
        let next = Arc::clone(&back);
        let (state, dir) = kept("retry", &first, move || {
            Ok(Arc::clone(&next) as Arc<dyn HostLink>)
        });
        let id = host_id("retry");

        // The link is gone and the person's own attempt failed: the keeper waits for a Retry.
        state.ssh.connections.lock().unwrap().remove(&id);
        state.keep_manual(&id, true).unwrap();
        state.keep_failed(&id, &"the passphrase was not given".into());

        assert_eq!(phase_of(&state, "retry").unwrap().phase, "gaveUp");

        state.host_connect(&id, true).unwrap();

        assert!(phase_of(&state, "retry").is_none());
        assert!(state.connection(&id).is_some_and(|link| link.is_alive()));

        // Disconnected by hand: the keeper has nothing to bring back.
        state.host_disconnect(&id);
        state.reconnect_tick(Instant::now() + Duration::from_secs(3600));

        assert!(state.ssh.keeps.lock().unwrap().is_empty());
        assert!(state.connection(&id).is_none());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn stopping_a_server_that_gave_up_tells_the_other_windows() {
        let link = FakeLink::new(true);
        let (state, dir, events) = engine("stopped", &link);
        let id = host_id("stopped");
        let changed = || {
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| matches!(event, Event::Changed))
                .count()
        };

        state.note_connected(&id, &(Arc::clone(&link) as Arc<dyn HostLink>), true);
        state.ssh.connections.lock().unwrap().remove(&id);
        state.keep_manual(&id, true).unwrap();
        state.keep_failed(&id, &"the passphrase was not given".into());

        let before = changed();

        state.host_disconnect(&id);

        assert_eq!(changed(), before + 1);
        assert!(phase_of(&state, "stopped").is_none());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_background_attempt_asks_nobody_and_one_server_has_one_attempt_at_a_time() {
        let first = FakeLink::new(true);
        let (state, dir, _) = engine("silent", &first);
        let ask = state.ask_user_as(false);
        let target = target_of(&server(&host_id("silent")));
        let key = HostKey {
            blob: "AAAA".into(),
            key_type: "ssh-ed25519".into(),
        };

        assert!(!ask.trust_key(&target, &key));
        assert_eq!(ask.passphrase(&target, "Enter passphrase"), None);
        ask.key_changed(&target, &["a".into()], &["b".into()]);
        assert!(state.prompt_current().is_none(), "a prompt was queued");
        assert!(state.ssh.changed_prompts.lock().unwrap().is_empty());

        let id = host_id("silent");
        let slot = state.begin_attempt(&id).unwrap();

        assert!(state.begin_attempt(&id).is_none());
        drop(slot);
        assert!(state.begin_attempt(&id).is_some());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_new_session_stops_the_launches_this_computer_left_and_no_others() {
        let old = FakeLink::launched(true, Some("11111111111111111111111111111111"));
        let new = FakeLink::launched(true, Some("22222222222222222222222222222222"));
        let (state, dir, _) = engine("reap", &old);
        let id = host_id("reap");

        state.note_connected(&id, &(Arc::clone(&old) as Arc<dyn HostLink>), true);
        assert!(
            old.reaped.lock().unwrap().is_empty(),
            "the first session reaped something"
        );

        state.note_connected(&id, &(Arc::clone(&new) as Arc<dyn HostLink>), true);

        assert_eq!(
            new.reaped.lock().unwrap().as_slice(),
            [vec!["11111111111111111111111111111111".to_owned()]],
            "only the launch this computer made earlier is named"
        );
        assert_eq!(
            state.ssh.launches.lock().unwrap()[&id],
            ["22222222222222222222222222222222"],
            "a reaped launch stays on the list"
        );

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_session_closed_on_purpose_is_not_reaped_by_the_next_one() {
        let old = FakeLink::launched(true, Some("11111111111111111111111111111111"));
        let new = FakeLink::launched(true, Some("22222222222222222222222222222222"));
        let (state, dir, _) = engine("closed", &old);
        let id = host_id("closed");

        state.note_connected(&id, &(Arc::clone(&old) as Arc<dyn HostLink>), true);
        state
            .ssh
            .connections
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::clone(&old) as Arc<dyn HostLink>);
        state.host_disconnect(&id);

        state.note_connected(&id, &(Arc::clone(&new) as Arc<dyn HostLink>), true);

        assert!(
            new.reaped.lock().unwrap().is_empty(),
            "a deliberately closed session was reaped"
        );

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_disconnect_that_lands_while_an_attempt_runs_is_not_undone_by_it() {
        let first = FakeLink::new(true);
        let second = FakeLink::new(true);
        let gate = Arc::new(Barrier::new(2));
        let (next, wait) = (Arc::clone(&second), Arc::clone(&gate));
        let (state, dir) = kept("undo", &first, move || {
            wait.wait();
            wait.wait();

            Ok(Arc::clone(&next) as Arc<dyn HostLink>)
        });
        let (id, now) = (host_id("undo"), Instant::now());

        first.alive.store(false, Ordering::SeqCst);
        state.reconnect_tick(now);
        state.reconnect_tick(now + Duration::from_secs(2));

        // The attempt is connecting. The person disconnects now.
        gate.wait();
        state.host_disconnect(&id);
        gate.wait();

        eventually("the attempt kept a link the person ended", || {
            second.closed.load(Ordering::SeqCst) == 1
        });

        assert!(state.connection(&id).is_none());
        assert!(
            state.ssh.keeps.lock().unwrap().is_empty(),
            "the keeping came back"
        );
        assert!(state.ssh.attempting.lock().unwrap().is_empty());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_setting_changed_while_an_attempt_runs_drops_its_link_but_keeps_the_server_kept() {
        let first = FakeLink::new(true);
        let second = FakeLink::new(true);
        let gate = Arc::new(Barrier::new(2));
        let (next, wait) = (Arc::clone(&second), Arc::clone(&gate));
        let (state, dir) = kept("restart", &first, move || {
            wait.wait();
            wait.wait();

            Ok(Arc::clone(&next) as Arc<dyn HostLink>)
        });
        let (id, now) = (host_id("restart"), Instant::now());

        first.alive.store(false, Ordering::SeqCst);
        state.reconnect_tick(now);
        state.reconnect_tick(now + Duration::from_secs(2));

        // The attempt is connecting with the old setting. The owner turns agent forwarding off.
        gate.wait();
        state.host_restart(&id);
        gate.wait();

        eventually("the attempt kept a link made with the old setting", || {
            second.closed.load(Ordering::SeqCst) == 1
        });
        eventually("the attempt released its slot", || {
            state.ssh.attempting.lock().unwrap().is_empty()
        });

        assert!(state.connection(&id).is_none());
        assert_eq!(phase_of(&state, "restart").unwrap().phase, "waiting");

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn an_attempt_for_a_server_paired_again_elsewhere_keeps_no_link() {
        let first = FakeLink::new(true);
        let second = FakeLink::new(true);
        let gate = Arc::new(Barrier::new(2));
        let (next, wait) = (Arc::clone(&second), Arc::clone(&gate));
        let (state, dir) = kept("repair", &first, move || {
            wait.wait();
            wait.wait();

            Ok(Arc::clone(&next) as Arc<dyn HostLink>)
        });
        let (id, now) = (host_id("repair"), Instant::now());

        first.alive.store(false, Ordering::SeqCst);
        state.reconnect_tick(now);
        state.reconnect_tick(now + Duration::from_secs(2));

        // The attempt is connecting to the old address. The same id is paired with another server now.
        gate.wait();
        state
            .change_settings_counted(true, |settings| {
                settings.hosts[0].address = "other.example.com".into();

                Ok(())
            })
            .unwrap();
        gate.wait();

        eventually("the attempt kept a link to the old server", || {
            second.closed.load(Ordering::SeqCst) == 1
        });

        assert!(state.connection(&id).is_none());
        assert!(state.ssh.attempting.lock().unwrap().is_empty());

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_failure_the_network_caused_goes_on_with_the_backoff_even_when_tried_by_hand() {
        let first = FakeLink::new(true);
        let (state, dir) = kept("handretry", &first, || Err("down".into()));
        let id = host_id("handretry");

        state.ssh.connections.lock().unwrap().remove(&id);
        state.keep_manual(&id, true).unwrap();
        state.keep_failed(
            &id,
            &ConnectError {
                message: "timed out".into(),
                retryable: true,
            },
        );

        assert_eq!(phase_of(&state, "handretry").unwrap().phase, "waiting");

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_background_connection_never_starts_the_keeping() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("nokeep", &link);
        let id = host_id("nokeep");
        let as_link = Arc::clone(&link) as Arc<dyn HostLink>;

        assert!(!state.note_connected(&id, &as_link, false));
        assert!(state.ssh.keeps.lock().unwrap().is_empty());
        assert!(state.note_connected(&id, &as_link, true));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_connect_that_finds_the_slot_taken_leaves_the_keeping_alone() {
        let first = FakeLink::new(true);
        let (state, dir) = kept("busy", &first, || Err("down".into()));
        let id = host_id("busy");
        let slot = state.begin_attempt(&id).unwrap();

        first.alive.store(false, Ordering::SeqCst);

        let error = state.host_connect(&id, true).unwrap_err();

        assert!(error.contains("already connecting"), "{error}");
        assert_eq!(
            *state.ssh.keeps.lock().unwrap()[&id].phase(),
            Phase::Connected
        );

        drop(slot);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_dead_link_is_left_for_the_attempt_that_holds_the_server() {
        let first = FakeLink::new(true);
        let (state, dir) = kept("slot", &first, || Err("down".into()));
        let id = host_id("slot");

        first.alive.store(false, Ordering::SeqCst);
        first.suspect.store(true, Ordering::SeqCst);

        let slot = state.begin_attempt(&id).unwrap();

        state.reconnect_tick(Instant::now());

        assert_eq!(
            first.closed.load(Ordering::SeqCst),
            0,
            "a session was ended under an attempt"
        );
        assert_eq!(
            first.master_exits.load(Ordering::SeqCst),
            0,
            "a master was ended under an attempt"
        );

        drop(slot);
        state.reconnect_tick(Instant::now());

        assert_eq!(first.closed.load(Ordering::SeqCst), 1);
        assert_eq!(first.master_exits.load(Ordering::SeqCst), 1);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn a_page_cannot_dial_a_server_past_the_window_but_the_local_retry_can() {
        let first = FakeLink::new(true);
        let (state, dir) = kept("page", &first, || Err("down".into()));
        let id = host_id("page");

        state.ssh.connections.lock().unwrap().remove(&id);

        for _ in 0..crate::lifecycle::MAX_ATTEMPTS {
            assert!(state.host_connect(&id, false).unwrap_err().contains("down"));
        }

        let refused = state.host_connect(&id, false).unwrap_err();

        assert!(refused.contains("device window"), "{refused}");
        assert!(state.host_connect(&id, true).unwrap_err().contains("down"));

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn disconnecting_one_server_does_not_cancel_the_attempts_of_another() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("count", &link);
        let id = host_id("count");
        let before = state.disconnects_of(&id);

        state.note_disconnect(&other_id("count"));

        assert_eq!(state.disconnects_of(&id), before);

        state.note_disconnect(&id);

        assert_eq!(state.disconnects_of(&id), before + 1);

        let _ = stdfs::remove_dir_all(dir);
    }

    #[test]
    fn the_file_tree_asks_the_server_for_a_page_inside_the_folders_set_for_it() {
        let link = FakeLink::new(true);
        let (state, _, _) = engine("files-list", &link);
        let page = state
            .host_files_list(&host_id("files-list"), "src", Some("m"))
            .unwrap();

        assert_eq!(page["host"], "build-box");
        assert_eq!(
            link.listed.lock().unwrap().as_slice(),
            [json!({ "after": "m", "path": "src", "roots": ["/srv/app"] })]
        );

        link.close();

        assert!(state
            .host_files_list(&host_id("files-list"), "", None)
            .unwrap_err()
            .contains("not connected"));
        assert!(state.host_files_list("nobody", "", None).is_err());
    }

    #[test]
    fn a_file_is_read_through_the_same_action_an_agent_would_run() {
        let link = FakeLink::new(true);
        let (state, _, _) = engine("files-read", &link);
        let read = state
            .host_file_read(&host_id("files-read"), "a.txt")
            .unwrap();

        assert_eq!(read["host"], "build-box");
        assert_eq!(read["text"], "from the server");

        let run = link.runs.lock().unwrap()[0].clone();

        assert_eq!(run["tool"], "fs_read");
        assert_eq!(run["roots"], json!(["/srv/app"]));

        *link.outcome.lock().unwrap() = Ok(RemoteOutcome {
            error: Some("a.txt: outside the shared folders".into()),
            exit_code: None,
            output: None,
            status: "failed".into(),
            truncated: false,
        });

        assert_eq!(
            state
                .host_file_read(&host_id("files-read"), "a.txt")
                .unwrap_err(),
            "a.txt: outside the shared folders"
        );
    }

    #[test]
    fn a_download_lands_complete_or_not_at_all() {
        let link = FakeLink::new(true);
        let (state, dir, _) = engine("files-download", &link);
        let destination = dir.join("app.tar");
        let id = host_id("files-download");
        let summary = state.host_download(&id, "", &destination).unwrap();

        assert_eq!(summary["host"], "build-box");
        assert_eq!(stdfs::read(&destination).unwrap(), b"TAR");
        assert!(!dir.join("app.tar.part").exists());

        // A failure part way leaves the earlier file as it was and no part file.
        *link.archive.lock().unwrap() = Err("the server stopped sending".into());

        assert_eq!(
            state.host_download(&id, "", &destination).unwrap_err(),
            "the server stopped sending"
        );
        assert_eq!(stdfs::read(&destination).unwrap(), b"TAR");
        assert!(!dir.join("app.tar.part").exists());
        assert!(state
            .host_download(&id, "", Path::new("relative.tar"))
            .is_err());

        let audit = state.audit_tail().join("\n");

        assert!(audit.contains("files_download") && audit.contains("failed"));
    }
}
