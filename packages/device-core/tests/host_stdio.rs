//! `neore-host` end to end: the real binary over its stdin and stdout, against the same action vectors the
//! desktop engine is checked with (`src/engine.rs`), and the guarantees the plan makes about the process.

#[path = "common/vectors.rs"]
mod vectors;

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use device_core::frame::{read_frame, stream_chunk_of, write_frame, CHUNK_TAG};
use device_core::host::{run_request, RunParams};
use serde_json::{json, Value};
use vectors::{Observed, Sandbox};

const PATIENCE: Duration = Duration::from_secs(60);

/// The binary under test: the one cargo built, or the one `NEORE_HOST_BIN` names (CI points it at the static
/// musl build, so the same tests run against what ships).
fn host_binary() -> PathBuf {
    std::env::var_os("NEORE_HOST_BIN")
        .map_or_else(|| env!("CARGO_BIN_EXE_neore-host").into(), PathBuf::from)
}

/// What the plan's launch (`env -i HOME=... PATH=/usr/bin:/bin LANG=C.UTF-8`) leaves a host: nothing is
/// inherited from the process that starts it, so no agent socket, no app variable and no token reaches it.
/// Windows has no `/usr/bin`; a process there needs `SystemRoot` and the home as `USERPROFILE`.
fn clean_environment() -> Vec<(&'static str, OsString)> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").expect("SystemRoot");
        let home = std::env::var_os("USERPROFILE").expect("USERPROFILE");
        let mut path = PathBuf::from(&root);

        path.push("System32");

        vec![
            ("LANG", "C.UTF-8".into()),
            ("PATH", path.into_os_string()),
            ("SystemRoot", root),
            ("USERPROFILE", home),
        ]
    }

    #[cfg(not(windows))]
    {
        vec![
            ("HOME", std::env::var_os("HOME").expect("HOME")),
            ("LANG", "C.UTF-8".into()),
            ("PATH", "/usr/bin:/bin".into()),
        ]
    }
}

/// The host binary with the clean environment and nothing inherited.
fn host_command() -> Command {
    let mut command = Command::new(host_binary());

    command.env_clear().envs(clean_environment());
    command
}

/// A running `neore-host --stdio`. Frames are read on a thread so a hung host fails the test, not the run.
struct Host {
    child: Child,
    frames: Receiver<Value>,
    /// While set, the reader stops taking frames off stdout, so the pipe fills and the host stalls on its writes.
    held: Arc<AtomicBool>,
    stdin: Option<ChildStdin>,
}

impl Host {
    fn start() -> Host {
        Self::start_with(&[])
    }

    /// A host that also has `extra` in its environment, as a forwarded agent socket would be.
    fn start_with(extra: &[(&str, &str)]) -> Host {
        let mut child = host_command()
            .envs(extra.iter().copied())
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take();
        let (sender, frames) = channel();
        let held = Arc::new(AtomicBool::new(false));
        let reader_held = Arc::clone(&held);

        thread::spawn(move || loop {
            while reader_held.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(10));
            }

            let Ok(Some(bytes)) = read_frame(&mut stdout) else {
                break;
            };
            // A chunk is raw bytes; the tests see it as `{ kind: "chunk", id, stream, bytes: [..] }`.
            let frame = stream_chunk_of(&bytes).map_or_else(
                || serde_json::from_slice(&bytes).unwrap(),
                |(tag, id, data)| {
                    json!({
                        "kind": "chunk", "id": id, "bytes": data,
                        "stream": if tag == CHUNK_TAG { "stdout" } else { "stderr" },
                    })
                },
            );

            if sender.send(frame).is_err() {
                break;
            }
        });

        Host {
            child,
            frames,
            held,
            stdin,
        }
    }

    /// Stops (or resumes) reading the host's stdout.
    fn hold(&self, held: bool) {
        self.held.store(held, Ordering::SeqCst);
    }

    fn next(&self) -> Value {
        self.frames
            .recv_timeout(PATIENCE)
            .expect("the host sent no frame in time")
    }

    fn send(&mut self, frame: Value) {
        write_frame(
            self.stdin.as_mut().unwrap(),
            &serde_json::to_vec(&frame).unwrap(),
        )
        .unwrap();
    }

    fn request(&mut self, id: u64, op: &str, params: Value) {
        self.send(json!({ "kind": "request", "id": id, "op": op, "params": params }));
    }

    fn run(&mut self, id: u64, params: Value) {
        self.request(id, "run", params);
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn exit_code(&mut self) -> Option<i32> {
        let deadline = std::time::Instant::now() + PATIENCE;

        while std::time::Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }

            thread::sleep(Duration::from_millis(20));
        }

        panic!("the host did not exit");
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn params(root: &Path, tool: &str, input: &Value) -> Value {
    json!({ "tool": tool, "input": input, "roots": [root], "remainingMs": 60_000 })
}

fn observed(outcome: &Value) -> Observed {
    Observed {
        error: outcome["error"].as_str().map(str::to_owned),
        exit_code: outcome["exitCode"].as_i64(),
        output: outcome["output"].as_str().map(str::to_owned),
        status: outcome["status"].as_str().unwrap().to_owned(),
    }
}

#[test]
fn the_host_says_what_it_can_sandbox_before_anything_else() {
    let host = Host::start();
    let hello = host.next();
    let support = device_core::sandbox::support();
    let confines = device_core::sandbox::policy_for_call(
        &support,
        false,
        device_core::sandbox::NetworkTier::Off,
        &[],
        None,
    )
    .is_ok();

    assert_eq!(hello["kind"], "hello");
    assert_eq!(hello["protocol"], 3);
    assert_eq!(hello["agents"], cfg!(unix));
    assert_eq!(hello["platform"], device_core::actions::platform());
    assert_eq!(hello["sandbox"]["available"], confines);
}

/// The same vectors through the function the engine's action path shares and through the binary: each
/// observation meets the one complete expectation in `actions.json` (the engine's own test checks the same
/// list against it), and the two agree with each other.
#[test]
fn the_vectors_give_the_same_results_in_process_and_over_stdio() {
    let sandbox = vectors::sandbox();
    let (in_process_root, stdio_root) = (vectors::fixture("in-process"), vectors::fixture("stdio"));
    let mut host = Host::start();

    host.next();

    for (id, vector) in vectors::vectors().iter().enumerate() {
        if !vector.applies(sandbox) {
            continue;
        }

        let in_process = {
            let params: RunParams =
                serde_json::from_value(params(&in_process_root, &vector.tool, &vector.input))
                    .unwrap();

            serde_json::to_value(run_request(params)).unwrap()
        };

        host.run(id as u64, params(&stdio_root, &vector.tool, &vector.input));

        let response = host.next();

        assert_eq!(response["kind"], "response");
        assert_eq!(response["id"], id as u64);
        assert_eq!(response["ok"], true, "{response}");

        let over_stdio = &response["result"];

        vectors::assert_observed(vector, &in_process_root, &observed(&in_process));
        vectors::assert_observed(vector, &stdio_root, &observed(over_stdio));
        assert_eq!(
            vectors::normalised(&observed(&in_process), &in_process_root),
            vectors::normalised(&observed(over_stdio), &stdio_root),
            "vector \"{}\"",
            vector.name
        );
        assert_eq!(
            in_process["truncated"], over_stdio["truncated"],
            "vector \"{}\"",
            vector.name
        );
    }

    vectors::assert_nothing_escaped(&in_process_root);
    vectors::assert_nothing_escaped(&stdio_root);
}

#[test]
fn a_shell_command_is_refused_before_it_spawns_when_the_sandbox_is_required_and_missing() {
    if vectors::sandbox() != Sandbox::None {
        eprintln!("skipping: this machine has a shell sandbox");

        return;
    }

    let root = vectors::fixture("refusal");
    let mut host = Host::start();

    host.next();
    // Asking to run unsandboxed is the desktop's setting, and absent it the host requires a sandbox.
    host.run(
        1,
        params(
            &root,
            "shell_run",
            &json!({ "command": "echo ran > refused-marker.txt" }),
        ),
    );

    let response = host.next();

    assert_eq!(response["result"]["status"], "failed");
    assert!(
        response["result"]["error"]
            .as_str()
            .unwrap()
            .contains("must run sandboxed"),
        "{response}"
    );
    assert!(!root.join("refused-marker.txt").exists());
}

#[test]
fn a_long_command_does_not_hold_up_a_file_read() {
    if vectors::sandbox() != Sandbox::Confines {
        eprintln!("skipping: no usable shell sandbox here");

        return;
    }

    let root = vectors::fixture("concurrent");
    let mut host = Host::start();

    host.next();
    host.run(
        1,
        params(
            &root,
            "shell_run",
            &json!({ "command": "sleep 2; echo late" }),
        ),
    );
    host.run(2, params(&root, "fs_read", &json!({ "path": "a.txt" })));

    let first = host.next();
    let second = host.next();

    assert_eq!(first["id"], 2);
    assert_eq!(first["result"]["output"], "hello");
    assert_eq!(second["id"], 1);
    assert_eq!(second["result"]["output"], "late\n");
}

/// The run's own timeout is what stops a command, so the host must outlive it when stdin closes first.
#[cfg(unix)]
#[test]
fn a_command_in_flight_is_still_stopped_by_its_timeout_after_stdin_closes() {
    let root = vectors::fixture("eof-in-flight");
    let mut host = Host::start();

    host.next();
    host.run(
        1,
        json!({
            "tool": "shell_run",
            "input": { "command": "sleep 4; touch late-marker", "timeoutSeconds": 1 },
            "roots": [root],
            "remainingMs": 60_000,
            "allowUnsandboxedShell": true,
        }),
    );
    host.close_stdin();

    let response = host.next();

    assert_eq!(response["id"], 1);
    assert_eq!(response["result"]["status"], "failed", "{response}");
    assert_eq!(host.exit_code(), Some(0));

    // Past the point where an unsupervised `sleep 4` would have written its marker.
    thread::sleep(Duration::from_secs(4));

    assert!(
        !root.join("late-marker").exists(),
        "the command outlived the host"
    );
}

#[test]
fn a_request_the_host_cannot_serve_is_answered_not_run() {
    let mut host = Host::start();

    host.next();
    host.request(7, "launch", json!({}));
    host.run(8, json!({ "tool": "fs_list" }));

    let (mut unknown, mut invalid) = (host.next(), host.next());

    if unknown["id"] != 7 {
        std::mem::swap(&mut unknown, &mut invalid);
    }

    assert_eq!(
        (unknown["ok"].clone(), unknown["error"].clone()),
        (json!(false), json!("unknown op launch"))
    );
    assert_eq!(
        (invalid["ok"].clone(), invalid["error"].clone()),
        (json!(false), json!("invalid run params"))
    );
}

#[test]
fn the_host_ends_cleanly_when_its_stdin_closes() {
    let mut host = Host::start();

    host.next();
    host.close_stdin();

    assert_eq!(host.exit_code(), Some(0));
}

#[test]
fn a_broken_stream_ends_the_connection_with_an_error() {
    let mut host = Host::start();

    host.next();
    // A length over the limit: the stream cannot be trusted past it.
    host.stdin
        .as_mut()
        .unwrap()
        .write_all(&u32::MAX.to_be_bytes())
        .unwrap();
    host.stdin.as_mut().unwrap().flush().unwrap();

    assert_eq!(host.exit_code(), Some(1));
}

#[test]
fn the_host_refuses_to_start_without_stdio() {
    let status = host_command().status().unwrap();

    assert_eq!(status.code(), Some(2));
}

/// No listener, and no socket at all: the only channel is the pipe. Checked after the host has served a
/// request, so a socket opened lazily would show.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn the_host_holds_no_socket() {
    let root = vectors::fixture("sockets");
    let mut host = Host::start();

    host.next();
    host.run(1, params(&root, "fs_list", &json!({})));
    host.next();

    let pid = host.child.id();

    #[cfg(target_os = "linux")]
    {
        let sockets: Vec<_> = std::fs::read_dir(format!("/proc/{pid}/fd"))
            .unwrap()
            .filter_map(|entry| std::fs::read_link(entry.unwrap().path()).ok())
            .filter(|target| target.to_string_lossy().starts_with("socket:"))
            .collect();

        assert!(sockets.is_empty(), "the host holds sockets: {sockets:?}");
    }

    #[cfg(target_os = "macos")]
    {
        // `-i` lists network sockets and `-U` unix ones. lsof exits 1 with nothing on stderr when it
        // found no match, which tells that apart from a lsof that failed to run.
        let listing = Command::new("lsof")
            .args(["-nP", "-a", "-p", &pid.to_string(), "-i", "-U"])
            .output()
            .unwrap();

        assert_eq!(
            (
                listing.status.code(),
                listing.stdout.is_empty(),
                listing.stderr.is_empty()
            ),
            (Some(1), true, true),
            "{}{}",
            String::from_utf8_lossy(&listing.stdout),
            String::from_utf8_lossy(&listing.stderr)
        );
    }
}

/// The host's own environment is exactly the clean one. A shell command cannot show it (a sandboxed one
/// is given its own allowlist), so it is read from the process: `/proc` on Linux, `ps` on macOS, where it
/// can only be checked for the variables this test process holds.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn the_host_sees_only_the_clean_environment() {
    let host = Host::start();
    let pid = host.child.id();
    let clean: BTreeSet<String> = clean_environment()
        .into_iter()
        .map(|(name, _)| name.to_owned())
        .collect();
    let ambient: BTreeSet<String> = std::env::vars().map(|(name, _)| name).collect();

    // Cargo sets variables for every test, so a launch that inherited would show.
    assert!(ambient.contains("CARGO_MANIFEST_DIR"));
    host.next();

    #[cfg(target_os = "linux")]
    {
        let environ = std::fs::read(format!("/proc/{pid}/environ")).unwrap();
        let seen: BTreeSet<String> = environ
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                String::from_utf8_lossy(entry)
                    .split('=')
                    .next()
                    .unwrap()
                    .to_owned()
            })
            .collect();

        assert_eq!(seen, clean);
    }

    #[cfg(target_os = "macos")]
    {
        let listing = Command::new("ps")
            .args(["-Eww", "-o", "command=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&listing.stdout);

        assert!(listing.status.success(), "ps failed: {text}");
        assert!(text.contains("HOME="), "ps shows no environment: {text}");

        for name in ambient.difference(&clean) {
            assert!(
                !text.contains(&format!(" {name}=")),
                "the host inherited {name}"
            );
        }
    }
}

/// A folder of `names`, each holding its own name, to list and archive.
fn folder_of(label: &str, names: &[&str]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("neore-host-files-{label}-{}", std::process::id()));

    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("root")).unwrap();

    for name in names {
        std::fs::write(dir.join("root").join(name), name).unwrap();
    }

    std::fs::canonicalize(dir.join("root")).unwrap()
}

fn files(root: &Path, path: &str) -> Value {
    json!({ "roots": [root], "path": path })
}

#[test]
fn a_folder_is_listed_a_page_at_a_time_inside_the_shared_folders() {
    let root = folder_of("list", &["e", "b", "d", "a", "c"]);
    let mut host = Host::start();

    host.next();

    let mut seen = Vec::new();
    let mut after = Value::Null;

    for id in 1..=5 {
        let mut params = files(&root, "");

        params["after"] = after.clone();
        params["limit"] = json!(2);
        host.request(id, "list", params);

        let response = host.next();

        assert_eq!(response["ok"], true, "{response}");

        let page = &response["result"];

        seen.extend(
            page["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["name"].as_str().unwrap().to_owned()),
        );

        if page["next"].is_null() {
            break;
        }

        after = page["next"].clone();
    }

    assert_eq!(seen, ["a", "b", "c", "d", "e"]);

    host.request(9, "list", files(&root, ".."));
    host.request(10, "list", files(&root, "/"));

    for _ in 0..2 {
        let response = host.next();

        assert_eq!(response["ok"], false, "{response}");
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("outside the shared folders"));
    }
}

#[cfg(unix)]
mod tar {
    use super::*;

    /// Sends `tar` and collects its chunks and response.
    fn download(host: &mut Host, id: u64, params: Value) -> (Vec<u8>, Value) {
        host.request(id, "tar", params);

        let mut archive = Vec::new();

        loop {
            let frame = host.next();

            match frame["kind"].as_str() {
                Some("chunk") => {
                    assert_eq!(frame["id"], id);
                    archive.extend(
                        frame["bytes"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|byte| byte.as_u64().unwrap() as u8),
                    );
                }
                _ => return (archive, frame),
            }
        }
    }

    #[test]
    fn a_folder_streams_as_chunks_then_a_response_that_says_what_it_holds() {
        let root = folder_of("tar", &["one", "two"]);
        let mut host = Host::start();

        host.next();

        let (archive, response) = download(&mut host, 3, files(&root, ""));
        let tar = root.parent().unwrap().join("out.tar");

        std::fs::write(&tar, &archive).unwrap();

        let listed = Command::new("tar").arg("-tf").arg(&tar).output().unwrap();
        let mut names: Vec<_> = String::from_utf8_lossy(&listed.stdout)
            .lines()
            .map(str::to_owned)
            .collect();

        names.sort();

        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["id"], 3);
        assert_eq!(
            response["result"],
            json!({ "bytes": 6, "files": 2, "folders": 1, "skipped": 0, "unreadable": 0 })
        );
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(names[0].ends_with("root/") && names[1].ends_with("/one"));

        // A folder outside the shared ones is refused before a byte is sent.
        let (archive, response) = download(&mut host, 4, files(&root, ".."));

        assert!(archive.is_empty());
        assert_eq!(response["ok"], false);
    }

    /// The host stalls on a stdout nobody reads (the test stops reading it); a `cancel` is read all the same and
    /// ends the archive.
    #[test]
    fn a_cancel_stops_an_archive_that_is_still_being_written() {
        let root = folder_of("cancel", &[]);

        std::fs::write(root.join("big"), vec![7u8; 24 * 1024 * 1024]).unwrap();

        let mut host = Host::start();

        host.next();
        host.hold(true);
        host.request(5, "tar", files(&root, ""));
        thread::sleep(Duration::from_millis(500));
        host.request(6, "cancel", json!({ "target": 5 }));
        host.hold(false);

        let (mut archive, mut answers) = (0usize, Vec::new());

        while answers.len() < 2 {
            let frame = host.next();

            if frame["kind"] == "chunk" {
                archive += frame["bytes"].as_array().unwrap().len();
            } else {
                answers.push(frame);
            }
        }

        let tar = answers.iter().find(|frame| frame["id"] == 5).unwrap();

        assert!(answers
            .iter()
            .any(|frame| frame["id"] == 6 && frame["ok"] == true));
        assert_eq!(tar["ok"], false, "{tar}");
        assert_eq!(tar["error"], "the download was stopped");
        assert!(archive < 24 * 1024 * 1024, "{archive} bytes were sent");
    }
}

// ─── Coding agents (S7) ──────────────────────────────────────────────────

/// Sends bytes to the agent started by request `id`, as a chunk frame; no bytes close its stdin.
#[cfg(unix)]
fn agent_input(host: &mut Host, id: u64, bytes: &[u8]) {
    let mut frame = vec![CHUNK_TAG];

    frame.extend_from_slice(&id.to_be_bytes());
    frame.extend_from_slice(bytes);
    write_frame(host.stdin.as_mut().unwrap(), &frame).unwrap();
}

#[cfg(unix)]
fn agent_params(root: &Path, script: &str, env: &Value) -> Value {
    json!({
        "args": ["-c", script], "command": "/bin/sh", "cwd": root, "env": env,
        "roots": [root],
    })
}

/// What an agent printed, by stream, and the response that ended it. Reads until the response of request `id`.
#[cfg(unix)]
fn agent_run(host: &Host, id: u64) -> (String, String, Value) {
    let (mut out, mut err) = (Vec::new(), Vec::new());

    loop {
        let frame = host.next();

        match frame["kind"].as_str() {
            Some("chunk") if frame["id"] == id => {
                let bytes: Vec<u8> = frame["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|byte| byte.as_u64().unwrap() as u8)
                    .collect();

                if frame["stream"] == "stdout" {
                    out.extend(bytes);
                } else {
                    err.extend(bytes);
                }
            }
            Some("response") if frame["id"] == id => {
                return (
                    String::from_utf8(out).unwrap(),
                    String::from_utf8(err).unwrap(),
                    frame,
                );
            }
            _ => {}
        }
    }
}

#[cfg(unix)]
fn alive(pid: i64) -> bool {
    // SAFETY: signal 0 only asks whether the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(unix)]
fn wait_gone(what: &str, pid: i64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);

    while alive(pid) {
        assert!(
            std::time::Instant::now() < deadline,
            "{what} ({pid}) is still running"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn wait_for_file(file: &Path) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);

    loop {
        if let Ok(text) = std::fs::read_to_string(file) {
            if text.ends_with('\n') {
                return text.trim().to_owned();
            }
        }

        assert!(
            std::time::Instant::now() < deadline,
            "{} never appeared",
            file.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
fn agent_folder(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("neore-host-agent-{label}-{}", std::process::id()));

    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    dir.canonicalize().unwrap()
}

#[cfg(unix)]
#[test]
fn an_agent_streams_both_outputs_takes_input_and_ends_with_its_status() {
    let root = agent_folder("stream");
    let mut host = Host::start();

    host.next();
    host.request(
        1,
        "agent",
        agent_params(
            &root,
            "echo ready; echo oops >&2; read line; echo got:$line; exit 3",
            &json!({}),
        ),
    );
    // The agent waits for a line; the desktop's bytes for request 1 are its stdin.
    agent_input(&mut host, 1, b"hello\n");

    let (out, err, response) = agent_run(&host, 1);

    assert_eq!(out, "ready\ngot:hello\n");
    assert_eq!(err, "oops\n");
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["code"], 3);
}

#[cfg(unix)]
#[test]
fn an_agent_gets_the_hosts_own_environment_and_the_persons_variables_and_no_agent_socket() {
    let root = agent_folder("env");
    let mut host = Host::start();

    host.next();
    host.request(
        1,
        "agent",
        agent_params(
            &root,
            "env",
            &json!({ "EXTRA": "from-the-person", "PATH": "/usr/bin:/bin:/opt/x" }),
        ),
    );

    let (out, _, response) = agent_run(&host, 1);
    let names: BTreeSet<&str> = out
        .lines()
        .filter_map(|line| line.split('=').next())
        .collect();

    assert_eq!(response["result"]["code"], 0, "{response}");
    assert!(out.contains("EXTRA=from-the-person"));
    assert!(out.contains("PATH=/usr/bin:/bin:/opt/x"));
    assert!(out.contains("HOME="));
    assert!(!names.contains("SSH_AUTH_SOCK"));
    // Nothing of cargo's environment, which the host was started from, reaches the agent.
    assert!(!names.contains("CARGO_MANIFEST_DIR"));
}

#[cfg(unix)]
#[test]
fn a_forwarded_agent_socket_reaches_the_agent_only_when_the_host_has_one() {
    let root = agent_folder("socket");
    let mut host = Host::start_with(&[("SSH_AUTH_SOCK", "/run/forwarded.sock")]);

    host.next();
    host.request(1, "agent", agent_params(&root, "env", &json!({})));

    let (out, _, _) = agent_run(&host, 1);

    assert!(out.contains("SSH_AUTH_SOCK=/run/forwarded.sock"));
}

#[cfg(unix)]
#[test]
fn an_agent_does_not_start_outside_the_shared_folders_or_with_a_reserved_variable() {
    let root = agent_folder("refuse");
    let mut host = Host::start();

    host.next();
    host.request(1, "agent", agent_params(Path::new("/"), "true", &json!({})));
    host.request(
        2,
        "agent",
        agent_params(&root, "true", &json!({ "NODE_OPTIONS": "--require x" })),
    );
    host.request(3, "agent", agent_params(&root, "true", &json!({})));

    let responses: Vec<Value> = (0..3).map(|_| host.next()).collect();
    let by_id = |id: u64| responses.iter().find(|r| r["id"] == id).unwrap();

    assert_eq!(by_id(1)["ok"], false, "{}", by_id(1));
    assert_eq!(by_id(2)["ok"], false, "{}", by_id(2));
    assert_eq!(by_id(3)["ok"], true, "{}", by_id(3));
}

#[cfg(unix)]
#[test]
fn a_cancel_stops_the_agent_and_its_group() {
    let root = agent_folder("cancel");
    let pidfile = root.join("child.pid");
    let mut host = Host::start();

    host.next();
    host.request(
        1,
        "agent",
        agent_params(
            &root,
            &format!(
                "sleep 300 & echo $! > {}; exec sleep 300",
                pidfile.display()
            ),
            &json!({}),
        ),
    );

    let child: i64 = wait_for_file(&pidfile).parse().unwrap();

    host.request(2, "cancel", json!({ "target": 1 }));

    let (_, _, response) = agent_run(&host, 1);

    assert_eq!(response["result"]["signal"], libc::SIGTERM);
    // The shell's background child was in the agent's group and goes with it.
    wait_gone("the agent's child", child);
}

#[cfg(unix)]
#[test]
fn a_desktop_that_goes_away_takes_the_whole_agent_tree_with_it() {
    let root = agent_folder("eof");
    let (pidfile, leaderfile) = (root.join("child.pid"), root.join("leader.pid"));
    let mut host = Host::start();

    host.next();
    host.request(
        1,
        "agent",
        agent_params(
            &root,
            &format!(
                "sleep 300 & echo $! > {}; echo $$ > {}; exec sleep 300",
                pidfile.display(),
                leaderfile.display()
            ),
            &json!({}),
        ),
    );

    let child: i64 = wait_for_file(&pidfile).parse().unwrap();
    let leader: i64 = wait_for_file(&leaderfile).parse().unwrap();

    // The desktop quit: ssh ends and the host's stdin with it.
    host.close_stdin();

    assert_eq!(host.exit_code(), Some(0));
    wait_gone("the agent", leader);
    wait_gone("the agent's child", child);
}

#[cfg(unix)]
#[test]
fn a_host_told_to_stop_takes_the_whole_agent_tree_with_it() {
    let root = agent_folder("term");
    let pidfile = root.join("child.pid");
    let mut host = Host::start();

    host.next();
    host.request(
        1,
        "agent",
        agent_params(
            &root,
            &format!(
                "sleep 300 & echo $! > {}; exec sleep 300",
                pidfile.display()
            ),
            &json!({}),
        ),
    );

    let child: i64 = wait_for_file(&pidfile).parse().unwrap();

    // SAFETY: SIGTERM to the host this test started.
    unsafe {
        libc::kill(host.child.id() as libc::pid_t, libc::SIGTERM);
    }

    host.exit_code();
    wait_gone("the agent's child", child);
}

#[cfg(unix)]
#[test]
fn agents_have_slots_of_their_own_and_do_not_use_up_the_requests() {
    let root = agent_folder("slots");
    let mut host = Host::start();

    host.next();

    for id in 1..=8 {
        host.request(
            id,
            "agent",
            agent_params(&root, "exec sleep 300", &json!({})),
        );
    }

    // A ninth is refused; the file and command requests still have all their slots.
    host.request(
        9,
        "agent",
        agent_params(&root, "exec sleep 300", &json!({})),
    );

    let refusal = host.next();

    assert_eq!(refusal["id"], 9);
    assert_eq!(refusal["ok"], false);
    assert_eq!(refusal["error"], "too many coding agents on this server");

    host.run(10, params(&root, "fs_list", &json!({})));

    let listing = host.next();

    assert_eq!(listing["id"], 10);
    assert_eq!(listing["ok"], true, "{listing}");
}
