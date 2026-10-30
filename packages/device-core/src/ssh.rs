//! The desktop's side of a server reached over SSH: the `ssh` child, the pinned host keys, the passphrase
//! pipes and the frame client for `neore-host` (`host.rs`, `frame.rs`).
//!
//! It runs the user's own `ssh` and reads no `~/.ssh/config` (`-F`): every option that matters is on the command
//! line, and nothing a page supplies reaches the remote command. The only channel to the server is the ssh
//! child's stdin and stdout; no port is forwarded and nothing here listens.
//!
//! Host keys are pinned in a store of our own (`SshPaths::known_hosts`), never in the user's `known_hosts`.
//! Before ssh runs, the key the server presents is read without authenticating (`ssh-keyscan`) and compared with
//! the pin; ssh then enforces the same store with `StrictHostKeyChecking=yes`, so a key that changes between the
//! two is refused there.
//!
//! A key passphrase is asked through `SSH_ASKPASS`: a tiny script talks to this process over two named pipes in a
//! private directory, so the answer lives in memory and in ssh's own stdin, and in no file.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::frame::{read_frame, write_frame};
use crate::host::PROTOCOL_VERSION;

/// The `neore-host` version the desktop expects to find in `~/.neore/host/<version>/` (S4 uploads it).
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How long a connection may take once nobody is being asked anything.
const CONNECT_PATIENCE: Duration = Duration::from_secs(6 * 60);

/// A Unix socket path holds 104 bytes on macOS. ssh appends a dot and 16 random characters to the control path
/// while it binds, and `%C` is 40 hex characters.
const CONTROL_PATH_MARGIN: usize = 1 + IDENTITY_TAG_LEN + 40 + 1 + 16 + 1;
/// `identity_tag`: `k`, eight hex characters and a dash, in front of `%C` when a key file is used.
const IDENTITY_TAG_LEN: usize = 10;
const SOCKET_PATH_LIMIT: usize = 104;

/// Key types worth pinning, best first. DSA is long dead.
const KEY_TYPES: [&str; 5] = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
];

#[cfg(unix)]
const NULL_DEVICE: &str = "/dev/null";
#[cfg(not(unix))]
const NULL_DEVICE: &str = "NUL";

/// Where a server is and how to log in. The page supplies it, so [`Target::validate`] runs before it is used.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub address: String,
    pub forward_agent: bool,
    pub identity_file: Option<String>,
    pub port: u16,
    pub user: String,
}

impl Target {
    /// Rejects anything that could be read as an ssh option or break out of its argument.
    pub fn validate(&self) -> Result<(), String> {
        let address_ok = (1..=253).contains(&self.address.len())
            && !self.address.starts_with(['-', '.'])
            && self
                .address
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':'));
        let user_ok = (1..=32).contains(&self.user.len())
            && !self.user.starts_with(['-', '.'])
            && self
                .user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));

        if !address_ok {
            return Err("the server address is invalid".into());
        }

        if !user_ok {
            return Err("the user name is invalid".into());
        }

        if self.port == 0 {
            return Err("the port is invalid".into());
        }

        if let Some(file) = &self.identity_file {
            let path = Path::new(file);

            if file.len() > 1000
                || file.contains(['\0', '"', '\n', '\r', '%'])
                || !path.is_absolute()
            {
                return Err("the key file must be an absolute path".into());
            }
        }

        Ok(())
    }

    /// The name known_hosts files this host under: the address, or `[address]:port` off port 22.
    pub fn host_spec(&self) -> String {
        if self.port == 22 {
            self.address.clone()
        } else {
            format!("[{}]:{}", self.address, self.port)
        }
    }

    fn label(&self) -> String {
        format!("{}@{}:{}", self.user, self.address, self.port)
    }
}

/// Where the SSH state lives, under the app's data dir.
#[derive(Clone, Debug)]
pub struct SshPaths {
    /// One private directory per connection holds its two passphrase pipes.
    pub askpass_dir: PathBuf,
    pub askpass_script: PathBuf,
    /// `ControlPath` is `<control_dir>/%C`.
    pub control_dir: PathBuf,
    /// The pinned host keys. Neore never writes the user's `~/.ssh/known_hosts`.
    pub known_hosts: PathBuf,
}

impl SshPaths {
    /// The layout under `data_dir`. The control sockets move to `<home>/.neore/cm` when the data dir is too deep
    /// for a Unix socket path (macOS's default is), never to `/tmp`.
    pub fn under(data_dir: &Path, home: Option<&Path>) -> Self {
        let root = data_dir.join("ssh");
        let preferred = root.join("cm");
        let fits = |dir: &Path| dir.as_os_str().len() + CONTROL_PATH_MARGIN <= SOCKET_PATH_LIMIT;
        let control_dir = match home.map(|home| home.join(".neore").join("cm")) {
            Some(short) if !fits(&preferred) => short,
            _ => preferred,
        };

        SshPaths {
            askpass_dir: root.join("askpass"),
            askpass_script: root.join("neore-askpass"),
            control_dir,
            known_hosts: root.join("known_hosts"),
        }
    }

    /// Creates the directories (0700) and checks the control path fits a socket.
    fn prepare(&self) -> Result<(), String> {
        if self.control_dir.as_os_str().len() + CONTROL_PATH_MARGIN > SOCKET_PATH_LIMIT
            && cfg!(unix)
        {
            return Err(format!(
                "the control socket folder is too deep for a Unix socket: {}",
                self.control_dir.display()
            ));
        }

        for dir in [
            self.known_hosts.parent(),
            Some(self.askpass_dir.as_path()),
            Some(self.control_dir.as_path()),
        ]
        .into_iter()
        .flatten()
        {
            private_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
        }

        Ok(())
    }
}

/// Creates `dir` and its parents, the last one owner-only.
fn private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }

    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// A path as an ssh option value: quoted, because a path with a space (`Application Support`) would otherwise
/// end the value, and with `%` escaped, which ssh would read as a token.
/// A short tag for the key file a target logs in with, empty when it uses none, so two servers with one
/// destination and different keys never share a multiplexed master (and its authenticated session).
fn identity_tag(target: &Target) -> String {
    target
        .identity_file
        .as_ref()
        .map_or_else(String::new, |file| {
            let digest = Sha256::digest(file.as_bytes());

            format!(
                "k{:02x}{:02x}{:02x}{:02x}-",
                digest[0], digest[1], digest[2], digest[3]
            )
        })
}

fn quoted(path: &str, suffix: &str) -> String {
    format!("\"{}{suffix}\"", path.replace('%', "%%"))
}

/// What an ssh run is for. They share every hardening option and differ in a few.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Session {
    /// The host binary on the stdio pipe, riding (or becoming) the multiplexed master.
    Pipe,
    /// A person's shell on a terminal, riding a master that is already up and never becoming one.
    Terminal,
}

/// The options every ssh run of ours carries, then the control options, then the destination. The remote command
/// is the caller's, appended after the destination.
pub fn ssh_args(target: &Target, paths: &SshPaths) -> Vec<String> {
    build_args(target, paths, Session::Pipe)
}

fn build_args(target: &Target, paths: &SshPaths, session: Session) -> Vec<String> {
    let terminal = session == Session::Terminal;
    let mut args: Vec<String> = Vec::new();
    let mut option = |text: String| {
        args.push("-o".into());
        args.push(text);
    };

    option("StrictHostKeyChecking=yes".into());
    option(format!(
        "UserKnownHostsFile={}",
        quoted(&paths.known_hosts.to_string_lossy(), "")
    ));
    option(format!("GlobalKnownHostsFile={NULL_DEVICE}"));
    // ssh would add keys the server announces to the store, which is the trust prompt's job alone.
    option("UpdateHostKeys=no".into());
    option("CheckHostIP=no".into());
    option("VerifyHostKeyDNS=no".into());
    option("PasswordAuthentication=no".into());
    option("KbdInteractiveAuthentication=no".into());
    // A shell somebody types into is not given the user's agent, whatever the server's opt-in for the pipe.
    option(format!(
        "ForwardAgent={}",
        if target.forward_agent && !terminal {
            "yes"
        } else {
            "no"
        }
    ));
    option("ForwardX11=no".into());
    option("ClearAllForwardings=yes".into());
    option("PermitLocalCommand=no".into());
    option("ConnectTimeout=15".into());
    option("ServerAliveInterval=15".into());
    option("ServerAliveCountMax=3".into());
    option("LogLevel=ERROR".into());

    if terminal {
        // All asking happens in the device window, never on the terminal.
        option("BatchMode=yes".into());
        // ssh tries the control socket before it connects. With the master gone it would connect by itself, on
        // the agent's key, as a second connection nobody pinned a lifetime for; this command makes that fail.
        option("ProxyCommand=false".into());
    }

    // Windows' OpenSSH has no multiplexing.
    if cfg!(unix) {
        option(
            if terminal {
                "ControlMaster=no"
            } else {
                "ControlMaster=auto"
            }
            .into(),
        );
        // `%C` is ssh's own token (a hash of the connection), so it is added after the escaping. It does not
        // cover the key file, so a server using another key must not land on this master: the key file's own
        // tag goes in front.
        option(format!(
            "ControlPath={}",
            quoted(
                &paths.control_dir.to_string_lossy(),
                &format!("/{}%C", identity_tag(target))
            )
        ));
        option("ControlPersist=10m".into());
    }

    if let Some(file) = &target.identity_file {
        args.push("-i".into());
        args.push(file.clone());
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
    }

    // No user config, no system config: this run does what this list says. A terminal gets a tty, and no escape
    // character, because `~C` opens ssh's command line, where a person can add a forward (a listener).
    if terminal {
        args.extend(["-t".into(), "-e".into(), "none".into()]);
    } else {
        args.push("-T".into());
    }

    args.extend(["-F".into(), NULL_DEVICE.into()]);
    args.extend(["-p".into(), target.port.to_string()]);
    args.extend(["-l".into(), target.user.clone()]);
    args.push("--".into());
    args.push(target.address.clone());

    args
}

/// The arguments of an interactive shell on the server through the master that is already up: the program is
/// `ssh`, the desktop puts it on a pseudo-terminal. No remote command, so the server starts the user's own login
/// shell and nothing is built into a command line. Fails when the master is not up, naming it plainly.
pub fn terminal_args(target: &Target, paths: &SshPaths) -> Result<Vec<String>, String> {
    if !cfg!(unix) {
        return Err(
            "a terminal on a server needs a multiplexed connection, which this platform lacks"
                .into(),
        );
    }

    target.validate()?;

    let up = Command::new("ssh")
        .args(control_args(target, paths, "check"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());

    if !up {
        return Err(format!("the connection to {} is not up", target.label()));
    }

    Ok(build_args(target, paths, Session::Terminal))
}

/// [`ssh_args`] for a control operation on the multiplexed master (`check`, `exit`) instead of a session: the
/// operation goes before the destination, which is where ssh stops reading options.
pub fn control_args(target: &Target, paths: &SshPaths, operation: &str) -> Vec<String> {
    let mut args = ssh_args(target, paths);
    let at = args.len() - 2;

    args.splice(at..at, ["-O".to_owned(), operation.to_owned()]);

    args
}

/// The command the server's shell runs: a clean environment (no `SSH_AUTH_SOCK` unless forwarding is on, no
/// inherited variable of any kind) and the host binary. `binary` is trusted text; production passes
/// [`default_binary`].
pub fn remote_command(forward_agent: bool, binary: &str) -> String {
    let agent = if forward_agent {
        " SSH_AUTH_SOCK=\"$SSH_AUTH_SOCK\""
    } else {
        ""
    };

    format!("exec env -i HOME=\"$HOME\" PATH=/usr/bin:/bin LANG=C.UTF-8{agent} {binary} --stdio")
}

pub fn default_binary() -> String {
    format!("\"$HOME/.neore/host/{HOST_VERSION}/neore-host\"")
}

// ─── Host keys ───────────────────────────────────────────────────────────

/// One host key: its type (`ssh-ed25519`) and base64 blob.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostKey {
    pub blob: String,
    pub key_type: String,
}

impl HostKey {
    /// `SHA256:…`, the form `ssh-keygen -l` prints and a user compares.
    pub fn fingerprint(&self) -> String {
        match base64_decode(&self.blob) {
            Some(bytes) => format!("SHA256:{}", base64_encode_unpadded(&Sha256::digest(bytes))),
            None => "SHA256:(unreadable key)".to_owned(),
        }
    }

    /// `ED25519`, as ssh prints it beside a fingerprint.
    pub fn label(&self) -> String {
        match self.key_type.as_str() {
            "ssh-ed25519" => "ED25519".to_owned(),
            "ssh-rsa" => "RSA".to_owned(),
            "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521" => {
                "ECDSA".to_owned()
            }
            other => other.to_owned(),
        }
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);

    for byte in text.trim_end_matches('=').bytes() {
        buffer = (buffer << 6) | BASE64.iter().position(|&c| c == byte)? as u32;
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Some(out)
}

fn base64_encode_unpadded(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let group = chunk.iter().enumerate().fold(0u32, |acc, (index, byte)| {
            acc | (u32::from(*byte) << (16 - 8 * index))
        });

        for index in 0..=chunk.len() {
            out.push(BASE64[((group >> (18 - 6 * index)) & 63) as usize] as char);
        }
    }

    out
}

/// The keys `ssh-keyscan` reads from the server, without authenticating.
fn scan_keys(target: &Target) -> Result<Vec<HostKey>, String> {
    let output = Command::new("ssh-keyscan")
        .args([
            "-T",
            "10",
            "-p",
            &target.port.to_string(),
            "-t",
            "ed25519,ecdsa,rsa",
            "--",
        ])
        .arg(&target.address)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| format!("ssh-keyscan could not run: {error}"))?;
    let keys = parse_keys(&String::from_utf8_lossy(&output.stdout), None);

    if keys.is_empty() {
        return Err(format!(
            "{} presented no host key (is it reachable, and is it running an SSH server?)",
            target.label()
        ));
    }

    Ok(keys)
}

/// The keys in `text` (known_hosts lines: `names type blob`), those filed under `spec` when it is given.
fn parse_keys(text: &str, spec: Option<&str>) -> Vec<HostKey> {
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let names = fields.next()?;
            let key_type = fields.next()?;
            let blob = fields.next()?;

            (KEY_TYPES.contains(&key_type)
                && spec.is_none_or(|spec| names.split(',').any(|name| name == spec)))
            .then(|| HostKey {
                blob: blob.to_owned(),
                key_type: key_type.to_owned(),
            })
        })
        .collect()
}

/// The keys pinned for `spec`.
pub fn pinned_keys(paths: &SshPaths, spec: &str) -> Vec<HostKey> {
    parse_keys(
        &fs::read_to_string(&paths.known_hosts).unwrap_or_default(),
        Some(spec),
    )
}

/// Serializes our own edits of the shared known-hosts file: a pin appends, a forget reads and replaces, and two
/// at once could restore a key that was just forgotten or lose one that was just trusted.
static KNOWN_HOSTS_EDIT: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn pin(paths: &SshPaths, spec: &str, key: &HostKey) -> io::Result<()> {
    let _edit = KNOWN_HOSTS_EDIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(dir) = paths.known_hosts.parent() {
        private_dir(dir)?;
    }

    let mut options = fs::OpenOptions::new();

    options.create(true).append(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.mode(0o600);
    }

    writeln!(
        options.open(&paths.known_hosts)?,
        "{spec} {} {}",
        key.key_type,
        key.blob
    )
}

/// Drops every pinned key of `spec`, so the next connection asks again. The user's way to accept a key that
/// changed on purpose.
pub fn forget_keys(paths: &SshPaths, spec: &str) -> io::Result<()> {
    let _edit = KNOWN_HOSTS_EDIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let text = match fs::read_to_string(&paths.known_hosts) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let kept: String = text
        .lines()
        .filter(|line| {
            line.split_whitespace()
                .next()
                .is_none_or(|names| !names.split(',').any(|name| name == spec))
        })
        .map(|line| format!("{line}\n"))
        .collect();
    let temporary = paths.known_hosts.with_extension("tmp");

    fs::write(&temporary, kept)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    }

    fs::rename(temporary, &paths.known_hosts)
}

/// Why a connection did not happen, in the words the window shows.
#[derive(Debug)]
pub enum SshError {
    /// The pinned key and the presented one differ. Both fingerprints are carried.
    HostKeyChanged {
        pinned: Vec<String>,
        presented: Vec<String>,
        target: String,
    },
    /// The user did not trust the key on first use.
    HostKeyDeclined,
    Other(String),
}

impl fmt::Display for SshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SshError::HostKeyChanged {
                pinned,
                presented,
                target,
            } => write!(
                f,
                "The host key of {target} changed. Pinned: {}. Presented now: {}. Nothing was sent. If the server was reinstalled, remove the pinned key in the server's settings and connect again.",
                pinned.join(", "),
                presented.join(", ")
            ),
            SshError::HostKeyDeclined => f.write_str("the server's host key was not trusted"),
            SshError::Other(message) => f.write_str(message),
        }
    }
}

impl From<SshError> for String {
    fn from(error: SshError) -> Self {
        error.to_string()
    }
}

/// What the user is asked, answered by the engine's prompts or, in tests, by a script.
pub trait Interact: Send + Sync {
    /// First use: trust and pin this key?
    fn trust_key(&self, target: &Target, key: &HostKey) -> bool;
    /// A pinned server presents another key. The connection is refused; this only shows why.
    fn key_changed(&self, target: &Target, pinned: &[String], presented: &[String]);
    /// What ssh is prompting for (a key passphrase). `None` cancels.
    fn passphrase(&self, target: &Target, prompt: &str) -> Option<String>;
}

/// Pins the server's key after the user trusts it, or refuses a key that changed. Read before ssh runs; ssh then
/// enforces the same store itself.
fn check_host_key(
    target: &Target,
    paths: &SshPaths,
    interact: &dyn Interact,
) -> Result<(), SshError> {
    let spec = target.host_spec();
    let presented = scan_keys(target).map_err(SshError::Other)?;
    let pinned = pinned_keys(paths, &spec);

    if pinned.is_empty() {
        let offered = KEY_TYPES
            .iter()
            .find_map(|key_type| presented.iter().find(|key| key.key_type == *key_type))
            .ok_or_else(|| SshError::Other("the server offered no usable host key".into()))?;

        if !interact.trust_key(target, offered) {
            return Err(SshError::HostKeyDeclined);
        }

        return pin(paths, &spec, offered)
            .map_err(|error| SshError::Other(format!("the host key could not be saved: {error}")));
    }

    if presented.iter().any(|key| pinned.contains(key)) {
        return Ok(());
    }

    let fingerprints = |keys: &[HostKey]| {
        keys.iter()
            .map(|key| format!("{} ({})", key.fingerprint(), key.label()))
            .collect::<Vec<_>>()
    };
    let (pinned, presented) = (fingerprints(&pinned), fingerprints(&presented));

    interact.key_changed(target, &pinned, &presented);

    Err(SshError::HostKeyChanged {
        pinned,
        presented,
        target: target.label(),
    })
}

// ─── Passphrases ─────────────────────────────────────────────────────────

/// The `SSH_ASKPASS` program. It asks the desktop through two pipes (`NEORE_ASKPASS_DIR`) and prints the answer
/// on stdout for ssh, nothing else: no file, no log, no argument.
#[cfg(unix)]
const ASKPASS_SCRIPT: &str = r#"#!/bin/sh
[ -n "$NEORE_ASKPASS_DIR" ] || exit 1
prompt=$(printf '%s' "$1" | tr '\n\r' '  ')
printf '%s\n' "$prompt" > "$NEORE_ASKPASS_DIR/req" || exit 1
{ IFS= read -r status && IFS= read -r answer; } < "$NEORE_ASKPASS_DIR/res" || exit 1
[ "$status" = ok ] || exit 1
printf '%s\n' "$answer"
"#;

/// One connection's passphrase channel. Dropping it stops the thread and removes the pipes.
#[cfg(unix)]
struct Askpass {
    dir: PathBuf,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl Askpass {
    fn start(paths: &SshPaths, target: Target, interact: Arc<dyn Interact>) -> io::Result<Self> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        write_script(paths)?;

        let mut random = [0u8; 12];

        fs::File::open("/dev/urandom")?.read_exact(&mut random)?;

        let name: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let dir = paths.askpass_dir.join(name);

        private_dir(&dir)?;

        let open = |name: &str| -> io::Result<fs::File> {
            let path = dir.join(name);
            let c_path = CString::new(path.as_os_str().as_bytes())
                .map_err(|_| io::Error::other("path with a NUL"))?;

            // SAFETY: `c_path` is a valid NUL-terminated string for the whole call.
            if unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) } != 0 {
                return Err(io::Error::last_os_error());
            }

            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;

            // Read and write on one end: the pipe never reports end-of-file, whoever comes and goes.
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(path)
        };
        let (requests, mut replies) = (open("req")?, open("res")?);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            let mut requests = requests;
            let mut pending: Vec<u8> = Vec::new();

            while !stopped.load(Ordering::SeqCst) {
                let mut chunk = [0u8; 512];

                match requests.read(&mut chunk) {
                    Ok(read) if read > 0 => pending.extend_from_slice(&chunk[..read]),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() != io::ErrorKind::WouldBlock => break,
                    _ => {}
                }

                if let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                    let prompt = String::from_utf8_lossy(&pending[..end]).into_owned();

                    pending.clear();
                    // Anything left from an earlier run that never read its answer.
                    while matches!(replies.read(&mut chunk), Ok(read) if read > 0) {}

                    let reply = match interact.passphrase(&target, &prompt) {
                        Some(secret) if !secret.contains(['\n', '\r']) => {
                            format!("ok\n{secret}\n")
                        }
                        _ => "no\n\n".to_owned(),
                    };

                    let _ = replies.write_all(reply.as_bytes());
                } else if pending.len() > 4096 {
                    pending.clear();
                } else {
                    thread::sleep(Duration::from_millis(20));
                }
            }
        });

        Ok(Askpass {
            dir,
            stop,
            thread: Some(thread),
        })
    }

    fn environment(&self, paths: &SshPaths) -> Vec<(&'static str, std::ffi::OsString)> {
        vec![
            ("SSH_ASKPASS", paths.askpass_script.clone().into_os_string()),
            ("SSH_ASKPASS_REQUIRE", "force".into()),
            ("NEORE_ASKPASS_DIR", self.dir.clone().into_os_string()),
        ]
    }
}

#[cfg(unix)]
impl Drop for Askpass {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);

        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }

        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
fn next_temporary() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[cfg(unix)]
fn write_script(paths: &SshPaths) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if fs::read_to_string(&paths.askpass_script).is_ok_and(|text| text == ASKPASS_SCRIPT) {
        return Ok(());
    }

    // A name of its own per installation: two connections starting together must not write and rename one file.
    let temporary = paths.askpass_script.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        next_temporary()
    ));

    fs::write(&temporary, ASKPASS_SCRIPT)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700))?;
    fs::rename(temporary, &paths.askpass_script)
}

// ─── The connection ──────────────────────────────────────────────────────

/// `neore-host`'s first frame.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub platform: String,
    pub protocol: u32,
    pub sandbox: RemoteSandbox,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RemoteSandbox {
    pub available: bool,
    pub detail: String,
}

/// What the server reports for one action (`actions::Outcome` on the host's side).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOutcome {
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub output: Option<String>,
    pub status: String,
    #[serde(default)]
    pub truncated: bool,
}

type Reply = Result<RemoteOutcome, String>;
type Pending = Arc<Mutex<HashMap<u64, Sender<Reply>>>>;

/// What the engine needs of a connection to a server: the seam that lets its tests stand in for ssh.
pub trait HostLink: Send + Sync {
    /// Ends this session only. Other sessions to the same server share its master and are left running.
    fn close(&self);
    /// Ends the multiplexed master of this server and with it every session on it: for when none is wanted.
    fn exit_master(&self);
    fn hello(&self) -> &Hello;
    fn is_alive(&self) -> bool;
    /// Where the session goes; `None` for a stand-in that goes nowhere.
    fn target(&self) -> Option<&Target>;
    /// Runs one approved action (`host::RunParams` as JSON) and waits at most `wait` for its answer.
    fn run(&self, params: &Value, wait: Duration) -> Result<RemoteOutcome, String>;
}

/// A live `neore-host --stdio` behind an `ssh` child.
pub struct HostConnection {
    alive: Arc<AtomicBool>,
    child: Mutex<Child>,
    exit_master: Vec<String>,
    hello: Hello,
    next_id: AtomicU64,
    pending: Pending,
    stdin: Mutex<ChildStdin>,
    stderr: Arc<Mutex<String>>,
    target: Target,
}

impl HostConnection {
    /// Pins the key (asking on first use), starts ssh and waits for the host's handshake. `binary` is the remote
    /// path of the host, normally [`default_binary`].
    pub fn connect(
        target: &Target,
        paths: &SshPaths,
        binary: &str,
        interact: &Arc<dyn Interact>,
    ) -> Result<HostConnection, SshError> {
        target.validate().map_err(SshError::Other)?;
        paths.prepare().map_err(SshError::Other)?;
        check_host_key(target, paths, interact.as_ref())?;

        let mut command = Command::new("ssh");

        command
            .args(ssh_args(target, paths))
            .arg(remote_command(target.forward_agent, binary))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(unix)]
        let askpass = Askpass::start(paths, target.clone(), Arc::clone(interact))
            .map_err(|error| SshError::Other(format!("the passphrase channel failed: {error}")))?;

        #[cfg(unix)]
        command.envs(askpass.environment(paths));

        let mut child = command
            .spawn()
            .map_err(|error| SshError::Other(format!("ssh could not run: {error}")))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut stderr_pipe = child.stderr.take().expect("piped stderr");
        let stderr = Arc::new(Mutex::new(String::new()));
        let log = Arc::clone(&stderr);

        thread::spawn(move || {
            let mut chunk = [0u8; 1024];

            while let Ok(read) = stderr_pipe.read(&mut chunk) {
                if read == 0 {
                    break;
                }

                let mut tail = log.lock().unwrap();

                tail.push_str(&String::from_utf8_lossy(&chunk[..read]));

                if tail.len() > 4096 {
                    let keep = tail.len() - 4096;
                    let cut = (keep..tail.len())
                        .find(|i| tail.is_char_boundary(*i))
                        .unwrap_or(0);

                    tail.drain(..cut);
                }
            }
        });

        let alive = Arc::new(AtomicBool::new(true));
        let pending: Pending = Arc::default();
        let (hello_sender, hello_receiver) = channel::<Result<Hello, String>>();
        let reader = (Arc::clone(&alive), Arc::clone(&pending));

        thread::spawn(move || {
            let (alive, pending) = reader;
            let hello = read_frame(&mut stdout)
                .map_err(|error| error.to_string())
                .and_then(|frame| frame.ok_or_else(|| "the connection closed".to_owned()))
                .and_then(|frame| {
                    serde_json::from_slice::<Value>(&frame).map_err(|error| error.to_string())
                })
                .and_then(|value| {
                    if value["kind"] == "hello" {
                        serde_json::from_value::<Hello>(value).map_err(|error| error.to_string())
                    } else {
                        Err("the host did not start with a handshake".into())
                    }
                });
            let started = hello.is_ok();

            let _ = hello_sender.send(hello);

            if started {
                while let Ok(Some(frame)) = read_frame(&mut stdout) {
                    route(&pending, &frame);
                }
            }

            alive.store(false, Ordering::SeqCst);
            // Dropping the senders wakes every request still waiting.
            pending.lock().unwrap().clear();
        });

        let started = Instant::now();
        let hello = loop {
            match hello_receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(hello)) => break Ok(hello),
                Ok(Err(reason)) => break Err(reason),
                Err(_) if started.elapsed() > CONNECT_PATIENCE => {
                    break Err("the server did not answer in time".to_owned());
                }
                Err(_) => {
                    if let Ok(Some(_)) = child.try_wait() {
                        // The reader is about to report the same thing; give it a moment.
                        if let Ok(result) = hello_receiver.recv_timeout(Duration::from_secs(2)) {
                            break result;
                        }

                        break Err("ssh ended".to_owned());
                    }
                }
            }
        };

        #[cfg(unix)]
        drop(askpass);

        let hello = match hello {
            Ok(hello) if hello.protocol == PROTOCOL_VERSION => hello,
            Ok(hello) => {
                let _ = child.kill();
                let _ = child.wait();

                return Err(SshError::Other(format!(
                    "the host speaks protocol {} and this app speaks {PROTOCOL_VERSION}",
                    hello.protocol
                )));
            }
            Err(reason) => {
                let _ = child.kill();
                let _ = child.wait();

                return Err(SshError::Other(explain(target, &reason, &stderr)));
            }
        };

        Ok(HostConnection {
            alive,
            child: Mutex::new(child),
            exit_master: control_args(target, paths, "exit"),
            hello,
            next_id: AtomicU64::new(1),
            pending,
            stderr,
            stdin: Mutex::new(stdin),
            target: target.clone(),
        })
    }

    /// The tail of what ssh and the host printed on stderr.
    pub fn log_tail(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    pub fn target(&self) -> &Target {
        &self.target
    }
}

impl HostLink for HostConnection {
    fn hello(&self) -> &Hello {
        &self.hello
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn run(&self, params: &Value, wait: Duration) -> Result<RemoteOutcome, String> {
        if !self.is_alive() {
            return Err("the connection to the server was lost".into());
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = channel();
        let frame = json!({ "kind": "request", "id": id, "op": "run", "params": params });

        self.pending.lock().unwrap().insert(id, sender);

        let sent = serde_json::to_vec(&frame)
            .map_err(|error| error.to_string())
            .and_then(|bytes| {
                write_frame(&mut *self.stdin.lock().unwrap(), &bytes)
                    .map_err(|error| error.to_string())
            });

        if let Err(error) = sent {
            self.pending.lock().unwrap().remove(&id);

            return Err(format!("the request could not be sent: {error}"));
        }

        match receiver.recv_timeout(wait) {
            Ok(reply) => reply,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);

                Err(if self.is_alive() {
                    "the server did not answer in time".to_owned()
                } else {
                    "the connection to the server was lost".to_owned()
                })
            }
        }
    }

    fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);

        let mut child = self.child.lock().unwrap();

        let _ = child.kill();
        let _ = child.wait();
    }

    fn target(&self) -> Option<&Target> {
        Some(&self.target)
    }

    fn exit_master(&self) {
        if cfg!(unix) {
            let _ = Command::new("ssh")
                .args(&self.exit_master)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

impl Drop for HostConnection {
    fn drop(&mut self) {
        self.close();
    }
}

/// Hands a response frame to the request waiting for it; events and strays are dropped.
fn route(pending: &Pending, frame: &[u8]) {
    let Ok(value) = serde_json::from_slice::<Value>(frame) else {
        return;
    };

    if value["kind"] != "response" {
        return;
    }

    let Some(sender) = value["id"]
        .as_u64()
        .and_then(|id| pending.lock().unwrap().remove(&id))
    else {
        return;
    };
    let reply = if value["ok"] == true {
        serde_json::from_value::<RemoteOutcome>(value["result"].clone())
            .map_err(|error| format!("the host's answer was not understood: {error}"))
    } else {
        Err(value["error"]
            .as_str()
            .unwrap_or("the host refused the request")
            .to_owned())
    };

    let _ = sender.send(reply);
}

/// What the user needs to read when a connection failed, from what ssh said.
fn explain(target: &Target, reason: &str, stderr: &Mutex<String>) -> String {
    // The reader sees the stream end a moment before the stderr thread has everything.
    thread::sleep(Duration::from_millis(100));

    let said = stderr.lock().unwrap().trim().to_owned();
    let said = if said.is_empty() {
        reason.to_owned()
    } else {
        said
    };

    if said.contains("Permission denied") {
        return format!(
            "{} refused the login ({said}). Passwords and one-time codes are not supported yet: use a key or an SSH agent.",
            target.label()
        );
    }

    format!("could not connect to {}: {said}", target.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        Target {
            address: "build.example.com".into(),
            forward_agent: false,
            identity_file: None,
            port: 22,
            user: "deploy".into(),
        }
    }

    /// An absolute path on the platform the tests run on: `/x` is relative on Windows.
    const ABSOLUTE_KEY: &str = if cfg!(windows) {
        "C:\\Users\\me\\.ssh\\id"
    } else {
        "/home/me/.ssh/id"
    };

    fn paths() -> SshPaths {
        SshPaths::under(Path::new("/data"), None)
    }

    #[cfg(unix)]
    #[test]
    fn servers_with_one_destination_and_two_keys_do_not_share_a_master() {
        let control_path = |identity: Option<&str>| {
            let mut one = target();

            one.identity_file = identity.map(str::to_owned);

            option_values(&ssh_args(&one, &paths()))
                .into_iter()
                .find(|option| option.starts_with("ControlPath="))
                .map(str::to_owned)
                .unwrap()
        };
        let first = control_path(Some("/home/me/.ssh/one"));
        let second = control_path(Some("/home/me/.ssh/two"));

        assert_ne!(first, second);
        assert_ne!(first, control_path(None));
        assert_eq!(first, control_path(Some("/home/me/.ssh/one")));
    }

    fn option_values(args: &[String]) -> Vec<&str> {
        args.windows(2)
            .filter(|pair| pair[0] == "-o")
            .map(|pair| pair[1].as_str())
            .collect()
    }

    #[test]
    fn ssh_runs_with_every_option_the_plan_names_and_no_config() {
        let args = ssh_args(&target(), &paths());
        let options = option_values(&args);
        let known_hosts = format!(
            "UserKnownHostsFile=\"{}\"",
            Path::new("/data").join("ssh").join("known_hosts").display()
        );
        let global_hosts = format!("GlobalKnownHostsFile={NULL_DEVICE}");

        for expected in [
            "StrictHostKeyChecking=yes",
            known_hosts.as_str(),
            global_hosts.as_str(),
            "UpdateHostKeys=no",
            "CheckHostIP=no",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "ForwardAgent=no",
            "ClearAllForwardings=yes",
        ] {
            assert!(
                options.contains(&expected),
                "{expected} is missing: {options:?}"
            );
        }

        #[cfg(unix)]
        for expected in [
            "ControlMaster=auto",
            "ControlPath=\"/data/ssh/cm/%C\"",
            "ControlPersist=10m",
        ] {
            assert!(options.contains(&expected), "{expected} is missing");
        }

        // Without a tty, without the user's or the system's config, and no option can be read from the data.
        assert!(args.windows(2).any(|pair| pair == ["-F", NULL_DEVICE]));
        assert!(args.contains(&"-T".to_owned()));
        assert!(!options.iter().any(|option| option.starts_with("BatchMode")));
        assert_eq!(&args[args.len() - 2..], ["--", "build.example.com"]);
        assert!(args.windows(2).any(|pair| pair == ["-l", "deploy"]));
    }

    #[test]
    fn a_terminal_is_a_tty_that_cannot_open_a_connection_or_a_listener() {
        let mut target = target();

        target.forward_agent = true;

        let args = build_args(&target, &paths(), Session::Terminal);
        let options = option_values(&args);
        let known_hosts = format!(
            "UserKnownHostsFile=\"{}\"",
            Path::new("/data").join("ssh").join("known_hosts").display()
        );
        let global_hosts = format!("GlobalKnownHostsFile={NULL_DEVICE}");

        for expected in [
            "StrictHostKeyChecking=yes",
            known_hosts.as_str(),
            global_hosts.as_str(),
            "ClearAllForwardings=yes",
            "PasswordAuthentication=no",
            // Nothing is asked on a terminal, and the agent is not handed to a server's shell.
            "BatchMode=yes",
            "ForwardAgent=no",
            // Fails closed when the master is gone, instead of connecting by itself.
            "ProxyCommand=false",
        ] {
            assert!(
                options.contains(&expected),
                "{expected} is missing: {options:?}"
            );
        }

        #[cfg(unix)]
        {
            assert!(options.contains(&"ControlMaster=no"));
            assert!(!options.contains(&"ControlMaster=auto"));
        }

        // A tty, no escape character (`~C` would open ssh's command line and its forwards), no remote command.
        assert!(args.contains(&"-t".to_owned()));
        assert!(!args.contains(&"-T".to_owned()));
        assert!(args.windows(2).any(|pair| pair == ["-e", "none"]));
        assert!(args.windows(2).any(|pair| pair == ["-F", NULL_DEVICE]));
        assert_eq!(&args[args.len() - 2..], ["--", "build.example.com"]);
    }

    #[test]
    fn a_control_operation_goes_before_the_destination() {
        let args = control_args(&target(), &paths(), "exit");

        assert_eq!(
            &args[args.len() - 4..],
            ["-O", "exit", "--", "build.example.com"]
        );
    }

    #[test]
    fn a_key_file_is_the_only_identity_and_forwarding_is_opt_in() {
        let mut target = target();

        target.identity_file = Some("/home/me/.ssh/neore".into());
        target.forward_agent = true;

        let args = ssh_args(&target, &paths());

        assert!(args
            .windows(2)
            .any(|pair| pair == ["-i", "/home/me/.ssh/neore"]));
        assert!(option_values(&args).contains(&"IdentitiesOnly=yes"));
        assert!(option_values(&args).contains(&"ForwardAgent=yes"));
    }

    #[test]
    fn a_path_with_a_space_stays_one_option_value() {
        let paths = SshPaths::under(
            Path::new("/Users/me/Library/Application Support/Neore"),
            None,
        );
        let args = ssh_args(&target(), &paths);

        let known_hosts = format!(
            "UserKnownHostsFile=\"{}\"",
            Path::new("/Users/me/Library/Application Support/Neore")
                .join("ssh")
                .join("known_hosts")
                .display()
        );

        assert!(option_values(&args).contains(&known_hosts.as_str()));
    }

    #[test]
    fn the_remote_command_starts_from_an_empty_environment() {
        let command = remote_command(false, &default_binary());

        assert_eq!(
            command,
            format!("exec env -i HOME=\"$HOME\" PATH=/usr/bin:/bin LANG=C.UTF-8 \"$HOME/.neore/host/{HOST_VERSION}/neore-host\" --stdio")
        );
        assert!(!command.contains("SSH_AUTH_SOCK"));
        assert!(remote_command(true, "x").contains("SSH_AUTH_SOCK=\"$SSH_AUTH_SOCK\""));
    }

    #[test]
    fn nothing_that_reads_as_an_option_is_accepted() {
        let with = |change: fn(&mut Target)| {
            let mut target = target();

            change(&mut target);
            target.validate()
        };

        assert!(with(|_| {}).is_ok());
        assert!(with(|t| t.address = "-oProxyCommand=touch".into()).is_err());
        assert!(with(|t| t.address = "a b".into()).is_err());
        assert!(with(|t| t.address = "host;rm".into()).is_err());
        assert!(with(|t| t.address = "user@host".into()).is_err());
        assert!(with(|t| t.address = "::1".into()).is_ok());
        assert!(with(|t| t.user = "-oProxyCommand=x".into()).is_err());
        assert!(with(|t| t.user = "a b".into()).is_err());
        assert!(with(|t| t.port = 0).is_err());
        assert!(with(|t| t.identity_file = Some("relative/key".into())).is_err());
        assert!(with(|t| t.identity_file = Some("/k\"ey".into())).is_err());
        assert!(with(|t| t.identity_file = Some(ABSOLUTE_KEY.into())).is_ok());
    }

    #[test]
    fn a_non_default_port_is_filed_the_way_known_hosts_files_it() {
        let mut target = target();

        assert_eq!(target.host_spec(), "build.example.com");
        target.port = 2222;
        assert_eq!(target.host_spec(), "[build.example.com]:2222");
    }

    #[test]
    fn control_sockets_stay_out_of_tmp_and_inside_the_socket_limit() {
        let deep = Path::new("/Users/someone/Library/Application Support/Neore Desktop Preview");
        let home = Path::new("/Users/someone");
        let moved = SshPaths::under(deep, Some(home));

        assert_eq!(moved.control_dir, home.join(".neore").join("cm"));
        assert!(moved.control_dir.as_os_str().len() + CONTROL_PATH_MARGIN <= SOCKET_PATH_LIMIT);
        assert_eq!(
            SshPaths::under(Path::new("/data"), Some(home)).control_dir,
            Path::new("/data").join("ssh").join("cm")
        );
    }

    /// The fingerprint of an ed25519 key, as `ssh-keygen -lf` printed it.
    #[test]
    fn a_fingerprint_is_the_sha256_of_the_key_in_ssh_keygens_form() {
        let key = HostKey {
            blob: "AAAAC3NzaC1lZDI1NTE5AAAAIEP+YmaNKEEP9QIxWrDvG/5Np6vN9WsgVWIYBUUjdBTH".into(),
            key_type: "ssh-ed25519".into(),
        };

        assert_eq!(
            key.fingerprint(),
            "SHA256:S7+fpMdBp5qAGC8UrcuUdntN8bLq3B4WWB2/s7u50MM"
        );
        assert_eq!(key.label(), "ED25519");
    }

    #[test]
    fn pinned_keys_are_read_for_the_host_they_were_filed_under() {
        let text = "# comment\nhost-a ssh-ed25519 AAAA\n[host-b]:2222,10.0.0.2 ssh-rsa BBBB\nhost-a ssh-dss CCCC\n";

        assert_eq!(
            parse_keys(text, Some("host-a")),
            vec![HostKey {
                blob: "AAAA".into(),
                key_type: "ssh-ed25519".into()
            }]
        );
        assert_eq!(parse_keys(text, Some("[host-b]:2222")).len(), 1);
        assert!(parse_keys(text, Some("host-c")).is_empty());
        assert_eq!(parse_keys(text, None).len(), 2);
    }

    #[test]
    fn every_ecdsa_curve_ssh_scans_for_can_be_pinned() {
        let text = "h ecdsa-sha2-nistp256 A\nh ecdsa-sha2-nistp384 B\nh ecdsa-sha2-nistp521 C\n";
        let keys = parse_keys(text, Some("h"));

        assert_eq!(keys.len(), 3);
        assert!(keys.iter().all(|key| key.label() == "ECDSA"));
    }

    #[test]
    fn a_pin_is_owner_only_and_forgetting_it_leaves_the_others() {
        let dir = std::env::temp_dir().join(format!("neore-ssh-pin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paths = SshPaths::under(&dir, None);
        let key = |blob: &str| HostKey {
            blob: blob.into(),
            key_type: "ssh-ed25519".into(),
        };

        pin(&paths, "host-a", &key("AAAA")).unwrap();
        pin(&paths, "host-b", &key("BBBB")).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                fs::metadata(&paths.known_hosts)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(paths.known_hosts.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }

        forget_keys(&paths, "host-a").unwrap();

        assert!(pinned_keys(&paths, "host-a").is_empty());
        assert_eq!(pinned_keys(&paths, "host-b"), vec![key("BBBB")]);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_changed_key_error_carries_both_fingerprints() {
        let message = SshError::HostKeyChanged {
            pinned: vec!["SHA256:old (ED25519)".into()],
            presented: vec!["SHA256:new (ED25519)".into()],
            target: "deploy@build:22".into(),
        }
        .to_string();

        assert!(message.contains("SHA256:old") && message.contains("SHA256:new"));
    }

    #[test]
    fn a_response_frame_reaches_the_request_it_answers() {
        let pending: Pending = Arc::default();
        let (sender, receiver) = channel();

        pending.lock().unwrap().insert(7, sender);
        route(&pending, br#"{"kind":"event","name":"x","data":{}}"#);
        route(
            &pending,
            br#"{"kind":"response","id":8,"ok":true,"result":{"status":"completed"}}"#,
        );
        route(
            &pending,
            br#"{"kind":"response","id":7,"ok":true,"result":{"status":"completed","output":"hi","truncated":false}}"#,
        );

        let outcome = receiver.try_recv().unwrap().unwrap();

        assert_eq!(
            (outcome.status.as_str(), outcome.output.as_deref()),
            ("completed", Some("hi"))
        );
        assert!(pending.lock().unwrap().is_empty());
    }
}
