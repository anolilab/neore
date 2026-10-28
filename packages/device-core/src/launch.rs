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
//! A host told to stop (SIGTERM) first kills the process group of every command it is running ([`exit_on_term`]):
//! the host's own thread is what enforces a command's timeout, so a host that just died would leave a long command
//! running unsupervised.
//!
//! With agent forwarding on, the session's `SSH_AUTH_SOCK` dies with the session. The host links it from a path in
//! the run folder that belongs to one desktop ([`stabilise_agent_socket`]) and its children inherit that path, which
//! a later session of the same desktop re-points. Another desktop on the same account has a link of its own.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The shortest Unix socket path limit of the platforms the host runs on (macOS).
const SOCKET_PATH_LIMIT: usize = 104;

/// Where a test points the run folder. The desktop starts the host with an empty environment, so no server's
/// session can set it.
pub const RUN_DIR_VARIABLE: &str = "NEORE_HOST_RUN_DIR";

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

/// A desktop tag is 16 lowercase hex characters (`SshPaths::desktop_tag`).
pub fn is_desktop_tag(text: &str) -> bool {
    text.len() == 16
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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

    pub fn path(&self) -> &Path {
        &self.path
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

/// Points `SSH_AUTH_SOCK` at a link in `dir` named for `desktop`, for this process and everything it starts. The
/// link is replaced atomically, so a later session of the same desktop re-points it for every host that uses it; a
/// session of another desktop links under its own name. Does nothing without a forwarded agent. Call before any
/// thread starts.
#[cfg(unix)]
pub fn stabilise_agent_socket(dir: &Path, desktop: &str) -> io::Result<Option<PathBuf>> {
    let Some(session) = std::env::var_os("SSH_AUTH_SOCK").map(PathBuf::from) else {
        return Ok(None);
    };

    if !session.is_absolute() || !is_desktop_tag(desktop) {
        std::env::remove_var("SSH_AUTH_SOCK");

        return Ok(None);
    }

    let link = dir.join(format!("agent-{desktop}.sock"));

    // A socket path holds 104 bytes on macOS (108 on Linux): past that the link would be no use, and the session's
    // own socket stays.
    if link.as_os_str().len() >= SOCKET_PATH_LIMIT {
        return Ok(None);
    }

    let link = link_agent_socket(dir, desktop, &session)?;

    std::env::set_var("SSH_AUTH_SOCK", &link);

    Ok(Some(link))
}

/// Points `dir/agent-<desktop>.sock` at `session`, replacing what it pointed at.
#[cfg(unix)]
fn link_agent_socket(dir: &Path, desktop: &str, session: &Path) -> io::Result<PathBuf> {
    private_dir(dir)?;

    let name = format!("agent-{desktop}.sock");
    let (link, temporary) = (
        dir.join(&name),
        dir.join(format!("{name}.{}", std::process::id())),
    );

    let _ = fs::remove_file(&temporary);
    std::os::unix::fs::symlink(session, &temporary)?;
    fs::rename(&temporary, &link)?;

    Ok(link)
}

/// Makes SIGTERM end the host the way a stop should: every command in flight is killed with its process group, the
/// launch file is removed and the process exits. The handler only writes a byte to a pipe; a thread does the rest.
#[cfg(unix)]
pub fn exit_on_term(pid_file: Option<PathBuf>) -> io::Result<()> {
    static WAKE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

    extern "C" fn on_term(_: libc::c_int) {
        let fd = WAKE.load(std::sync::atomic::Ordering::Relaxed);

        // SAFETY: write(2) is async-signal-safe; the byte is a constant.
        unsafe {
            libc::write(fd, [1u8].as_ptr().cast(), 1);
        }
    }

    let mut fds = [0 as libc::c_int; 2];

    // SAFETY: `fds` holds the two descriptors pipe(2) fills in.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }

    let (read, write) = (fds[0], fds[1]);

    // Neither end may reach the commands the host starts: a command that wrote to this pipe would stop the host.
    for fd in [read, write] {
        // SAFETY: setting a flag on a descriptor opened above.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }

    WAKE.store(write, std::sync::atomic::Ordering::Relaxed);

    // SAFETY: a zeroed sigaction with a handler and an empty mask is a valid argument.
    let installed = unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();

        action.sa_sigaction = on_term as extern "C" fn(libc::c_int) as usize;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut())
    };

    if installed != 0 {
        return Err(io::Error::last_os_error());
    }

    std::thread::spawn(move || {
        let mut byte = [0u8; 1];

        loop {
            // SAFETY: reading one byte into a buffer of one byte.
            let read_bytes = unsafe { libc::read(read, byte.as_mut_ptr().cast(), 1) };

            if read_bytes == 1 {
                break;
            }

            if read_bytes < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }

            return;
        }

        crate::shell::kill_running();

        if let Some(path) = pid_file {
            let _ = fs::remove_file(path);
        }

        std::process::exit(128 + libc::SIGTERM);
    });

    Ok(())
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

/// The command line of `pid`, split into its arguments, when it is running.
#[cfg(unix)]
fn command_line(pid: i64) -> Option<Vec<String>> {
    if let Ok(bytes) = fs::read(format!("/proc/{pid}/cmdline")) {
        let line = String::from_utf8_lossy(&bytes).into_owned();

        return Some(line.split('\0').map(str::to_owned).collect());
    }

    let output = std::process::Command::new("ps")
        .args(["-o", "args=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    (output.status.success() && !output.stdout.is_empty()).then(|| {
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .map(str::to_owned)
            .collect()
    })
}

/// Whether `pid` is a `neore-host` started as launch `id`: its program is `neore-host` and `--launch <id>` is among
/// its arguments.
#[cfg(unix)]
fn runs_launch(pid: i64, id: &str) -> bool {
    command_line(pid).is_some_and(|args| {
        args.first().and_then(|program| program.rsplit('/').next()) == Some("neore-host")
            && args
                .windows(2)
                .any(|pair| pair[0] == "--launch" && pair[1] == id)
    })
}

/// Sends SIGTERM to `pid` if it is launch `id`. On Linux the process is pinned with a pidfd before it is checked,
/// so the pid cannot be reused between the check and the signal.
#[cfg(unix)]
fn stop_launch(pid: i64, id: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: pidfd_open takes a pid and flags, and returns a descriptor or -1.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };

        if fd >= 0 {
            let fd = fd as libc::c_int;
            // SAFETY: pidfd_send_signal takes the descriptor, a signal, no siginfo and flags 0.
            let sent = runs_launch(pid, id)
                && unsafe {
                    libc::syscall(
                        libc::SYS_pidfd_send_signal,
                        fd,
                        libc::SIGTERM,
                        std::ptr::null::<libc::siginfo_t>(),
                        0,
                    )
                } == 0;

            // SAFETY: closing the descriptor opened above, once.
            unsafe {
                libc::close(fd);
            }

            return sent;
        }
    }

    // SAFETY: `kill` takes a plain pid and signal.
    runs_launch(pid, id) && unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0
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
            Some((pid, filed)) if filed == **id => {
                let sent = stop_launch(pid, id);

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
        let (mine, other) = ("0123456789abcdef", "fedcba9876543210");
        let link = link_agent_socket(&dir, mine, Path::new("/tmp/ssh-x/agent.1")).unwrap();

        assert_eq!(link, dir.join(format!("agent-{mine}.sock")));
        assert_eq!(
            fs::read_link(&link).unwrap(),
            Path::new("/tmp/ssh-x/agent.1")
        );

        // A later session of the same desktop re-points the same path; another desktop has a link of its own.
        link_agent_socket(&dir, mine, Path::new("/tmp/ssh-y/agent.2")).unwrap();
        link_agent_socket(&dir, other, Path::new("/tmp/ssh-z/agent.3")).unwrap();

        assert_eq!(
            fs::read_link(&link).unwrap(),
            Path::new("/tmp/ssh-y/agent.2")
        );
        assert_eq!(
            fs::read_link(dir.join(format!("agent-{other}.sock"))).unwrap(),
            Path::new("/tmp/ssh-z/agent.3")
        );

        let _ = fs::remove_dir_all(dir);
    }
}
