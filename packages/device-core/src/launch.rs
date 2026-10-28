//! What ties a running `neore-host` to the computer that started it.
//!
//! The desktop starts the host as `neore-host --stdio --launch <id>` with an id it drew itself. The host files
//! `run/<id>.pid` (its pid and the id) and removes the file when it ends. A connection that is lost leaves its host
//! running until the server notices the dead socket, so the desktop asks the next host, over the pipe, to stop the
//! launches it remembers ([`reap`]). That is the only way a host is ever stopped from outside, and it stops only an
//! id the desktop names, after checking the process still carries that id on its command line (a pid can be reused).
//! A host this computer did not start, such as another computer's session or one left by an earlier run of the
//! desktop, is counted and left alone.
//!
//! With agent forwarding on, the session's `SSH_AUTH_SOCK` dies with the session. The host links it from a fixed
//! path in the run folder ([`stabilise_agent_socket`]) and its children inherit that path, which a later session
//! re-points.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Where a test points the run folder. The desktop starts the host with an empty environment, so no server's
/// session can set it.
pub const RUN_DIR_VARIABLE: &str = "NEORE_HOST_RUN_DIR";
const AGENT_SOCKET: &str = "agent.sock";

/// A launch id is 32 lowercase hex characters: it goes into a file name and a command line.
pub fn is_launch_id(text: &str) -> bool {
    text.len() == 32
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `~/.neore/host/run`, or the folder a test named.
pub fn run_dir() -> Option<PathBuf> {
    match std::env::var_os(RUN_DIR_VARIABLE).map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => Some(dir),
        Some(_) => None,
        None => crate::sandbox::home().map(|home| home.join(".neore").join("host").join("run")),
    }
}

fn pid_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.pid"))
}

/// This process's pid file. Dropping it removes the file.
pub struct Launch {
    id: String,
    path: PathBuf,
}

impl Launch {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Files `dir/<id>.pid` for this process, creating `dir` owner-only.
    pub fn register(id: &str, dir: &Path) -> io::Result<Launch> {
        if !is_launch_id(id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a launch id is 32 hex characters",
            ));
        }

        private_dir(dir)?;

        let path = pid_file(dir, id);
        let temporary = dir.join(format!("{id}.pid.tmp"));

        fs::write(&temporary, format!("{}\n{id}\n", std::process::id()))?;
        set_private(&temporary)?;
        fs::rename(&temporary, &path)?;

        Ok(Launch {
            id: id.to_owned(),
            path,
        })
    }
}

impl Drop for Launch {
    fn drop(&mut self) {
        // Only the file this process wrote: a reused id would be someone else's.
        if read_pid_file(&self.path).is_some_and(|(pid, _)| pid == std::process::id() as i64) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

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

fn set_private(file: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(file, fs::Permissions::from_mode(0o600))
    }

    #[cfg(not(unix))]
    {
        let _ = file;

        Ok(())
    }
}

/// `(pid, launch id)` from a pid file.
fn read_pid_file(path: &Path) -> Option<(i64, String)> {
    let text = fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    let pid = lines
        .next()?
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|pid| *pid > 1)?;
    let id = lines.next()?.trim().to_owned();

    is_launch_id(&id).then_some((pid, id))
}

/// Points `SSH_AUTH_SOCK` at a fixed link in `dir` instead of the session's own socket, for this process and
/// everything it starts. The link is replaced atomically, so a session that starts later re-points it for every
/// host that uses it. Does nothing without a forwarded agent. Call before any thread starts.
#[cfg(unix)]
pub fn stabilise_agent_socket(dir: &Path) -> io::Result<Option<PathBuf>> {
    let Some(session) = std::env::var_os("SSH_AUTH_SOCK").map(PathBuf::from) else {
        return Ok(None);
    };

    if !session.is_absolute() {
        std::env::remove_var("SSH_AUTH_SOCK");

        return Ok(None);
    }

    let link = link_agent_socket(dir, &session)?;

    std::env::set_var("SSH_AUTH_SOCK", &link);

    Ok(Some(link))
}

/// Points `dir/agent.sock` at `session`, replacing what it pointed at.
#[cfg(unix)]
fn link_agent_socket(dir: &Path, session: &Path) -> io::Result<PathBuf> {
    private_dir(dir)?;

    let (link, temporary) = (
        dir.join(AGENT_SOCKET),
        dir.join(format!("{AGENT_SOCKET}.{}", std::process::id())),
    );

    let _ = fs::remove_file(&temporary);
    std::os::unix::fs::symlink(session, &temporary)?;
    fs::rename(&temporary, &link)?;

    Ok(link)
}

/// What a reap found.
#[derive(Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct Reaped {
    /// Ids that were running and were stopped.
    pub stopped: Vec<String>,
    /// Ids that were already gone (their file, if any, is cleaned up).
    pub gone: Vec<String>,
    /// Other hosts running here that were not asked about: not touched.
    pub others: usize,
}

/// The command line of `pid`, when it is running.
#[cfg(unix)]
fn command_line(pid: i64) -> Option<String> {
    if let Ok(bytes) = fs::read(format!("/proc/{pid}/cmdline")) {
        return Some(String::from_utf8_lossy(&bytes).replace('\0', " "));
    }

    let output = std::process::Command::new("ps")
        .args(["-o", "args=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    (output.status.success() && !output.stdout.is_empty())
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(unix)]
fn runs_launch(pid: i64, id: &str) -> bool {
    command_line(pid).is_some_and(|line| line.contains(&format!("--launch {id}")))
}

/// Stops the launches in `ids` that are still running, and counts the other hosts it finds. `own` is the caller's
/// launch and is never stopped. Only ids the caller names are touched; a pid file whose process is gone is removed.
#[cfg(unix)]
pub fn reap(dir: &Path, ids: &[String], own: Option<&str>) -> Reaped {
    let mut reaped = Reaped::default();
    let asked: Vec<&String> = ids
        .iter()
        .filter(|id| is_launch_id(id) && Some(id.as_str()) != own)
        .collect();

    for id in &asked {
        let path = pid_file(dir, id);

        match read_pid_file(&path) {
            Some((pid, filed)) if filed == **id && runs_launch(pid, id) => {
                // SAFETY: `kill` takes a plain pid and signal; the pid was checked above.
                let sent = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0;

                let _ = fs::remove_file(&path);

                if sent {
                    reaped.stopped.push((*id).clone());
                } else {
                    reaped.gone.push((*id).clone());
                }
            }
            _ => {
                let _ = fs::remove_file(&path);

                reaped.gone.push((*id).clone());
            }
        }
    }

    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".pid"))
            .filter(|id| is_launch_id(id))
            .map(str::to_owned)
        else {
            continue;
        };

        if Some(id.as_str()) == own || asked.iter().any(|asked| **asked == id) {
            continue;
        }

        match read_pid_file(&path) {
            Some((pid, filed)) if filed == id && runs_launch(pid, &id) => reaped.others += 1,
            _ => {
                let _ = fs::remove_file(&path);
            }
        }
    }

    reaped
}

#[cfg(not(unix))]
pub fn reap(_dir: &Path, _ids: &[String], _own: Option<&str>) -> Reaped {
    Reaped::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neore-launch-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);

        dir
    }

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn only_32_lowercase_hex_characters_are_a_launch_id() {
        assert!(is_launch_id(A));
        assert!(!is_launch_id("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assert!(!is_launch_id(&A[..31]));
        assert!(!is_launch_id("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;"));
        assert!(!is_launch_id("../../../../etc/passwd/aaaaaaaaaa"));
    }

    #[test]
    fn a_launch_files_its_pid_owner_only_and_removes_it_when_dropped() {
        let dir = dir("register");
        let launch = Launch::register(A, &dir).unwrap();
        let path = dir.join(format!("{A}.pid"));

        assert_eq!(
            read_pid_file(&path),
            Some((i64::from(std::process::id()), A.to_owned()))
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }

        drop(launch);

        assert!(!path.exists());
        assert!(Launch::register("not-an-id", &dir).is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_pid_file_whose_process_does_not_carry_the_id_is_never_signalled() {
        let dir = dir("reuse");

        fs::create_dir_all(&dir).unwrap();
        // The test process is alive, and its command line has no `--launch <id>`.
        fs::write(pid_file(&dir, A), format!("{}\n{A}\n", std::process::id())).unwrap();

        let reaped = reap(&dir, &[A.to_owned()], None);

        assert_eq!(reaped.gone, [A]);
        assert!(reaped.stopped.is_empty());
        assert!(!pid_file(&dir, A).exists(), "the stale file stays behind");

        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn dead_pid_files_are_pruned_and_unnamed_launches_are_left_alone() {
        let dir = dir("prune");

        fs::create_dir_all(&dir).unwrap();
        // A process that is gone, filed under an id nobody asked about.
        let mut done = std::process::Command::new("true").spawn().unwrap();
        let pid = i64::from(done.id());

        done.wait().unwrap();
        fs::write(pid_file(&dir, B), format!("{pid}\n{B}\n")).unwrap();

        let reaped = reap(&dir, &[], None);

        assert_eq!(reaped, Reaped::default());
        assert!(!pid_file(&dir, B).exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_session_socket_is_replaced_by_a_stable_link_in_the_run_folder() {
        let dir = dir("agent");
        let link = link_agent_socket(&dir, Path::new("/tmp/ssh-x/agent.1")).unwrap();

        assert_eq!(link, dir.join("agent.sock"));
        assert_eq!(
            fs::read_link(&link).unwrap(),
            Path::new("/tmp/ssh-x/agent.1")
        );

        // A later session re-points the same path.
        link_agent_socket(&dir, Path::new("/tmp/ssh-y/agent.2")).unwrap();

        assert_eq!(
            fs::read_link(&link).unwrap(),
            Path::new("/tmp/ssh-y/agent.2")
        );

        let _ = fs::remove_dir_all(dir);
    }
}
