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
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use device_core::ssh::{
    control_args, forget_keys, pinned_keys, HostConnection, HostKey, HostLink, Interact, SshError,
    SshPaths, Target,
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

    assert!(output.status.success(), "{program} {args:?} failed");

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
                "#!/bin/sh\nenv > '{}/remote-env.txt'\nexec '{}' \"$@\"\n",
                dir.display(),
                env!("CARGO_BIN_EXE_neore-host")
            ),
        )
        .unwrap();
        run("chmod", &["700", &wrapper.to_string_lossy()]);

        let port = free_port();
        let user = run("id", &["-un"]);

        fs::write(
            dir.join("sshd_config"),
            format!(
                "Port {port}\nListenAddress 127.0.0.1\nHostKey {dir}/host_key\nAuthorizedKeysFile {dir}/authorized_keys\nPidFile {dir}/sshd.pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nStrictModes no\nAllowUsers {user}\nLogLevel ERROR\n",
                dir = dir.display()
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
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn connect(
    server: &Server,
    target: &Target,
    paths: &SshPaths,
    interact: &Arc<Scripted>,
) -> Result<HostConnection, SshError> {
    // A client that carries an agent socket: the server must not see it.
    std::env::set_var("SSH_AUTH_SOCK", server.dir.join("no-agent.sock"));

    let interact: Arc<dyn Interact> = Arc::clone(interact) as Arc<dyn Interact>;

    HostConnection::connect(target, paths, &server.binary(), &interact)
}

/// Ends the session and the master it rode, so no ssh outlives the test.
fn finish(connection: &HostConnection) {
    connection.close();
    connection.exit_master();
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

    finish(&connection);
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

    finish(&connection);
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

    finish(&second);
    assert!(
        !master_is_running(&target, &paths),
        "ending the master left it running"
    );
}
