//! `neore-host` end to end: the real binary over its stdin and stdout, against the same action vectors the
//! desktop engine is checked with (`src/engine.rs`), and the guarantees the plan makes about the process.

#[path = "common/vectors.rs"]
mod vectors;

use std::io::Write;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::Duration;

use device_core::frame::{read_frame, write_frame};
use device_core::host::{run_request, RunParams};
use serde_json::{json, Value};
use vectors::{Observed, Sandbox};

const PATIENCE: Duration = Duration::from_secs(60);

/// A running `neore-host --stdio`. Frames are read on a thread so a hung host fails the test, not the run.
struct Host {
    child: Child,
    frames: Receiver<Value>,
    stdin: Option<ChildStdin>,
}

impl Host {
    fn start() -> Host {
        let mut child = Command::new(env!("CARGO_BIN_EXE_neore-host"))
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take();
        let (sender, frames) = channel();

        thread::spawn(move || {
            while let Ok(Some(bytes)) = read_frame(&mut stdout) {
                if sender
                    .send(serde_json::from_slice(&bytes).unwrap())
                    .is_err()
                {
                    break;
                }
            }
        });

        Host {
            child,
            frames,
            stdin,
        }
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

    assert_eq!(hello["kind"], "hello");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["platform"], device_core::actions::platform());
    assert_eq!(
        hello["sandbox"]["available"],
        matches!(support, device_core::sandbox::Support::Available(_))
    );
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
    let status = Command::new(env!("CARGO_BIN_EXE_neore-host"))
        .status()
        .unwrap();

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
