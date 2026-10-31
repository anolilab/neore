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

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_env::{app_vars, built_env, validate_env_var};
use crate::frame::{write_frame, CHUNK_HEADER_BYTES, CHUNK_TAG, STDERR_TAG};

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

/// Runs the agent until it exits or `stop` is set, relaying its output as chunk frames of request `id` on `writer`
/// and feeding its stdin from `input` (the stream ending closes it). Returns how it ended. An error is a request
/// that could not be served: nothing was started.
#[cfg(unix)]
pub fn run_agent<W: Write + Send + 'static>(
    params: &AgentParams,
    id: u64,
    writer: &Arc<Mutex<W>>,
    input: Receiver<Vec<u8>>,
    stop: &AtomicBool,
) -> Result<Value, String> {
    use std::os::unix::process::{CommandExt, ExitStatusExt};

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
    let exited = Arc::new(AtomicBool::new(false));

    if let Some(mut pipe) = child.stdin.take() {
        let exited = Arc::clone(&exited);

        // Not joined: it ends with the agent, with the stream of input, or with the pipe.
        thread::spawn(move || loop {
            match input.recv_timeout(Duration::from_millis(100)) {
                Ok(bytes) => {
                    if pipe.write_all(&bytes).and_then(|()| pipe.flush()).is_err() {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) if !exited.load(Ordering::SeqCst) => {}
                Err(_) => break,
            }
        });
    }

    let mut pumps = Vec::new();

    for (pipe, tag) in [
        (child.stdout.take().map(Pipe::Out), CHUNK_TAG),
        (child.stderr.take().map(Pipe::Err), STDERR_TAG),
    ] {
        let Some(mut pipe) = pipe else { continue };
        let (writer, failed) = (Arc::clone(writer), Arc::clone(&failed));

        pumps.push(thread::spawn(move || {
            let mut buffer = vec![0u8; CHUNK_BYTES];

            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let frame = chunk_frame(tag, id, &buffer[..read]);

                        // The desktop is gone: nobody reads the agent any more.
                        if write_frame(&mut *writer.lock().unwrap(), &frame).is_err() {
                            failed.store(true, Ordering::SeqCst);

                            break;
                        }
                    }
                }
            }
        }));
    }

    let mut terminated: Option<Instant> = None;
    let mut killed = false;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
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

    Ok(match status {
        Some(status) => json!({ "code": status.code(), "signal": status.signal() }),
        None => json!({ "code": null, "signal": null }),
    })
}

#[cfg(not(unix))]
pub fn run_agent<W: Write + Send + 'static>(
    _params: &AgentParams,
    _id: u64,
    _writer: &Arc<Mutex<W>>,
    _input: Receiver<Vec<u8>>,
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
}
