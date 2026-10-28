//! The SSH transport against a real `sshd`: a throwaway server on 127.0.0.1, run as the current user with its own
//! host key and a throwaway client key. Nothing leaves the machine.
//!
//! The tests skip when there is no `sshd` (the macOS and Ubuntu runners have one); `NEORE_REQUIRE_SSHD=1` turns
//! a missing one into a failure, so a runner that loses it cannot quietly stop testing.
#![cfg(all(unix, feature = "keychain"))]

#[allow(dead_code)]
#[path = "common/vectors.rs"]
mod vectors;

use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use device_core::install::{self, target_for_uname, Bundle, Installed, Remote, Root};
use device_core::launch::Reaped;
use device_core::lifecycle::{Keep, ATTEMPT_PATIENCE};
use device_core::ssh::{
    control_args, forget_keys, pinned_keys, terminal_args, HostConnection, HostKey, HostLink,
    Interact, SshError, SshPaths, Target, HOST_VERSION,
};
use serde_json::json;

const PASSPHRASE: &str = "correct horse battery staple 7f3a";

/// Answers what ssh and the pinning ask, and keeps what it was asked.
#[derive(Default)]
struct Scripted {
    changed: Mutex<Vec<(Vec<String>, Vec<String>)>>,
    offered: Mutex<Vec<String>>,
    passphrase: Option<String>,
    prompts: Mutex<Vec<String>>,
    trust: bool,
    trusted: AtomicUsize,
}

impl Interact for Scripted {
    fn trust_key(&self, _target: &Target, key: &HostKey) -> bool {
        self.offered.lock().unwrap().push(key.fingerprint());
        self.trusted.fetch_add(1, Ordering::SeqCst);
        self.trust
    }

    fn key_changed(&self, _target: &Target, pinned: &[String], presented: &[String]) {
        self.changed
            .lock()
            .unwrap()
            .push((pinned.to_vec(), presented.to_vec()));
    }

    fn passphrase(&self, _target: &Target, prompt: &str) -> Option<String> {
        self.prompts.lock().unwrap().push(prompt.to_owned());
        self.passphrase.clone()
    }
}

fn trusting() -> Arc<Scripted> {
    Arc::new(Scripted {
        trust: true,
        ..Scripted::default()
    })
}

fn sshd_binary() -> Option<PathBuf> {
    let found = [
        "/usr/sbin/sshd",
        "/usr/local/sbin/sshd",
        "/opt/homebrew/sbin/sshd",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.exists());

    assert!(
        found.is_some() || std::env::var_os("NEORE_REQUIRE_SSHD").is_none(),
        "NEORE_REQUIRE_SSHD is set but there is no sshd on this machine"
    );

    found
}

fn run(program: &str, args: &[&str]) -> String {
    let output = Command::new(program).args(args).output().unwrap();

    // The arguments are left out of the message: one of them can be a key passphrase.
    assert!(output.status.success(), "{program} failed");

    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn keygen(file: &Path, passphrase: &str) {
    run(
        "ssh-keygen",
        &[
            "-q",
            "-t",
            "ed25519",
            "-N",
            passphrase,
            "-f",
            &file.to_string_lossy(),
        ],
    );
}

fn free_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// The fingerprint `ssh-keygen -l` prints for a public key file.
fn keygen_fingerprint(public_key: &Path) -> String {
    run("ssh-keygen", &["-l", "-f", &public_key.to_string_lossy()])
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned()
}

/// Whether this sshd knows `PerSourcePenalties` (OpenSSH 9.8+). Left on, it refuses connections from 127.0.0.1 for
/// a while after sessions end abruptly, which these tests do on purpose; an older sshd would refuse to start with
/// the keyword in its config, so it is probed once per process with the first server's host key.
fn disables_source_penalties(sshd: &Path, dir: &Path) -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();

    *SUPPORTED.get_or_init(|| {
        let probe = dir.join("sshd_probe_config");

        fs::write(
            &probe,
            format!(
                "HostKey {}/host_key\nPerSourcePenalties no\n",
                dir.display()
            ),
        )
        .unwrap();

        let output = Command::new(sshd)
            .arg("-t")
            .arg("-f")
            .arg(&probe)
            .output()
            .unwrap();
        let complaint = String::from_utf8_lossy(&output.stderr);

        output.status.success() || !complaint.contains("PerSourcePenalties")
    })
}

/// A running throwaway sshd and the files around it. A short path under `/tmp` keeps the control socket inside
/// the Unix socket limit; the product itself never uses `/tmp`.
struct Server {
    child: Child,
    dir: PathBuf,
    port: u16,
}

impl Server {
    fn start(sshd: &Path, name: &str) -> Server {
        let dir = PathBuf::from(format!("/tmp/ns-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // The host key and two client keys: one without a passphrase, one with.
        keygen(&dir.join("host_key"), "");
        keygen(&dir.join("client"), "");
        keygen(&dir.join("client_enc"), PASSPHRASE);

        let authorized = format!(
            "{}\n{}\n",
            fs::read_to_string(dir.join("client.pub")).unwrap().trim(),
            fs::read_to_string(dir.join("client_enc.pub"))
                .unwrap()
                .trim()
        );

        fs::write(dir.join("authorized_keys"), authorized).unwrap();

        // What the remote command runs: it records its own environment, then becomes the real host.
        let wrapper = dir.join("host-wrapper.sh");

        fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nenv > '{dir}/remote-env.txt'\nNEORE_HOST_RUN_DIR='{dir}/run'\nexport NEORE_HOST_RUN_DIR\nexec '{host}' \"$@\"\n",
                dir = dir.display(),
                host = env!("CARGO_BIN_EXE_neore-host")
            ),
        )
        .unwrap();
        run("chmod", &["700", &wrapper.to_string_lossy()]);

        let port = free_port();
        let user = run("id", &["-un"]);

        fs::write(
            dir.join("sshd_config"),
            format!(
                "Port {port}\nListenAddress 127.0.0.1\nHostKey {dir}/host_key\nAuthorizedKeysFile {dir}/authorized_keys\nPidFile {dir}/sshd.pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nStrictModes no\nAllowUsers {user}\nLogLevel INFO\nMaxStartups 100\n{penalties}",
                dir = dir.display(),
                penalties = if disables_source_penalties(sshd, &dir) {
                    "PerSourcePenalties no\n"
                } else {
                    ""
                }
            ),
        )
        .unwrap();

        let log = fs::File::create(dir.join("sshd.log")).unwrap();
        let mut child = Command::new(sshd)
            .args(["-D", "-e", "-f"])
            .arg(dir.join("sshd_config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);

        while TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err() {
            assert!(
                Instant::now() < deadline && child.try_wait().unwrap().is_none(),
                "sshd did not start:\n{}",
                fs::read_to_string(dir.join("sshd.log")).unwrap_or_default()
            );
            thread::sleep(Duration::from_millis(50));
        }

        Server { child, dir, port }
    }

    fn target(&self, key: &str) -> Target {
        Target {
            address: "127.0.0.1".into(),
            forward_agent: false,
            identity_file: Some(self.dir.join(key).to_string_lossy().into_owned()),
            port: self.port,
            user: run("id", &["-un"]),
        }
    }

    /// The client's data dir: pins, control sockets and passphrase pipes.
    fn paths(&self, name: &str) -> SshPaths {
        SshPaths::under(&self.dir.join(name), None)
    }

    fn binary(&self) -> String {
        format!("'{}'", self.dir.join("host-wrapper.sh").display())
    }

    /// Where the hosts started through the wrapper file their launches.
    fn run_dir(&self) -> PathBuf {
        self.dir.join("run")
    }

    fn remote_env(&self) -> String {
        fs::read_to_string(self.dir.join("remote-env.txt")).unwrap_or_default()
    }

    fn spec(&self) -> String {
        format!("[127.0.0.1]:{}", self.port)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();

        // The log goes with the directory: a failing test prints it first, so a refused connection explains itself.
        if thread::panicking() {
            eprintln!(
                "--- sshd log ({}) ---\n{}",
                self.dir.display(),
                fs::read_to_string(self.dir.join("sshd.log")).unwrap_or_default()
            );
        }

        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The environment is the process's, so the tests that set `SSH_AUTH_SOCK` for a connect take turns.
static CLIENT_ENVIRONMENT: Mutex<()> = Mutex::new(());

fn connect(
    server: &Server,
    target: &Target,
    paths: &SshPaths,
    interact: &Arc<Scripted>,
) -> Result<HostConnection, SshError> {
    // A client that carries an agent socket: the server must not see it.
    connect_with_agent(
        server,
        target,
        paths,
        interact,
        &server.dir.join("no-agent.sock"),
    )
}

fn connect_with_agent(
    server: &Server,
    target: &Target,
    paths: &SshPaths,
    interact: &Arc<Scripted>,
    agent: &Path,
) -> Result<HostConnection, SshError> {
    let _turn = CLIENT_ENVIRONMENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    std::env::set_var("SSH_AUTH_SOCK", agent);

    let interact: Arc<dyn Interact> = Arc::clone(interact) as Arc<dyn Interact>;

    HostConnection::connect(target, paths, &server.binary(), &interact)
}

/// Ends the session and the master it rode, so no ssh outlives the test. `ssh -O exit` only asks the master to
/// stop, so this waits until it is gone: a later ssh to the same target would otherwise hit the dying control
/// socket and fail with 255.
fn finish(connection: &HostConnection, target: &Target, paths: &SshPaths) {
    connection.close();
    connection.exit_master();
    wait_for_master_exit(target, paths);
}

fn wait_for_master_exit(target: &Target, paths: &SshPaths) {
    let deadline = Instant::now() + Duration::from_secs(5);

    while master_is_running(target, paths) {
        assert!(
            Instant::now() < deadline,
            "the ssh master was still running 5s after `-O exit`"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

/// Whether the ssh control master for `target` is up, asked of ssh itself.
fn master_is_running(target: &Target, paths: &SshPaths) -> bool {
    Command::new("ssh")
        .args(control_args(target, paths, "check"))
        .output()
        .unwrap()
        .status
        .success()
}

fn files_under(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();

        if path.is_dir() {
            files_under(&path, found);
        } else {
            found.push(path);
        }
    }
}

#[test]
fn it_connects_pins_the_key_and_runs_an_action_on_the_server() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "run");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let interact = trusting();
    let connection = connect(&server, &target, &paths, &interact).unwrap();

    assert!(connection.hello().protocol >= 1);
    assert_eq!(
        connection.hello().platform,
        device_core::actions::platform()
    );

    // First use asked once, offered the key the server really has, and pinned exactly that.
    let expected = keygen_fingerprint(&server.dir.join("host_key.pub"));

    assert_eq!(interact.trusted.load(Ordering::SeqCst), 1);
    assert_eq!(interact.offered.lock().unwrap().as_slice(), [expected]);
    assert_eq!(pinned_keys(&paths, &server.spec()).len(), 1);

    let root = vectors::fixture("ssh");
    let params = json!({ "tool": "fs_list", "input": { "path": root }, "roots": [root], "remainingMs": 60_000 });
    let outcome = connection.run(&params, Duration::from_secs(30)).unwrap();

    assert_eq!(outcome.status, "completed");
    assert!(outcome.output.unwrap().contains("a.txt"));

    // The remote process started from nothing: the client's agent socket and the ssh session variables are absent.
    let environment = server.remote_env();

    assert!(environment.contains("HOME="), "{environment}");
    assert!(environment.contains("PATH=/usr/bin:/bin"), "{environment}");
    assert!(environment.contains("LANG=C.UTF-8"), "{environment}");

    for leaked in [
        "SSH_AUTH_SOCK",
        "SSH_CONNECTION",
        "SSH_CLIENT",
        "NEORE_ASKPASS_DIR",
        "SSH_ASKPASS",
    ] {
        assert!(
            !environment.contains(leaked),
            "{leaked} reached the server:\n{environment}"
        );
    }

    finish(&connection, &target, &paths);
}

#[test]
fn a_key_that_was_not_trusted_is_never_pinned_and_nothing_runs() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "decline");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let interact = Arc::new(Scripted::default());

    assert!(matches!(
        connect(&server, &target, &paths, &interact),
        Err(SshError::HostKeyDeclined)
    ));
    assert!(pinned_keys(&paths, &server.spec()).is_empty());
    assert!(server.remote_env().is_empty());
}

#[test]
fn a_changed_host_key_is_refused_with_both_fingerprints_and_ssh_never_runs() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "changed");
    let (target, paths) = (server.target("client"), server.paths("a"));

    // Pin a key the server does not have: what it presents now is a different one.
    keygen(&server.dir.join("other_key"), "");
    let other = fs::read_to_string(server.dir.join("other_key.pub")).unwrap();
    let mut fields = other.split_whitespace();
    let (key_type, blob) = (fields.next().unwrap(), fields.next().unwrap());

    fs::create_dir_all(paths.known_hosts.parent().unwrap()).unwrap();
    fs::write(
        &paths.known_hosts,
        format!("{} {key_type} {blob}\n", server.spec()),
    )
    .unwrap();

    let interact = trusting();
    let error = connect(&server, &target, &paths, &interact).err().unwrap();
    let pinned = keygen_fingerprint(&server.dir.join("other_key.pub"));
    let presented = keygen_fingerprint(&server.dir.join("host_key.pub"));

    let SshError::HostKeyChanged {
        pinned: old,
        presented: new,
        ..
    } = &error
    else {
        panic!("expected a changed key, got {error}");
    };

    assert!(old.iter().any(|line| line.contains(&pinned)), "{old:?}");
    assert!(new.iter().any(|line| line.contains(&presented)), "{new:?}");
    // The window was told, with both; there is no override and nothing was trusted or pinned over it.
    assert_eq!(interact.changed.lock().unwrap().len(), 1);
    assert_eq!(interact.trusted.load(Ordering::SeqCst), 0);
    assert_eq!(pinned_keys(&paths, &server.spec()).len(), 1);
    assert!(
        server.remote_env().is_empty(),
        "ssh ran against a server whose key changed"
    );
    assert!(error.to_string().contains(&pinned) && error.to_string().contains(&presented));

    // Forgetting the pin is the way back: the next connection asks again.
    forget_keys(&paths, &server.spec()).unwrap();
    assert!(connect(&server, &target, &paths, &interact).is_ok());
    assert_eq!(interact.trusted.load(Ordering::SeqCst), 1);
}

#[test]
fn a_passphrase_goes_through_the_helper_and_is_written_nowhere() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "askpass");
    let (target, paths) = (server.target("client_enc"), server.paths("a"));
    let interact = Arc::new(Scripted {
        passphrase: Some(PASSPHRASE.to_owned()),
        trust: true,
        ..Scripted::default()
    });
    let connection = connect(&server, &target, &paths, &interact).unwrap();

    assert!(
        interact
            .prompts
            .lock()
            .unwrap()
            .iter()
            .any(|prompt| prompt.to_lowercase().contains("passphrase")),
        "{:?}",
        interact.prompts.lock().unwrap()
    );

    // The phrase appears in no file the client keeps, in no log line, and the pipes are gone.
    let mut files = Vec::new();

    files_under(&server.dir.join("a"), &mut files);

    assert!(!files.is_empty(), "the scan found no files to look in");

    for file in &files {
        let bytes = fs::read(file).unwrap_or_default();

        assert!(
            !String::from_utf8_lossy(&bytes).contains(PASSPHRASE),
            "{} holds the passphrase",
            file.display()
        );
    }

    assert!(!connection.log_tail().contains(PASSPHRASE));
    assert!(!format!("{:?}", interact.prompts.lock().unwrap()).contains(PASSPHRASE));
    assert_eq!(
        fs::read_dir(&paths.askpass_dir).unwrap().count(),
        0,
        "the passphrase pipes were left behind"
    );
    assert_eq!(
        fs::metadata(&paths.askpass_script)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    finish(&connection, &target, &paths);
}

#[test]
fn a_cancelled_passphrase_fails_the_login_instead_of_hanging() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "cancel");
    let (target, paths) = (server.target("client_enc"), server.paths("a"));
    let interact = trusting();
    let started = Instant::now();
    let error = connect(&server, &target, &paths, &interact).err().unwrap();

    assert!(started.elapsed() < Duration::from_secs(60));
    assert!(
        error.to_string().contains("refused the login")
            || error.to_string().contains("could not connect"),
        "{error}"
    );
    assert!(!interact.prompts.lock().unwrap().is_empty());
}

#[test]
fn closing_one_session_leaves_the_others_and_the_master_alone() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "master");
    let (target, paths) = (server.target("client_enc"), server.paths("a"));
    let interact = Arc::new(Scripted {
        passphrase: Some(PASSPHRASE.to_owned()),
        trust: true,
        ..Scripted::default()
    });
    let first = connect(&server, &target, &paths, &interact).unwrap();
    let asked = interact.prompts.lock().unwrap().len();

    assert!(
        master_is_running(&target, &paths),
        "ssh left no control master to reuse"
    );

    // A second session rides the master: no new login, so the passphrase is not asked for again.
    let second = connect(&server, &target, &paths, &interact).unwrap();

    assert_eq!(interact.prompts.lock().unwrap().len(), asked);

    // Closing the first must not take the second down with it.
    first.close();
    drop(first);

    let root = vectors::fixture("ssh-shared");
    let params = json!({ "tool": "fs_list", "input": { "path": root }, "roots": [root], "remainingMs": 60_000 });

    assert_eq!(
        second.run(&params, Duration::from_secs(30)).unwrap().status,
        "completed"
    );
    assert!(
        master_is_running(&target, &paths),
        "closing a session ended the master"
    );

    finish(&second, &target, &paths);
    assert!(
        !master_is_running(&target, &paths),
        "ending the master left it running"
    );
}

/// Runs the terminal's ssh arguments with a remote command, on a forced tty (the test has none of its own).
fn terminal_ssh(args: &[String], remote: &str) -> Command {
    let mut command = Command::new("ssh");

    command
        .arg("-tt")
        .args(args)
        .arg(remote)
        .stdin(Stdio::null());

    command
}

#[test]
fn a_terminal_rides_the_open_connection_and_ends_with_it() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "terminal");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let interact = trusting();

    // No connection yet: no terminal, and nothing is started to make one.
    assert!(terminal_args(&target, &paths)
        .unwrap_err()
        .contains("is not up"));

    let connection = connect(&server, &target, &paths, &interact).unwrap();
    let args = terminal_args(&target, &paths).unwrap();
    let logins = || {
        fs::read_to_string(server.dir.join("sshd.log"))
            .unwrap_or_default()
            .matches("Accepted")
            .count()
    };
    let before = logins();

    assert_eq!(before, 1, "the connection's own login is not in sshd's log");

    // The shell on the server is the user's own, started from nothing the desktop sets: no agent socket, and the
    // session variables ssh itself adds are the only ones.
    let output = terminal_ssh(&args, "echo marker-$((6*7)); env")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&output.stdout);

    assert!(output.status.success(), "{text}");
    assert!(text.contains("marker-42"), "{text}");
    assert!(!text.contains("SSH_AUTH_SOCK"), "{text}");
    assert!(!text.contains("NEORE_"), "{text}");
    assert!(
        interact.prompts.lock().unwrap().is_empty(),
        "the terminal asked something"
    );

    // It rode the master: sshd saw no second login, and the key was not asked about again.
    assert_eq!(logins(), before);
    assert_eq!(interact.trusted.load(Ordering::SeqCst), 1);
    assert!(
        master_is_running(&target, &paths),
        "the terminal ended the master"
    );

    // A shell that is running when the connection ends ends with it, with ssh's connection-lost status.
    let mut shell = terminal_ssh(&args, "sleep 60").spawn().unwrap();

    thread::sleep(Duration::from_millis(500));
    finish(&connection, &target, &paths);

    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = shell.try_wait().unwrap() {
            break status;
        }

        assert!(
            Instant::now() < deadline,
            "the terminal outlived its connection"
        );
        thread::sleep(Duration::from_millis(50));
    };

    assert_eq!(status.code(), Some(255));

    // With the master gone the same arguments fail instead of opening a connection of their own.
    let alone = terminal_ssh(&args, "echo should-not-run").output().unwrap();

    assert!(!alone.status.success());
    assert!(!String::from_utf8_lossy(&alone.stdout).contains("should-not-run"));
    assert_eq!(logins(), before);
}

#[test]
fn a_declined_host_key_leaves_no_connection_for_a_terminal_to_ride() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "tdecl");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let interact = Arc::new(Scripted::default());

    assert!(matches!(
        connect(&server, &target, &paths, &interact),
        Err(SshError::HostKeyDeclined)
    ));
    assert_eq!(interact.trusted.load(Ordering::SeqCst), 1);
    assert!(terminal_args(&target, &paths).is_err());
    assert!(pinned_keys(&paths, &server.spec()).is_empty());
    assert!(server.remote_env().is_empty());
}

#[test]
fn a_data_folder_with_a_space_that_is_too_deep_for_a_socket_still_connects_over_the_short_one() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "deep");
    let home = server.dir.join("home");
    let data = server
        .dir
        .join("Application Support")
        .join("Neore Desktop Preview Build")
        .join("profiles");
    let paths = SshPaths::under(&data, Some(&home));

    // The folder the product would use does not fit a Unix socket, so the control socket moved under the home.
    assert_eq!(paths.control_dir, home.join(".neore").join("cm"));
    assert!(paths.known_hosts.starts_with(&data));
    assert!(paths.known_hosts.to_string_lossy().contains(' '));

    let target = server.target("client");
    let connection = connect(&server, &target, &paths, &trusting()).unwrap();

    assert!(master_is_running(&target, &paths));
    assert_eq!(pinned_keys(&paths, &server.spec()).len(), 1);

    let root = vectors::fixture("ssh");
    let params = json!({ "tool": "fs_list", "input": { "path": root }, "roots": [root], "remainingMs": 60_000 });
    let outcome = connection.run(&params, Duration::from_secs(30)).unwrap();

    assert_eq!(outcome.status, "completed");

    finish(&connection, &target, &paths);
    assert!(!master_is_running(&target, &paths));
}

// ─── Install and upgrade ─────────────────────────────────────────────────

/// The platform of this machine, as the install module names it.
fn local_triple() -> &'static str {
    target_for_uname(&run("uname", &["-sm"])).unwrap()
}

/// A bundle holding the real `neore-host` for this machine's platform (and nothing for any other), and a remote
/// root inside the server's folder: the tests must never write to the real `~/.neore`.
fn bundle_and_root(server: &Server, triple: &str) -> (Bundle, Root, Vec<u8>, String) {
    let folder = server.dir.join("bundle");
    let bytes = fs::read(env!("CARGO_BIN_EXE_neore-host")).unwrap();
    let sha256 = sha256_hex(&bytes);

    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("neore-host-test"), &bytes).unwrap();
    fs::write(
        folder.join("manifest.json"),
        json!({
            "version": HOST_VERSION,
            "targets": { triple: { "file": "neore-host-test", "sha256": sha256 } },
        })
        .to_string(),
    )
    .unwrap();

    let root = Root::dir(&server.dir.join("host-root").to_string_lossy()).unwrap();

    (Bundle::load(&folder).unwrap(), root, bytes, sha256)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn end_master(target: &Target, paths: &SshPaths) {
    let _ = Command::new("ssh")
        .args(control_args(target, paths, "exit"))
        .output();
}

/// Every file under the remote root that can be executed.
fn executables_under(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();

    files_under(root, &mut files);
    files.retain(|file| fs::metadata(file).unwrap().permissions().mode() & 0o111 != 0);

    files
}

fn temporaries_under(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();

    files_under(root, &mut files);
    files.retain(|file| file.to_string_lossy().contains("neore-host.tmp-"));

    files
}

/// Waits for the server to finish tidying after a dropped upload (its shell runs the cleanup after the channel closes).
fn wait_until_no_temporaries(root: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);

    while !temporaries_under(root).is_empty() {
        assert!(
            Instant::now() < deadline,
            "a temporary upload was left: {:?}",
            temporaries_under(root)
        );
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_bundled_host_installs_once_starts_and_a_second_install_uploads_nothing() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "install");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let (bundle, root, _, _) = bundle_and_root(&server, local_triple());
    let interact: Arc<dyn Interact> = trusting();
    let remote = Remote {
        interact: &interact,
        paths: &paths,
        target: &target,
    };

    assert_eq!(
        install::install(&remote, &bundle, &root).unwrap(),
        Installed::Uploaded
    );

    let installed = server
        .dir
        .join("host-root")
        .join(HOST_VERSION)
        .join("neore-host");

    assert_eq!(
        fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(temporaries_under(&server.dir.join("host-root")).is_empty());

    // The installed binary is the one the connection starts, and it is the pinned version.
    let connection =
        HostConnection::connect(&target, &paths, &root.binary(HOST_VERSION), &interact).unwrap();

    assert_eq!(connection.hello().version, HOST_VERSION);
    finish(&connection, &target, &paths);

    assert_eq!(
        install::install(&remote, &bundle, &root).unwrap(),
        Installed::Current
    );

    end_master(&target, &paths);
}

#[test]
fn a_wrong_checksum_leaves_nothing_executable_at_the_final_path() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "wrongsum");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let (_, root, bytes, sha256) = bundle_and_root(&server, local_triple());
    let interact: Arc<dyn Interact> = trusting();
    let remote = Remote {
        interact: &interact,
        paths: &paths,
        target: &target,
    };
    // The bytes are right and the shipped digest is not (the last digit changed): the server must refuse.
    let wrong = format!(
        "{}{}",
        &sha256[..63],
        if sha256.ends_with('0') { '1' } else { '0' }
    );
    let error = install::upload(&remote, &root, &mut bytes.as_slice(), &wrong).unwrap_err();
    let host_root = server.dir.join("host-root");

    assert!(error.contains("checksum"), "{error}");
    assert!(
        !host_root.join(HOST_VERSION).join("neore-host").exists(),
        "a binary with the wrong checksum reached the final path"
    );
    assert!(executables_under(&host_root).is_empty());
    wait_until_no_temporaries(&host_root);

    end_master(&target, &paths);
}

/// Yields `before` bytes, then fails: the upload is cut off in the middle.
struct CutOff {
    before: usize,
    sent: usize,
}

impl std::io::Read for CutOff {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.sent >= self.before {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "cut off",
            ));
        }

        let count = buffer.len().min(self.before - self.sent).min(4096);

        buffer[..count].fill(0x7f);
        self.sent += count;

        Ok(count)
    }
}

#[test]
fn a_killed_upload_leaves_nothing_executable_at_the_final_path() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "killed");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let (_, root, _, sha256) = bundle_and_root(&server, local_triple());
    let interact: Arc<dyn Interact> = trusting();
    let remote = Remote {
        interact: &interact,
        paths: &paths,
        target: &target,
    };
    let mut cut = CutOff {
        before: 200_000,
        sent: 0,
    };
    let error = install::upload(&remote, &root, &mut cut, &sha256).unwrap_err();
    let host_root = server.dir.join("host-root");

    assert!(error.contains("upload stopped"), "{error}");
    assert!(cut.sent > 0, "nothing was sent before the cut");
    assert!(!host_root.join(HOST_VERSION).join("neore-host").exists());
    assert!(executables_under(&host_root).is_empty());
    wait_until_no_temporaries(&host_root);

    // The next install is not confused by what was left.
    let (bundle, _, _, _) = bundle_and_root(&server, local_triple());

    assert_eq!(
        install::install(&remote, &bundle, &root).unwrap(),
        Installed::Uploaded
    );

    end_master(&target, &paths);
}

#[test]
fn a_platform_the_bundle_has_no_binary_for_is_refused_before_anything_is_created_there() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "arch");
    let (target, paths) = (server.target("client"), server.paths("a"));
    // Only a platform this machine is not.
    let other = if local_triple() == "x86_64-unknown-linux-musl" {
        "aarch64-unknown-linux-musl"
    } else {
        "x86_64-unknown-linux-musl"
    };
    let (bundle, root, _, _) = bundle_and_root(&server, other);
    let interact: Arc<dyn Interact> = trusting();
    let remote = Remote {
        interact: &interact,
        paths: &paths,
        target: &target,
    };
    let nothing_uploaded = || {
        let mut files = Vec::new();

        files_under(&server.dir, &mut files);
        files.retain(|file| {
            file.to_string_lossy().contains("neore-host")
                && !file.starts_with(server.dir.join("bundle"))
        });

        assert!(files.is_empty(), "something was uploaded: {files:?}");
        assert!(
            !server.dir.join("host-root").exists(),
            "the refusal came after the server was touched"
        );
    };
    let error = install::install(&remote, &bundle, &root).unwrap_err();

    assert!(error.contains("ships no neore-host"), "{error}");
    nothing_uploaded();

    // A bundle with no binary at all is refused the same way.
    fs::write(
        server.dir.join("bundle").join("manifest.json"),
        json!({ "version": HOST_VERSION, "targets": {} }).to_string(),
    )
    .unwrap();

    let empty = Bundle::load(&server.dir.join("bundle")).unwrap();
    let error = install::install(&remote, &empty, &root).unwrap_err();

    assert!(error.contains("ships no neore-host"), "{error}");
    nothing_uploaded();

    end_master(&target, &paths);
}

#[test]
fn pruning_removes_the_other_versions_and_keeps_the_run_and_log_folders() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "prune");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let (bundle, root, _, _) = bundle_and_root(&server, local_triple());
    let interact: Arc<dyn Interact> = trusting();
    let remote = Remote {
        interact: &interact,
        paths: &paths,
        target: &target,
    };
    let host_root = server.dir.join("host-root");

    for kept in ["run", "logs"] {
        fs::create_dir_all(host_root.join(kept)).unwrap();
        fs::write(host_root.join(kept).join("keep"), "x").unwrap();
    }

    for old in ["0.0.1", "0.0.9"] {
        fs::create_dir_all(host_root.join(old)).unwrap();
        fs::write(host_root.join(old).join("neore-host"), "old").unwrap();
    }

    install::install(&remote, &bundle, &root).unwrap();
    install::prune(&remote, &root).unwrap();

    assert!(!host_root.join("0.0.1").exists());
    assert!(!host_root.join("0.0.9").exists());
    assert!(host_root.join("run").join("keep").exists());
    assert!(host_root.join("logs").join("keep").exists());
    assert!(host_root.join(HOST_VERSION).join("neore-host").exists());

    end_master(&target, &paths);
}

#[test]
fn a_missing_host_is_reported_as_not_installed_and_not_as_a_dead_connection() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "missing");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let interact: Arc<dyn Interact> = trusting();
    let root = Root::dir(&server.dir.join("nothing-here").to_string_lossy()).unwrap();
    let error = HostConnection::connect(&target, &paths, &root.binary(HOST_VERSION), &interact)
        .err()
        .expect("there is no host to start");

    assert!(matches!(error, SshError::HostMissing { .. }), "{error}");
    assert!(error.to_string().contains("not installed"), "{error}");

    end_master(&target, &paths);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

fn wait_for(what: &str, within: Duration, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;

    while !condition() {
        assert!(Instant::now() < deadline, "{what}");
        thread::sleep(Duration::from_millis(100));
    }
}

/// Whether `pid` is a live process (a zombie waiting to be reaped is not).
fn running(pid: i64) -> bool {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);

    output.status.success() && !state.trim().is_empty() && !state.trim().starts_with('Z')
}

/// The pid a launch filed in the server's run folder, once it has.
fn launch_pid(server: &Server, id: &str) -> Option<i64> {
    fs::read_to_string(server.run_dir().join(format!("{id}.pid")))
        .ok()?
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
}

/// A `neore-host --stdio --launch <id>` this test starts itself, the way another computer's session or an earlier
/// run of the desktop would have: the desktop under test did not start it. It lives while the returned child's
/// stdin is open.
fn spawn_host(server: &Server, id: &str) -> Child {
    let child = Command::new(env!("CARGO_BIN_EXE_neore-host"))
        .args(["--stdio", "--launch", id])
        .env("NEORE_HOST_RUN_DIR", server.run_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    wait_for(
        "the host did not file its launch",
        Duration::from_secs(10),
        || launch_pid(server, id).is_some(),
    );

    child
}

const FOREIGN: &str = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
const SPARE: &str = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";

/// A TCP relay in front of the sshd that can be partitioned, as a network that drops everything for a while and
/// forgets the connections it carried: while partitioned it answers nothing and discards what it is sent, and a
/// connection from before the partition never carries a byte again, and is never closed toward the server, so the
/// server has no way to tell the client is gone.
struct Relay {
    accept: Option<thread::JoinHandle<()>>,
    port: u16,
    shared: Arc<RelayShared>,
}

struct RelayShared {
    generation: AtomicU64,
    /// Sockets nobody will answer: connections made during the partition.
    held: Mutex<Vec<TcpStream>>,
    partitioned: AtomicBool,
    stop: AtomicBool,
    upstream: u16,
}

impl RelayShared {
    fn carries(&self, generation: u64) -> bool {
        !self.partitioned.load(Ordering::SeqCst)
            && self.generation.load(Ordering::SeqCst) == generation
    }
}

impl Relay {
    fn start(upstream: u16) -> Relay {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared = Arc::new(RelayShared {
            generation: AtomicU64::new(0),
            held: Mutex::default(),
            partitioned: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            upstream,
        });
        let state = Arc::clone(&shared);

        listener.set_nonblocking(true).unwrap();

        let accept = thread::spawn(move || {
            while !state.stop.load(Ordering::SeqCst) {
                let Ok((client, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(20));

                    continue;
                };

                if state.partitioned.load(Ordering::SeqCst) {
                    state.held.lock().unwrap().push(client);

                    continue;
                }

                let Ok(server) = TcpStream::connect((Ipv4Addr::LOCALHOST, state.upstream)) else {
                    continue;
                };
                let generation = state.generation.load(Ordering::SeqCst);

                client.set_nonblocking(false).unwrap();
                pump(
                    client.try_clone().unwrap(),
                    server.try_clone().unwrap(),
                    generation,
                    &state,
                );
                pump(server, client, generation, &state);
            }
        });

        Relay {
            accept: Some(accept),
            port,
            shared,
        }
    }

    fn partition(&self) {
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        self.shared.partitioned.store(true, Ordering::SeqCst);
    }

    fn restore(&self) {
        self.shared.partitioned.store(false, Ordering::SeqCst);
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);

        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

/// Copies `from` to `to` while the connection (born in `generation`) is carried. A connection that was cut off keeps
/// reading and dropping, and leaves `to` open when `from` ends.
fn pump(mut from: TcpStream, mut to: TcpStream, generation: u64, shared: &Arc<RelayShared>) {
    let shared = Arc::clone(shared);

    from.set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];

        while !shared.stop.load(Ordering::SeqCst) {
            match from.read(&mut buffer) {
                Ok(0) => {
                    if shared.carries(generation) {
                        let _ = to.shutdown(Shutdown::Both);
                    }

                    break;
                }
                Ok(read) => {
                    if shared.carries(generation) && to.write_all(&buffer[..read]).is_err() {
                        break;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
    });
}

/// Counts the `ssh` processes of one client (those whose command line names its control folder), however they are
/// parented: the multiplexed master is daemonized.
struct Sampler {
    most: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

fn ssh_processes(marker: &str) -> usize {
    let output = Command::new("ps")
        .args(["-axww", "-o", "pid=,comm=,args="])
        .output()
        .unwrap();

    // A session shows as `ssh`; the master retitles itself `ssh: <control path> [mux]`, which can also cut its
    // command name short.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| {
            let command = line.split_whitespace().nth(1).unwrap_or("");

            line.contains(marker)
                && (command.rsplit('/').next() == Some("ssh") || line.contains(" ssh: "))
        })
        .count()
}

impl Sampler {
    fn start(marker: String) -> Sampler {
        let (most, stop) = (
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
        );
        let (seen, halt) = (Arc::clone(&most), Arc::clone(&stop));
        let thread = thread::spawn(move || {
            while !halt.load(Ordering::SeqCst) {
                seen.fetch_max(ssh_processes(&marker), Ordering::SeqCst);
                thread::sleep(Duration::from_millis(50));
            }
        });

        Sampler {
            most,
            stop,
            thread: Some(thread),
        }
    }

    fn finish(mut self) -> usize {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();

        self.most.load(Ordering::SeqCst)
    }
}

/// What the engine's keeper does for one server, over real ssh: it watches the link, closes a dead session (and
/// its master when ssh gave the connection up), makes one attempt at a time when `Keep` says so, and asks the new
/// host to stop the launches the old one left.
struct Driver {
    attempt: Option<thread::JoinHandle<Result<HostConnection, SshError>>>,
    binary: String,
    /// Attempts that failed, with whether trying again could help.
    failures: Vec<bool>,
    interact: Arc<dyn Interact>,
    keep: Keep,
    launches: Vec<String>,
    link: Option<HostConnection>,
    lost_launch: Option<String>,
    paths: SshPaths,
    reaped: Vec<Reaped>,
    started: Instant,
    target: Target,
}

impl Driver {
    fn new(
        server: &Server,
        target: Target,
        paths: SshPaths,
        interact: Arc<Scripted>,
        first: Option<HostConnection>,
    ) -> Driver {
        Driver {
            attempt: None,
            binary: server.binary(),
            failures: Vec::new(),
            interact: interact as Arc<dyn Interact>,
            keep: Keep::connected(),
            launches: first
                .iter()
                .map(|link| link.launch_id().unwrap().to_owned())
                .collect(),
            link: first,
            lost_launch: None,
            paths,
            reaped: Vec::new(),
            started: Instant::now(),
            target,
        }
    }

    /// Shown when the test fails (and with `--nocapture`).
    fn note(&self, what: &str) {
        println!("[{:>6.1}s] {what}", self.started.elapsed().as_secs_f32());
    }

    fn tick(&mut self) {
        let now = Instant::now();

        if self
            .attempt
            .as_ref()
            .is_some_and(thread::JoinHandle::is_finished)
        {
            match self.attempt.take().unwrap().join().unwrap() {
                Ok(connection) => {
                    let current = connection.launch_id().unwrap().to_owned();
                    let stale: Vec<String> = self
                        .launches
                        .iter()
                        .filter(|id| **id != current)
                        .cloned()
                        .collect();

                    if !stale.is_empty() {
                        let reaped = connection.reap(&stale).unwrap();

                        self.launches
                            .retain(|id| !reaped.stopped.contains(id) && !reaped.gone.contains(id));
                        self.reaped.push(reaped);
                    }

                    self.note(&format!("connected, launch {}", &current[..8]));
                    self.launches.push(current);
                    self.keep.up();
                    self.link = Some(connection);
                }
                Err(error) => {
                    self.note(&format!(
                        "attempt failed (retryable: {}): {error}",
                        error.retryable()
                    ));
                    self.failures.push(error.retryable());
                    self.keep.failed(now, error.retryable(), &error.to_string());
                }
            }
        }

        if self.link.as_ref().is_some_and(|link| !link.is_alive()) {
            let link = self.link.take().unwrap();

            self.note("link lost");
            self.lost_launch = link.launch_id().map(str::to_owned);
            link.close();

            if link.master_suspect() {
                link.exit_master();
            }

            self.keep.lost(now);
        }

        if self.link.is_none() && self.attempt.is_none() && self.keep.due(now).is_some() {
            self.note(&format!("attempt starts ({:?})", self.keep.phase()));

            let (target, paths, binary, interact) = (
                self.target.clone(),
                self.paths.clone(),
                self.binary.clone(),
                Arc::clone(&self.interact),
            );

            self.attempt = Some(thread::spawn(move || {
                HostConnection::connect_within(
                    &target,
                    &paths,
                    &binary,
                    &interact,
                    ATTEMPT_PATIENCE,
                )
            }));
        }
    }

    fn connected(&self) -> bool {
        self.link.as_ref().is_some_and(HostLink::is_alive)
    }
}

#[test]
fn a_minute_without_network_reconnects_with_at_most_two_ssh_processes_and_stops_only_its_own_stale_host(
) {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "outage");
    let relay = Relay::start(server.port);
    let mut target = server.target("client");

    target.port = relay.port;

    let paths = server.paths("o");
    let interact = trusting();
    let sampler = Sampler::start(paths.control_dir.to_string_lossy().into_owned());
    let first = connect(&server, &target, &paths, &interact).unwrap();
    let first_launch = first.launch_id().unwrap().to_owned();
    let first_pid = launch_pid(&server, &first_launch).expect("the host filed no launch");
    let mut driver = Driver::new(
        &server,
        target.clone(),
        paths.clone(),
        Arc::clone(&interact),
        Some(first),
    );
    // Another computer's session on the same server, which this one did not start.
    let mut foreign = spawn_host(&server, FOREIGN);
    let foreign_pid = launch_pid(&server, FOREIGN).unwrap();

    assert!(running(first_pid) && running(foreign_pid));

    // The network goes away for a minute and then comes back.
    let outage = Duration::from_secs(60);
    let began = Instant::now();

    relay.partition();

    let mut stale_seen = false;

    while began.elapsed() < outage {
        driver.tick();

        if !stale_seen && driver.lost_launch.is_some() {
            stale_seen = true;

            // The server never learned the session is gone: the host from before the loss is still there.
            assert!(
                running(first_pid),
                "the old host ended by itself, so there is nothing to reap"
            );
        }

        thread::sleep(Duration::from_millis(100));
    }

    relay.restore();

    let root = vectors::fixture("ssh-outage");
    let list = json!({ "tool": "fs_list", "input": { "path": root }, "roots": [root], "remainingMs": 60_000 });
    let mut checked = false;

    wait_for(
        "the host did not reconnect within two minutes of the network coming back",
        Duration::from_secs(120),
        || {
            driver.tick();

            if !driver.connected()
                || driver.link.as_ref().unwrap().launch_id() == Some(first_launch.as_str())
            {
                return false;
            }

            checked = true;

            true
        },
    );

    assert!(checked);

    let link = driver.link.take().unwrap();

    assert_ne!(
        link.launch_id().unwrap(),
        first_launch,
        "the old session came back"
    );
    assert_eq!(
        link.run(&list, Duration::from_secs(30)).unwrap().status,
        "completed"
    );

    // The stale host of this computer was stopped, and the one it did not start was left alone.
    wait_for(
        "the stale host was not stopped",
        Duration::from_secs(10),
        || !running(first_pid),
    );

    assert!(
        driver
            .reaped
            .iter()
            .any(|reaped| reaped.stopped.contains(&first_launch)),
        "{:?}",
        driver.reaped
    );
    assert!(
        driver
            .reaped
            .iter()
            .all(|reaped| !reaped.stopped.contains(&FOREIGN.to_owned())),
        "{:?}",
        driver.reaped
    );
    assert!(
        running(foreign_pid),
        "a host this computer did not start was stopped"
    );
    assert!(
        launch_pid(&server, FOREIGN).is_some(),
        "its launch file was removed"
    );
    assert!(
        driver.reaped.iter().any(|reaped| reaped.others >= 1),
        "the other host was not even noticed: {:?}",
        driver.reaped
    );

    finish(&link);
    drop(driver);

    let _ = foreign.kill();
    let _ = foreign.wait();
    drop(relay);

    let most = sampler.finish();

    assert!(
        most >= 2,
        "the sampler never saw the master and a session: it counted {most}"
    );
    assert!(most <= 2, "{most} ssh processes were alive at once");
}

#[test]
fn a_host_this_computer_did_not_start_survives_a_reap_and_a_disconnect() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "foreign");
    let (target, paths) = (server.target("client"), server.paths("a"));
    let connection = connect(&server, &target, &paths, &trusting()).unwrap();
    let own = connection.launch_id().unwrap().to_owned();
    let own_pid = launch_pid(&server, &own).expect("the host filed no launch");

    // One host left by an earlier session of this computer, one that another computer started.
    let mut earlier = spawn_host(&server, SPARE);
    let mut foreign = spawn_host(&server, FOREIGN);
    let (earlier_pid, foreign_pid) = (
        launch_pid(&server, SPARE).unwrap(),
        launch_pid(&server, FOREIGN).unwrap(),
    );

    let reaped = connection
        .reap(&[
            SPARE.to_owned(),
            "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0".to_owned(),
            "../../etc".to_owned(),
        ])
        .unwrap();

    assert_eq!(reaped.stopped, [SPARE]);
    assert_eq!(reaped.gone, ["c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"]);
    assert_eq!(
        reaped.others, 1,
        "the foreign host is counted and nothing else"
    );
    wait_for(
        "the named launch kept running",
        Duration::from_secs(10),
        || !running(earlier_pid),
    );
    let _ = earlier.wait();

    // Disconnecting ends this computer's own session and host, and nothing else.
    finish(&connection);
    drop(connection);
    wait_for(
        "the session's own host kept running",
        Duration::from_secs(10),
        || !running(own_pid),
    );
    wait_for(
        "the host did not remove its launch file",
        Duration::from_secs(10),
        || launch_pid(&server, &own).is_none(),
    );

    assert!(
        running(foreign_pid),
        "a disconnect stopped a host this computer did not start"
    );
    assert!(launch_pid(&server, FOREIGN).is_some());

    let _ = foreign.kill();
    let _ = foreign.wait();
}

#[test]
fn a_forwarded_agent_is_linked_from_a_stable_path_in_the_run_folder() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "agent");
    let socket = server.dir.join("agent.sock");
    let mut agent = Command::new("ssh-agent")
        .args(["-D", "-a"])
        .arg(&socket)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("ssh-agent did not start");

    wait_for("ssh-agent did not listen", Duration::from_secs(10), || {
        socket.exists()
    });

    let mut target = server.target("client");

    target.forward_agent = true;

    let paths = server.paths("a");
    let connection = connect_with_agent(&server, &target, &paths, &trusting(), &socket).unwrap();
    let stable = server.run_dir().join("agent.sock");

    // What the launch started with is the session's own socket, which dies with the session. The host re-points
    // its (and its children's) `SSH_AUTH_SOCK` at a link in the run folder that a later session replaces.
    let session = server
        .remote_env()
        .lines()
        .find_map(|line| line.strip_prefix("SSH_AUTH_SOCK=").map(str::to_owned))
        .expect("no agent was forwarded to the session");

    assert_ne!(Path::new(&session), stable);
    assert_eq!(fs::read_link(&stable).unwrap(), Path::new(&session));

    finish(&connection);

    // Without forwarding the host links nothing.
    let plain = Server::start(&sshd, "no-agent");
    let connection = connect(
        &plain,
        &plain.target("client"),
        &plain.paths("a"),
        &trusting(),
    )
    .unwrap();

    assert!(!plain.run_dir().join("agent.sock").exists());
    assert!(!plain.remote_env().contains("SSH_AUTH_SOCK"));

    finish(&connection);

    let _ = agent.kill();
    let _ = agent.wait();
}

#[test]
fn attempts_that_fail_while_the_server_is_unreachable_back_off_and_never_stack_ssh_processes() {
    let Some(sshd) = sshd_binary() else { return };
    let server = Server::start(&sshd, "unreachable");
    let relay = Relay::start(server.port);
    let mut target = server.target("client");

    target.port = relay.port;

    let paths = server.paths("u");
    let interact = trusting();
    let sampler = Sampler::start(paths.control_dir.to_string_lossy().into_owned());

    // The first sight of the server pins its key; then the network goes away.
    let first = connect(&server, &target, &paths, &interact).unwrap();

    finish(&first);
    drop(first);
    relay.partition();

    let mut driver = Driver::new(&server, target.clone(), paths.clone(), interact, None);

    assert!(driver.keep.lost(Instant::now()));

    let began = Instant::now();

    while began.elapsed() < Duration::from_secs(30) {
        driver.tick();
        assert!(!driver.connected());
        assert!(
            !matches!(
                driver.keep.phase(),
                device_core::lifecycle::Phase::GaveUp { .. }
            ),
            "{:?}",
            driver.keep.phase()
        );
        thread::sleep(Duration::from_millis(100));
    }

    assert!(
        driver.failures.len() >= 2 && driver.failures.iter().all(|retryable| *retryable),
        "{:?}",
        driver.failures
    );

    relay.restore();
    wait_for(
        "the host did not reconnect once the server was reachable",
        Duration::from_secs(90),
        || {
            driver.tick();
            driver.connected()
        },
    );

    finish(driver.link.as_ref().unwrap());
    drop(driver);
    drop(relay);

    let most = sampler.finish();

    assert!(most <= 2, "{most} ssh processes were alive at once");
}
