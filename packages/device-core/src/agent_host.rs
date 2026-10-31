//! A coding agent (ACP) on the server, run by `neore-host` (plans/ssh-environments.md §7, S7).
//!
//! The desktop has already checked the agent and the folder against the approvals the person gave in the local
//! window, and it speaks the protocol with the agent itself: the host only owns the process. It starts the agent
//! beside its sandbox, not inside it (the agent needs its model API, and runs its own tools under its own permission
//! modes; plans/acp-agent-host.md §6), relays the agent's stdout and stderr back as chunk frames of the request that
//! started it (`frame.rs`: tag 1 stdout, tag 2 stderr) and feeds its stdin from the chunk frames the desktop sends
//! for that request. The request ends, with how the agent ended, when the agent does.
//!
//! What the host decides, because only this machine can:
//! - The working folder is resolved on THIS filesystem and must sit inside the shared folders the request names.
//! - The environment is built here, from this process's own (a list, not a copy: [`crate::agent_env`]), plus
//!   `SSH_AUTH_SOCK` when forwarding put one there, plus the variables the person set, which are validated again.
//! - The agent runs in a process group of its own. A stop signals the group (SIGTERM, then SIGKILL after a grace
//!   period), and the group is killed again when the agent exits, so the shells and tools it left die with it. A host
//!   that loses its desktop (the pipe ends) or is told to stop kills every agent group the same way.

// Everything below `run_agent` is for Unix; a Windows server refuses the request, and what only it uses is unused there.
#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_env::{app_vars, built_env, validate_env_var};
use crate::frame::{CHUNK_HEADER_BYTES, CHUNK_TAG, STDERR_TAG};
use crate::outbox::Outbox;

/// Agents running on one host at once.
pub const MAX_AGENTS: usize = 8;
const MAX_ARGS: usize = 50;
const MAX_ARG_BYTES: usize = 1000;
const MAX_ENV_VARS: usize = 100;
/// Bytes of an agent's output per chunk frame.
const CHUNK_BYTES: usize = 32 * 1024;
/// How long a polite stop waits before the group is killed.
const TERM_GRACE: Duration = Duration::from_secs(2);
/// How long the host waits for the output pipes to drain after the agent is gone. A descendant that left the group and
/// still holds a pipe must not keep the request open.
const DRAIN_GRACE: Duration = Duration::from_secs(1);
/// How often a thread waiting on a pipe looks up to see whether it is told to stop.
const POLL_SLICE: Duration = Duration::from_millis(100);
/// Bytes of the desktop's input an agent may leave unread before it is stopped: an agent that does not read its stdin
/// must not make the host keep what the desktop keeps sending.
pub const INPUT_BUDGET: usize = 8 * 1024 * 1024;

/// What the desktop asks the host to start.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentParams {
    #[serde(default)]
    pub args: Vec<String>,
    pub command: String,
    /// Absolute, on this machine, inside one of `roots`.
    pub cwd: String,
    /// The variables the person set (global, then the agent's own): applied on top of the built environment.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The shared folders for this server.
    pub roots: Vec<String>,
}

/// Variables the host sets itself, from what this machine has. The person's list cannot name them: with forwarding on,
/// `SSH_AUTH_SOCK` is the socket the person approved for this server, and another value would point the agent's SSH
/// clients at a socket of someone else's choosing.
const HOST_SET: [&str; 1] = ["SSH_AUTH_SOCK"];

/// The environment the agent starts with on this machine: the built one, `SSH_AUTH_SOCK` if forwarding is on, then
/// the person's variables.
fn agent_environment(
    own: impl Iterator<Item = (String, String)>,
    user: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    if user.len() > MAX_ENV_VARS {
        return Err(format!("at most {MAX_ENV_VARS} variables"));
    }

    let own: Vec<(String, String)> = own.collect();
    let mut env = built_env(own.iter().cloned());

    // Forwarding is the person's opt-in for this server. With it off the launch has no agent socket, so nothing is
    // passed on.
    if let Some((_, socket)) = own.iter().find(|(name, _)| name == "SSH_AUTH_SOCK") {
        env.insert("SSH_AUTH_SOCK".to_owned(), socket.clone());
    }

    for (name, value) in user {
        if HOST_SET.contains(&name.as_str()) {
            return Err(format!(
                "{name} is set by the host and cannot be overridden"
            ));
        }

        validate_env_var(name, value)?;
        env.insert(name.clone(), value.clone());
    }

    Ok(env)
}

/// The working folder on this machine: an existing folder inside the shared folders.
fn working_folder(params: &AgentParams) -> Result<PathBuf, String> {
    if !std::path::Path::new(&params.cwd).is_absolute() {
        return Err("the agent's folder is not an absolute path".into());
    }

    let roots = crate::host::request_roots(&params.roots)?;
    let folder = crate::fs::resolve_existing(&params.cwd, &roots)?;

    if !folder.is_dir() {
        return Err(format!("{}: not a folder", params.cwd));
    }

    Ok(folder)
}

fn validate_command(params: &AgentParams) -> Result<(), String> {
    if params.command.trim().is_empty()
        || params.command.len() > MAX_ARG_BYTES
        || params.command.contains('\0')
    {
        return Err("the agent needs a command".into());
    }

    if params.args.len() > MAX_ARGS
        || params
            .args
            .iter()
            .any(|arg| arg.len() > MAX_ARG_BYTES || arg.contains('\0'))
    {
        return Err("agent arguments: at most 50, each up to 1000 bytes".into());
    }

    Ok(())
}

/// One chunk frame: the tag, the request id, the bytes.
fn chunk_frame(tag: u8, id: u64, bytes: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(CHUNK_HEADER_BYTES + bytes.len());

    frame.push(tag);
    frame.extend_from_slice(&id.to_be_bytes());
    frame.extend_from_slice(bytes);
    frame
}

/// What the desktop's chunk frames for an agent's stdin arrive on, and how many of their bytes are still unread.
pub struct AgentInput {
    pub bytes: Receiver<Vec<u8>>,
    /// Added to by whoever queues a chunk, taken from by the thread that writes it to the agent.
    pub queued: Arc<AtomicUsize>,
}

/// How the agent ended: its exit code and signal. A wait that failed is a failure of the request, not an exit.
fn exit_report(status: std::io::Result<std::process::ExitStatus>) -> Result<Value, String> {
    let status = status.map_err(|error| format!("could not wait for the agent: {error}"))?;

    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status);
    #[cfg(not(unix))]
    let signal: Option<i32> = None;

    Ok(json!({ "code": status.code(), "signal": signal }))
}

/// Runs the agent until it exits or `stop` is set, relaying its output as chunk frames of request `id` on `outbox`
/// and feeding its stdin from `input` (the stream ending closes it). Returns how it ended. An error is a request
/// that could not be served: nothing was started, or the agent could not be waited for (its group is killed then).
/// Every thread it starts has ended when it returns.
#[cfg(unix)]
pub fn run_agent(
    params: &AgentParams,
    id: u64,
    outbox: &Outbox,
    input: AgentInput,
    stop: &AtomicBool,
) -> Result<Value, String> {
    use std::os::unix::process::CommandExt;

    validate_command(params)?;

    let cwd = working_folder(params)?;
    let env = agent_environment(app_vars(std::env::vars_os()), &params.env)?;
    let mut child = Command::new(&params.command)
        .args(&params.args)
        .current_dir(&cwd)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", params.command))?;
    let pid = child.id();
    // Noted for as long as the agent lives, so a host told to stop (SIGTERM) ends it with its group.
    let _tracked = crate::shell::Tracked::new(pid);
    let failed = Arc::new(AtomicBool::new(false));
    // The agent is gone: the writer of its stdin has nothing left to write to.
    let exited = Arc::new(AtomicBool::new(false));
    // The output has had its chance to drain: a pump still waiting on a pipe a descendant holds open stops now.
    let drained = Arc::new(AtomicBool::new(false));
    let mut threads = Vec::new();

    if let Some(pipe) = child.stdin.take() {
        let exited = Arc::clone(&exited);

        threads.push(thread::spawn(move || feed_stdin(pipe, &input, &exited)));
    }

    let mut pumps = Vec::new();

    for (pipe, tag) in [
        (child.stdout.take().map(Pipe::Out), CHUNK_TAG),
        (child.stderr.take().map(Pipe::Err), STDERR_TAG),
    ] {
        let Some(pipe) = pipe else { continue };
        let (outbox, failed, drained) = (outbox.clone(), Arc::clone(&failed), Arc::clone(&drained));

        pumps.push(thread::spawn(move || {
            pump_output(pipe, tag, id, &outbox, &failed, &drained);
        }));
    }

    let mut terminated: Option<Instant> = None;
    let mut killed = false;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(error) => {
                // Nobody can say how it ended, and nothing watches it any more: it does not keep running.
                signal_group(pid, libc::SIGKILL);

                break Err(error);
            }
        }

        if (stop.load(Ordering::SeqCst) || failed.load(Ordering::SeqCst)) && terminated.is_none() {
            signal_group(pid, libc::SIGTERM);
            terminated = Some(Instant::now());
        }

        if let Some(since) = terminated {
            if !killed && since.elapsed() >= TERM_GRACE {
                signal_group(pid, libc::SIGKILL);
                killed = true;
            }
        }

        thread::sleep(Duration::from_millis(20));
    };

    exited.store(true, Ordering::SeqCst);
    // The leader is gone; what it started in its group goes too.
    signal_group(pid, libc::SIGKILL);

    let deadline = Instant::now() + DRAIN_GRACE;

    while pumps.iter().any(|pump| !pump.is_finished()) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }

    drained.store(true, Ordering::SeqCst);
    threads.extend(pumps);

    for thread in threads {
        let _ = thread.join();
    }

    exit_report(status)
}

#[cfg(not(unix))]
pub fn run_agent(
    _params: &AgentParams,
    _id: u64,
    _outbox: &Outbox,
    _input: AgentInput,
    _stop: &AtomicBool,
) -> Result<Value, String> {
    Err("coding agents are not supported on a Windows server yet".into())
}

/// Whether this host can run agents.
pub const SUPPORTED: bool = cfg!(unix);

#[cfg(unix)]
enum Pipe {
    Err(std::process::ChildStderr),
    Out(std::process::ChildStdout),
}

#[cfg(unix)]
impl Read for Pipe {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Pipe::Err(pipe) => pipe.read(buffer),
            Pipe::Out(pipe) => pipe.read(buffer),
        }
    }
}

#[cfg(unix)]
impl std::os::fd::AsRawFd for Pipe {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        match self {
            Pipe::Err(pipe) => pipe.as_raw_fd(),
            Pipe::Out(pipe) => pipe.as_raw_fd(),
        }
    }
}

/// Waits up to [`POLL_SLICE`] for `fd` to be ready for `events`. `Ok(false)` is the timeout.
#[cfg(unix)]
fn ready(fd: std::os::fd::RawFd, events: libc::c_short) -> std::io::Result<bool> {
    let mut poll = libc::pollfd {
        fd,
        events,
        revents: 0,
    };

    // SAFETY: one valid pollfd, and a count of one.
    let result = unsafe { libc::poll(&mut poll, 1, POLL_SLICE.as_millis() as libc::c_int) };

    if result < 0 {
        let error = std::io::Error::last_os_error();

        return if error.kind() == std::io::ErrorKind::Interrupted {
            Ok(false)
        } else {
            Err(error)
        };
    }

    Ok(result > 0)
}

/// Relays one of the agent's output pipes as chunk frames until it ends, `done` is set, or nobody reads the output
/// any more (`failed` is set then). It looks up every [`POLL_SLICE`], so a descendant that left the agent's group and
/// holds the pipe open cannot keep this thread, or the request, alive past `done`.
#[cfg(unix)]
fn pump_output<R: Read + std::os::fd::AsRawFd>(
    mut pipe: R,
    tag: u8,
    id: u64,
    outbox: &Outbox,
    failed: &AtomicBool,
    done: &AtomicBool,
) {
    let mut buffer = vec![0u8; CHUNK_BYTES];

    loop {
        match ready(pipe.as_raw_fd(), libc::POLLIN) {
            Ok(true) => {}
            Ok(false) if done.load(Ordering::SeqCst) => break,
            Ok(false) => continue,
            Err(_) => break,
        }

        match pipe.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if !relay(outbox, &chunk_frame(tag, id, &buffer[..read]), done) {
                    // The desktop is gone, or the connection stopped taking output: nobody reads the agent.
                    failed.store(true, Ordering::SeqCst);

                    break;
                }
            }
        }

        if done.load(Ordering::SeqCst) {
            break;
        }
    }
}

/// Queues an output frame, waiting for room while the connection is behind (that holds the agent back, which is the
/// point) and giving up once `done` says the request is over.
#[cfg(unix)]
fn relay(outbox: &Outbox, frame: &[u8], done: &AtomicBool) -> bool {
    loop {
        match outbox.offer(frame) {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if done.load(Ordering::SeqCst) {
                    return false;
                }

                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return false,
        }
    }
}

/// Writes the desktop's input to the agent's stdin until the stream ends, the agent exits or the pipe closes. The pipe
/// is non-blocking, so an agent that does not read it cannot hold this thread past its own exit.
#[cfg(unix)]
fn feed_stdin(mut pipe: std::process::ChildStdin, input: &AgentInput, exited: &AtomicBool) {
    use std::os::fd::AsRawFd;

    let fd = pipe.as_raw_fd();

    // SAFETY: plain fcntl calls on a descriptor this thread owns.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);

        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    loop {
        match input.bytes.recv_timeout(POLL_SLICE) {
            Ok(bytes) => {
                input.queued.fetch_sub(bytes.len(), Ordering::SeqCst);

                if write_until_exit(&mut pipe, &bytes, exited).is_err() {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) if !exited.load(Ordering::SeqCst) => {}
            Err(_) => break,
        }
    }
}

#[cfg(unix)]
fn write_until_exit(
    pipe: &mut std::process::ChildStdin,
    mut bytes: &[u8],
    exited: &AtomicBool,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;

    while !bytes.is_empty() {
        match pipe.write(bytes) {
            Ok(written) => bytes = &bytes[written..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if exited.load(Ordering::SeqCst) {
                    return Err(error);
                }

                ready(pipe.as_raw_fd(), libc::POLLOUT)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

/// Signals the process group `process_group(0)` made for the agent. ESRCH (already gone) is the goal, not an error.
#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
    // SAFETY: plain syscall with no memory arguments; the group is one this process made.
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> impl Iterator<Item = (String, String)> {
        list.iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn the_environment_is_built_from_the_hosts_own_and_not_copied() {
        let env = agent_environment(
            vars(&[
                ("HOME", "/home/u"),
                ("PATH", "/usr/bin:/bin"),
                ("NEORE_SECRET", "x"),
                ("AWS_SECRET_ACCESS_KEY", "y"),
            ]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/u"));
        assert!(!env.contains_key("NEORE_SECRET"));
        assert!(!env.contains_key("AWS_SECRET_ACCESS_KEY"));
        assert!(!env.contains_key("SSH_AUTH_SOCK"));
    }

    #[test]
    fn the_agent_socket_is_passed_on_only_when_the_host_has_one() {
        let env = agent_environment(
            vars(&[("SSH_AUTH_SOCK", "/run/agent.sock")]),
            &BTreeMap::new(),
        )
        .unwrap();

        assert_eq!(
            env.get("SSH_AUTH_SOCK").map(String::as_str),
            Some("/run/agent.sock")
        );
    }

    #[test]
    fn the_persons_variables_win_and_a_reserved_name_is_refused_again_here() {
        let mut user = BTreeMap::new();

        user.insert("PATH".to_owned(), "/opt/node/bin".to_owned());

        let env = agent_environment(vars(&[("PATH", "/usr/bin")]), &user).unwrap();

        assert_eq!(env.get("PATH").map(String::as_str), Some("/opt/node/bin"));

        user.insert("NODE_OPTIONS".to_owned(), "--require x".to_owned());

        assert!(agent_environment(vars(&[]), &user).is_err());
    }

    #[test]
    fn a_folder_outside_the_shared_ones_is_refused() {
        let root = std::env::temp_dir().join(format!("neore-agent-host-{}", std::process::id()));

        std::fs::create_dir_all(root.join("inside")).unwrap();

        let params = |cwd: &str| AgentParams {
            args: Vec::new(),
            command: "true".into(),
            cwd: cwd.to_owned(),
            env: BTreeMap::new(),
            roots: vec![root.to_string_lossy().into_owned()],
        };

        // The home guard makes a root that exposes the whole home unusable; a temp folder is not one.
        assert!(working_folder(&params(&root.join("inside").to_string_lossy())).is_ok());
        assert!(working_folder(&params("/")).is_err());
        assert!(working_folder(&params("relative")).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_persons_variables_cannot_replace_the_forwarded_agent_socket() {
        let mut user = BTreeMap::new();

        user.insert("SSH_AUTH_SOCK".to_owned(), "/tmp/attacker.sock".to_owned());

        // With a socket forwarded, and without one: the name is the host's to set, never the person's.
        assert!(agent_environment(vars(&[("SSH_AUTH_SOCK", "/run/agent.sock")]), &user).is_err());
        assert!(agent_environment(vars(&[]), &user).is_err());
    }

    #[test]
    fn a_failed_wait_is_a_failure_and_not_a_normal_exit() {
        let failed = exit_report(Err(std::io::Error::other("no child")));

        assert!(failed.unwrap_err().contains("could not wait for the agent"));

        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;

            let report = exit_report(Ok(std::process::ExitStatus::from_raw(0))).unwrap();

            assert_eq!(report["code"], 0);
        }
    }

    #[cfg(unix)]
    fn scratch_roots(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("neore-agent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (root, outside) = (base.join("shared"), base.join("private"));

        std::fs::create_dir_all(root.join("inside")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        (root, outside)
    }

    #[cfg(unix)]
    fn params_in(root: &std::path::Path, cwd: &std::path::Path) -> AgentParams {
        AgentParams {
            args: Vec::new(),
            command: "true".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            env: BTreeMap::new(),
            roots: vec![root.to_string_lossy().into_owned()],
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_dot_dot_path_and_a_symlink_out_of_the_shared_folder_are_refused_on_the_host() {
        let (root, outside) = scratch_roots("escape");

        // `..` that climbs out.
        let climbing = root.join("inside").join("..").join("..").join("private");

        assert!(working_folder(&params_in(&root, &climbing)).is_err());

        // A symlink inside the shared folder that points outside it: resolved here, on this machine, then checked.
        std::os::unix::fs::symlink(&outside, root.join("inside").join("link")).unwrap();

        let through = root.join("inside").join("link");

        assert!(working_folder(&params_in(&root, &through)).is_err());
        // A sibling that merely shares the prefix of the shared folder's name is outside too.
        std::fs::create_dir_all(root.with_file_name("shared-sibling")).unwrap();
        assert!(working_folder(&params_in(&root, &root.with_file_name("shared-sibling"))).is_err());
        // The folder itself still works.
        assert!(working_folder(&params_in(&root, &root.join("inside"))).is_ok());

        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_pump_ends_when_told_to_even_if_a_descendant_holds_the_pipe_open() {
        use std::os::fd::FromRawFd;

        let mut fds = [0 as libc::c_int; 2];

        // SAFETY: `fds` is two ints, as pipe(2) wants.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);

        // SAFETY: both descriptors were just made and are owned here.
        let (read, _held_write) = unsafe {
            (
                std::fs::File::from_raw_fd(fds[0]),
                std::fs::File::from_raw_fd(fds[1]),
            )
        };
        let (outbox, writer) = crate::outbox::Outbox::new(std::io::sink(), 1 << 20);
        let done = Arc::new(AtomicBool::new(false));
        let failed = AtomicBool::new(false);
        let pump = {
            let (outbox, done) = (outbox.clone(), Arc::clone(&done));

            thread::spawn(move || pump_output(read, CHUNK_TAG, 7, &outbox, &failed, &done))
        };

        thread::sleep(Duration::from_millis(150));
        assert!(!pump.is_finished(), "the write end is still open");
        done.store(true, Ordering::SeqCst);

        let waited = Instant::now();

        pump.join().unwrap();
        assert!(waited.elapsed() < Duration::from_secs(2));
        outbox.close();
        writer.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_that_leaves_a_descendant_holding_its_pipes_still_ends_its_request() {
        // The agent's PATH is built, not inherited, so the interpreter is named in full.
        let Ok(python) = Command::new("python3")
            .args(["-c", "import sys; print(sys.executable)"])
            .output()
        else {
            return;
        };
        let python = String::from_utf8_lossy(&python.stdout).trim().to_owned();

        let (root, _outside) = scratch_roots("leak");
        let mut params = params_in(&root, &root.join("inside"));

        params.command = "/bin/sh".into();
        params.args = vec![
            "-c".into(),
            // The sleeper leaves the agent's process group, and the shell waits to see it has before it exits: the
            // group is killed the moment the leader is gone.
            format!(
                "{python} -c 'import os; os.setsid(); open(\"left\", \"w\").close(); os.execvp(\"/bin/sleep\", [\"sleep\", \"30\"])' & \
                 while [ ! -e left ]; do /bin/sleep 0.02; done; exit 0"
            ),
        ];

        let (outbox, writer) = crate::outbox::Outbox::new(std::io::sink(), 1 << 20);
        let (_sender, bytes) = std::sync::mpsc::channel();
        let input = AgentInput {
            bytes,
            queued: Arc::default(),
        };
        let started = Instant::now();
        let result = run_agent(&params, 1, &outbox, input, &AtomicBool::new(false)).unwrap();

        // Ended by the agent's exit; the drain gave up on the sleeper after its grace and every thread was joined.
        assert_eq!(result["code"], 0);
        assert!(
            started.elapsed() >= DRAIN_GRACE,
            "the sleeper held the pipe"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        outbox.close();
        writer.join().unwrap();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}
