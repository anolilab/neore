//! The servers this computer reaches over SSH: pairing one, connecting it, signing its manifest and running its
//! calls. A server is a device of its own on the backend with a secret of its own, and only this computer holds
//! it, so the calls and the results are verified and signed HERE, with the server's secret; what goes down the pipe
//! is the already approved action (`host.rs` runs it).

use std::collections::HashSet;
use std::path::PathBuf;
use std::thread;

use super::*;
use crate::install::{self, Installed, Remote};
use crate::ssh::{Hello, HostConnection, HostKey, Interact, HOST_VERSION};

/// At most as many servers as the backend lets one account pair devices.
const MAX_HOSTS: usize = 10;

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
}

impl Drop for UpgradeGuard<'_> {
    fn drop(&mut self) {
        self.state
            .ssh
            .upgrading
            .lock()
            .unwrap()
            .retain(|(id, _)| *id != self.device_id);
    }
}

/// What the relay needs of a server: whether to beat for it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub connected: bool,
    pub device_id: String,
    pub name: String,
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
    pub name: String,
    pub platform: Option<String>,
    pub port: u16,
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

fn target_of(host: &Host) -> Target {
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
    fn connection(&self, device_id: &str) -> Option<Arc<dyn HostLink>> {
        self.ssh.connections.lock().unwrap().get(device_id).cloned()
    }

    fn ask_user(&self) -> Arc<dyn Interact> {
        Arc::new(AskUser {
            changed_prompts: Arc::clone(&self.ssh.changed_prompts),
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
                    name: host.name.clone(),
                    platform: link.as_ref().map(|link| link.hello().platform.clone()),
                    port: host.port,
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
    /// server, a reconnect that already took its place).
    fn retire(&self, link: &Arc<dyn HostLink>) {
        link.close();

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

        if !shared {
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
    }

    pub(super) fn close_probe(&self) {
        let probe = self.ssh.probe.lock().unwrap().take();

        if let Some((_, link)) = probe {
            self.retire(&link);
        }
    }

    pub(super) fn close_hosts(&self) {
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

    fn connect_target(&self, target: &Target) -> Result<Arc<dyn HostLink>, String> {
        let link: Arc<dyn HostLink> = Arc::new(HostConnection::connect(
            target,
            &self.ssh.paths,
            &self.ssh.binary,
            &self.ask_user(),
        )?);

        Ok(link)
    }

    /// Whether host software is being installed on `target` right now.
    fn upgrade_running(&self, target: &Target) -> bool {
        self.ssh
            .upgrading
            .lock()
            .unwrap()
            .iter()
            .any(|(_, upgrading)| same_server(upgrading, target))
    }

    /// Whether a session (a live connection or the probe) is open to `target`.
    fn session_open(&self, target: &Target) -> bool {
        let live = |link: &Arc<dyn HostLink>| {
            link.is_alive()
                && link
                    .target()
                    .is_some_and(|other| same_server(other, target))
        };

        self.ssh.connections.lock().unwrap().values().any(live)
            || self
                .ssh
                .probe
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|(_, link)| live(link))
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
            return Err(
                "that server's host software is being installed; try again in a moment".into(),
            );
        }

        if let Ok(bundle) = &self.ssh.bundle {
            let interact = self.ask_user();
            let remote = Remote {
                interact: &interact,
                paths: &self.ssh.paths,
                target: &target,
            };

            install::install(&remote, bundle, &self.ssh.root)?;
        }

        let link = self.connect_target(&target)?;

        // Unpaired while the person was answering or the connection was opening: nothing may keep it.
        if usable_pairing(&self.settings()).is_err() {
            self.retire(&link);

            return Err("this computer was unpaired meanwhile".into());
        }

        if self.upgrade_running(&target) {
            self.retire(&link);

            return Err(
                "that server's host software is being installed; try again in a moment".into(),
            );
        }

        let probe = HostProbe::of(link.hello());
        let replaced = self.ssh.probe.lock().unwrap().replace((target, link));

        if let Some((_, previous)) = replaced {
            self.retire(&previous);
        }

        Ok(probe)
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

        let link = {
            let mut probe = self.ssh.probe.lock().unwrap();

            match probe.take() {
                Some((probed, link)) if probed == target => link,
                other => {
                    *probe = other;

                    return Err("connect to the server first".into());
                }
            }
        };

        // A forwarding change can end the master this probe rode: a dead link is no connection to pair.
        if !link.is_alive() {
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
            self.retire(&link);

            return Ok(false);
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
            self.retire(&link);

            return Err(error);
        }

        let previous = self
            .ssh
            .connections
            .lock()
            .unwrap()
            .insert(device_id.to_owned(), link);

        if let Some(previous) = previous {
            self.retire(&previous);
        }

        self.emit(Event::Changed);

        Ok(true)
    }

    /// Connects a paired server again (after a restart or a lost connection).
    pub fn host_connect(&self, device_id: &str) -> Result<HostProbe, String> {
        let host = self
            .settings()
            .hosts
            .into_iter()
            .find(|host| host.device_id == device_id)
            .ok_or("that server is not paired with this computer")?;

        if let Some(link) = self.connection(device_id).filter(|link| link.is_alive()) {
            return Ok(HostProbe::of(link.hello()));
        }

        let target = target_of(&host);

        if self.upgrade_running(&target) {
            return Err(format!(
                "{}'s host software is being upgraded; connect again in a moment",
                host.name
            ));
        }

        let disconnects = self.ssh.disconnects.load(Ordering::SeqCst);
        let link = self.connect_target(&target)?;
        let probe = HostProbe::of(link.hello());

        // An upgrade began while this was connecting (a passphrase prompt can take a while): it was checked for
        // open sessions before this one existed, so this one yields.
        if self.upgrade_running(&target) {
            self.retire(&link);

            return Err(format!(
                "{}'s host software is being upgraded; connect again in a moment",
                host.name
            ));
        }

        // Disconnected while the connect was waiting: the user asked for that, and it stays asked.
        if self.ssh.disconnects.load(Ordering::SeqCst) != disconnects {
            self.retire(&link);

            return Err("that server was disconnected meanwhile".into());
        }

        // Dropped from the settings while the user was typing a passphrase: nothing to keep.
        if !self
            .settings()
            .hosts
            .iter()
            .any(|current| current.device_id == device_id)
        {
            self.retire(&link);

            return Err("that server was removed meanwhile".into());
        }

        let previous = self
            .ssh
            .connections
            .lock()
            .unwrap()
            .insert(device_id.to_owned(), link);

        if let Some(previous) = previous {
            self.retire(&previous);
        }

        self.emit(Event::Changed);

        Ok(probe)
    }

    /// The `ssh` arguments of a shell on a paired server, after connecting it: that asks to trust its key on first
    /// use and for a key passphrase, in the local window, so an untrusted server gets no terminal. The shell rides
    /// the connection's master, so it ends with it.
    pub fn host_terminal(&self, device_id: &str) -> Result<Vec<String>, String> {
        let host = self.paired_host(device_id)?;

        self.host_connect(device_id)?;

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

    pub fn host_disconnect(&self, device_id: &str) {
        self.ssh.disconnects.fetch_add(1, Ordering::SeqCst);

        let link = self.ssh.connections.lock().unwrap().remove(device_id);

        if let Some(link) = link {
            self.retire(&link);
            self.emit(Event::Changed);
        }
    }

    /// Ends a server's connection and the master under it, even when another session still rides that master: for
    /// a change ssh only reads when the master starts.
    pub(super) fn host_restart(&self, device_id: &str) {
        // A connect still waiting (on a passphrase) was opened with the settings from before this change; it must not
        // be installed afterwards with, say, agent forwarding the owner has just turned off.
        self.ssh.disconnects.fetch_add(1, Ordering::SeqCst);

        let link = self.ssh.connections.lock().unwrap().remove(device_id);

        if let Some(link) = link {
            link.close();
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
        let _guard = {
            let mut upgrading = self.ssh.upgrading.lock().unwrap();

            if upgrading
                .iter()
                .any(|(_, running)| same_server(running, &target))
            {
                return Err(format!("{} is already being upgraded", host.name));
            }

            upgrading.push((device_id.to_owned(), target.clone()));

            UpgradeGuard {
                device_id: device_id.to_owned(),
                state: self,
            }
        };

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
        link.exit_master();

        if version != HOST_VERSION {
            return Err(format!(
                "the installed host reports version {version}, not {HOST_VERSION}; the old versions were kept"
            ));
        }

        install::prune(&remote, &self.ssh.root)?;
        self.emit(Event::Changed);

        Ok(HostUpgrade {
            already_current: installed == Installed::Current,
            version,
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
    use crate::ssh::{RemoteOutcome, RemoteSandbox};
    use crate::store::test_keychain;
    use std::sync::atomic::{AtomicBool, AtomicUsize};

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
        target: Option<Target>,
    }

    impl FakeLink {
        fn new(sandbox: bool) -> Arc<FakeLink> {
            Arc::new(FakeLink {
                alive: AtomicBool::new(true),
                closed: AtomicUsize::new(0),
                master_exits: AtomicUsize::new(0),
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

        fn hello(&self) -> &Hello {
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

        let error = state.host_connect(&id).unwrap_err();

        assert!(error.contains("being upgraded"), "{error}");

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
}
