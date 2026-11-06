//! `shell_run`: one command through the user's shell, as the user, with a
//! timeout, stdin closed and captured output capped. Given a [`Policy`], it runs
//! inside the OS sandbox (`sandbox.rs`) with a private temp folder; without one
//! (only when the user allowed unsandboxed commands) the approval prompt is the
//! only control.

use std::io::Read;
#[cfg(unix)]
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::egress;
use super::sandbox::{Guard, NetworkTier, Policy};

pub struct ShellOutput {
    pub exit_code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
    pub truncated: bool,
}

/// How long a finished command may keep its output pipes open (a background child) before we return what we have.
const READER_GRACE: Duration = Duration::from_millis(500);

/// How long a unix reader waits for output before it checks whether it was told to stop.
const READER_POLL: Duration = Duration::from_millis(50);

/// Reads a stream to the end (so the child never blocks on a full pipe) and
/// keeps at most `cap` bytes of it. On unix the read waits in short slices, so
/// the reader sees `stop` even while a detached child still holds the pipe open.
#[cfg(unix)]
fn drain(
    stream: impl Read + AsRawFd + Send + 'static,
    buffer: Arc<Mutex<(Vec<u8>, bool)>>,
    cap: usize,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    drain_with(stream, buffer, cap, stop, store)
}

/// [`drain`], keeping what `keep` keeps of each chunk: the head (`store`) or the tail (`store_tail`).
#[cfg(unix)]
fn drain_with(
    mut stream: impl Read + AsRawFd + Send + 'static,
    buffer: Arc<Mutex<(Vec<u8>, bool)>>,
    cap: usize,
    stop: Arc<AtomicBool>,
    keep: Keep,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];

        while !stop.load(Ordering::Relaxed) {
            let mut ready = libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: `ready` is one valid pollfd for the whole call.
            let waited =
                unsafe { libc::poll(&mut ready, 1, READER_POLL.as_millis() as libc::c_int) };

            if waited < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }

                break;
            }

            if waited == 0 {
                continue;
            }

            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => keep(&buffer, &chunk[..read], cap),
            }
        }
    })
}

#[cfg(not(unix))]
fn drain(
    stream: impl Read + Send + 'static,
    buffer: Arc<Mutex<(Vec<u8>, bool)>>,
    cap: usize,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    drain_with(stream, buffer, cap, stop, store)
}

#[cfg(not(unix))]
fn drain_with(
    mut stream: impl Read + Send + 'static,
    buffer: Arc<Mutex<(Vec<u8>, bool)>>,
    cap: usize,
    _stop: Arc<AtomicBool>,
    keep: Keep,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];

        while let Ok(read) = stream.read(&mut chunk) {
            if read == 0 {
                break;
            }

            keep(&buffer, &chunk[..read], cap);
        }
    })
}

/// How a reader keeps what it read in its capped buffer.
type Keep = fn(&Mutex<(Vec<u8>, bool)>, &[u8], usize);

/// Appends a chunk to the capped buffer, and records when some of it did not fit.
fn store(buffer: &Mutex<(Vec<u8>, bool)>, chunk: &[u8], cap: usize) {
    let mut guard = buffer.lock().unwrap();
    let room = cap.saturating_sub(guard.0.len());

    if chunk.len() > room {
        guard.1 = true;
    }

    let keep = chunk.len().min(room);
    guard.0.extend_from_slice(&chunk[..keep]);
}

/// Appends a chunk and keeps only the last `cap` bytes, recording when some were dropped from the front.
fn store_tail(buffer: &Mutex<(Vec<u8>, bool)>, chunk: &[u8], cap: usize) {
    let mut guard = buffer.lock().unwrap();

    guard.0.extend_from_slice(chunk);

    if guard.0.len() > cap {
        let cut = guard.0.len() - cap;

        guard.0.drain(..cut);
        guard.1 = true;
    }
}

/// A kept tail as text, at most `cap` bytes long: a character the cut split at the front is dropped, not shown as a
/// replacement. Invalid bytes decode to U+FFFD, three bytes each, so the decoded text can outgrow `cap`; then its front
/// is cut at a character boundary. Returns whether anything was cut, beyond the bytes already dropped.
fn tail_text(bytes: &[u8], truncated: bool, cap: usize) -> (String, bool) {
    let start = if truncated {
        bytes
            .iter()
            .take_while(|byte| (**byte & 0xC0) == 0x80)
            .count()
    } else {
        0
    };
    let text = String::from_utf8_lossy(&bytes[start..]).into_owned();

    if text.len() <= cap {
        return (text, false);
    }

    let mut cut = text.len() - cap;

    while !text.is_char_boundary(cut) {
        cut += 1;
    }

    (text[cut..].to_owned(), true)
}

/// The run's private temp folder (owner-only), removed when the run ends. A
/// sandboxed command may write here and in the shared folders, nowhere else.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<TempDir, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        // The clock alone can repeat (coarse on macOS) when two runs start together, so a counter makes it unique.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let count = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "neore-shell-{}-{nanos}-{count}",
            std::process::id()
        ));
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;

            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            builder
        };
        #[cfg(not(unix))]
        let builder = std::fs::DirBuilder::new();

        builder
            .create(&path)
            .and_then(|()| std::fs::canonicalize(&path))
            .map(TempDir)
            .map_err(|error| format!("could not create the temp folder: {error}"))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Cache variables pointed into the run's temp folder, so tools that cache in
/// the (hidden, read-only) home folder still work sandboxed. `CARGO_HOME` and
/// `RUSTUP_HOME` are deliberately absent: they name the real toolchain.
pub(crate) const CACHE_VARS: &[(&str, &str)] = &[
    ("BUN_INSTALL_CACHE_DIR", "bun"),
    ("COREPACK_HOME", "corepack"),
    ("DENO_DIR", "deno"),
    ("GOCACHE", "go-build"),
    ("GOMODCACHE", "go-mod"),
    ("PIP_CACHE_DIR", "pip"),
    ("UV_CACHE_DIR", "uv"),
    ("UV_TOOL_DIR", "uv-tools"),
    ("XDG_CACHE_HOME", "xdg"),
    ("YARN_CACHE_FOLDER", "yarn"),
    ("npm_config_cache", "npm"),
];

/// The cache variables to set for a sandboxed run: each one under
/// `<temp>/cache/`, unless the user's own value already points inside a
/// shared folder (`roots`), which the sandbox lets it write.
pub(crate) fn cache_env(
    temp: &Path,
    roots: &[PathBuf],
    current: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<(&'static str, PathBuf)> {
    CACHE_VARS
        .iter()
        .filter(|(name, _)| {
            !current(name).map(PathBuf::from).is_some_and(|value| {
                value.is_absolute() && roots.iter().any(|root| value.starts_with(root))
            })
        })
        .map(|(name, dir)| (*name, temp.join("cache").join(dir)))
        .collect()
}

fn command(line: &str, policy: Option<&Policy>) -> Result<(Command, Guard), String> {
    #[cfg(windows)]
    {
        if policy.is_some() {
            return Err("there is no shell sandbox on this operating system".into());
        }

        let mut command = Command::new("cmd");
        command.args(["/C", line]);
        Ok((command, Guard::default()))
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // `sh` is looked up on PATH; the sandboxed macOS shell is `sandbox-exec`'s, by absolute path.
        let program = if cfg!(target_os = "macos") {
            "/bin/sh"
        } else {
            "sh"
        };
        let (mut command, guard) = match policy {
            Some(policy) => super::sandbox::sandboxed_command(policy, program, &["-c", line])?,
            None => {
                let mut command = Command::new("sh");

                command.args(["-c", line]);

                (command, Guard::default())
            }
        };

        // Its own process group, so a timeout kills everything it started.
        command.process_group(0);

        Ok((command, guard))
    }
}

/// Windows: the command and everything it starts live in a Job Object that is
/// killed when the run ends (kill-on-close) and capped at 4 GiB. Not a sandbox.
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Job {
    fn attach(child: &Child) -> Option<Job> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: plain Win32 calls on a handle we own and the child's live handle.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());

            if handle.is_null() {
                return None;
            }

            let job = Job(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();

            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                | JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.JobMemoryLimit = 4 << 30;

            let configured = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0;

            (configured && AssignProcessToJobObject(handle, child.as_raw_handle()) != 0)
                .then_some(job)
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateJobObjectW and is closed once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

// SAFETY: the handle names a kernel object, not memory of this thread. The value is moved once, into the thread that
// waits on the run, and that thread alone closes it, so it is never used from two threads at once.
#[cfg(windows)]
unsafe impl Send for Job {}

/// The runs in flight (their process groups), so a host that is told to stop can end them: only the thread that
/// started a run enforces its timeout, and that thread dies with the host. Once stopping, a run that registers late
/// is killed on the spot.
#[cfg(unix)]
static RUNNING: Mutex<Running> = Mutex::new(Running {
    pids: Vec::new(),
    stopping: false,
});

#[cfg(unix)]
struct Running {
    pids: Vec<u32>,
    stopping: bool,
}

/// Notes a run's group while it lives and forgets it however the run ends.
#[cfg(unix)]
pub struct Tracked(u32);

#[cfg(unix)]
impl Tracked {
    pub fn new(pid: u32) -> Self {
        let mut running = RUNNING.lock().unwrap();

        running.pids.push(pid);

        if running.stopping {
            kill_group(pid);
        }

        Tracked(pid)
    }
}

#[cfg(unix)]
impl Drop for Tracked {
    fn drop(&mut self) {
        RUNNING.lock().unwrap().pids.retain(|pid| *pid != self.0);
    }
}

/// Kills the process group `process_group(0)` made for a run. The result is not checked: ESRCH means it ended.
#[cfg(unix)]
fn kill_group(pid: u32) {
    // SAFETY: plain syscall with no memory arguments; the group is one this process made.
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

/// Kills every run in flight, background children included, and every run that starts from now on. For a host that
/// was told to stop. A descendant that left the run's process group (`setsid`) is out of reach: the group is the
/// only handle there is without a cgroup.
#[cfg(unix)]
pub fn kill_running() {
    let mut running = RUNNING.lock().unwrap();

    running.stopping = true;

    for pid in &running.pids {
        kill_group(*pid);
    }
}

/// Whether the child has exited. On Unix the child is left unreaped (`WNOWAIT`), so its process group id stays reserved until the
/// caller signals the group and reaps it with `wait`.
fn has_exited(child: &mut Child) -> std::io::Result<bool> {
    #[cfg(unix)]
    {
        // SAFETY: `info` is a plain out-parameter, zeroed first; `WNOWAIT` keeps an exited child a zombie for the caller to reap.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };

        if rc == -1 {
            return Err(std::io::Error::last_os_error());
        }

        // SAFETY: the call above filled `info`; a zero pid means no state change yet.
        Ok(unsafe { info.si_pid() } != 0)
    }

    #[cfg(not(unix))]
    {
        Ok(child.try_wait()?.is_some())
    }
}

fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // A negative pid signals the process group `process_group(0)` made for the run. Signalled directly: an
        // external `kill` can fail on Linux and leave a background child running, and nothing would notice.
        // SAFETY: plain syscall with no memory arguments. The result is not checked: ESRCH means the group already ended.
        unsafe {
            libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let _ = child.kill();
}

/// The only variables a sandboxed command inherits. Everything else (IPC
/// sockets, agents, tokens) is dropped; the run's own temp and cache folders are
/// added on top by `run`.
const SANDBOX_ENV: &[&str] = &["PATH", "HOME", "LANG", "TERM"];

/// A started command and what must outlive it: its temp folder, the network filter and the sandbox guard. Each is
/// dropped only after the command (and its process group) has ended.
struct Spawned {
    child: Child,
    /// The network filter of a sandboxed `Dependencies` run; the single place such a program may connect to.
    proxy: Option<egress::Proxy>,
    #[cfg(unix)]
    tracked: Option<Tracked>,
    #[cfg(windows)]
    _job: Option<Job>,
    // Dropped last (fields drop in order): the Landlock ruleset and the temp folder the command may still use.
    _guard: Guard,
    _temp: Option<TempDir>,
}

/// Starts `line` in `cwd` with stdout and stderr piped and stdin closed. With a `sandbox` policy it starts confined or
/// not at all. `env` is set on top of the allowlist and under the run's own temp, cache and proxy variables, which win.
fn spawn(
    line: &str,
    cwd: &Path,
    sandbox: Option<&Policy>,
    env: &[(String, String)],
) -> Result<Spawned, String> {
    let temp = sandbox.map(|_| TempDir::new()).transpose()?;
    // Lives until the run ends. Only a sandboxed `Dependencies` run has one: it is the single place such a
    // program may connect to.
    let proxy = match sandbox {
        Some(policy) if policy.network == NetworkTier::Dependencies => Some(
            egress::Proxy::start()
                .map_err(|error| format!("could not start the network filter: {error}"))?,
        ),
        _ => None,
    };
    let policy = sandbox.zip(temp.as_ref()).map(|(policy, temp)| {
        let mut policy = policy.clone();

        policy.writable.push(temp.0.clone());
        policy.proxy_port = proxy.as_ref().map(egress::Proxy::port);
        policy
    });
    // Holds the Landlock ruleset open until the child has it; closed with the run.
    let (mut command, guard) = command(line, policy.as_ref())?;

    if sandbox.is_some() {
        // A sandboxed command gets an allowlist, not the user's environment: no
        // D-Bus, ssh-agent, GPG or runtime-dir variables that point at IPC.
        command.env_clear();

        for name in SANDBOX_ENV {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }

    command.envs(env.iter().map(|(name, value)| (name, value)));

    if let Some((temp, sandbox)) = temp.as_ref().zip(sandbox) {
        command
            .env("TMPDIR", &temp.0)
            .env("TMP", &temp.0)
            .env("TEMP", &temp.0)
            .envs(cache_env(&temp.0, &sandbox.writable, |name| {
                std::env::var_os(name)
            }));
    }

    if let Some(proxy) = &proxy {
        command.envs(egress::proxy_env(proxy.port()));
    }

    let spawned = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let child = spawned.map_err(|error| match sandbox {
        Some(_) => format!("could not start the sandboxed shell: {error}"),
        None => format!("could not start the shell: {error}"),
    })?;
    #[cfg(windows)]
    let job = Job::attach(&child);
    #[cfg(unix)]
    let tracked = Some(Tracked::new(child.id()));

    Ok(Spawned {
        child,
        proxy,
        #[cfg(unix)]
        tracked,
        #[cfg(windows)]
        _job: job,
        _guard: guard,
        _temp: temp,
    })
}

/// Waits out the readers of a command that ended: up to [`READER_GRACE`], since a background child can inherit stdout
/// and hold the pipe open after the shell exits. Readers still open see `stop` within one poll slice and exit.
fn finish_readers(readers: [thread::JoinHandle<()>; 2], stop: &AtomicBool) {
    let deadline = Instant::now() + READER_GRACE;

    for reader in &readers {
        while !reader.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }

    stop.store(true, Ordering::Relaxed);

    // A unix reader leaves within one poll slice of `stop`, so joining it cannot wait on a child that holds the pipe. A reader
    // left running here would append output after the caller had published the command's end.
    #[cfg(unix)]
    for reader in readers {
        let _ = reader.join();
    }

    #[cfg(not(unix))]
    for reader in readers {
        if reader.is_finished() {
            let _ = reader.join();
        }
    }
}

/// Runs `line` in `cwd`. With a `sandbox` policy it runs confined or not at
/// all: a sandbox that cannot be set up fails the call.
pub fn run(
    line: &str,
    cwd: &Path,
    timeout: Duration,
    cap: usize,
    sandbox: Option<&Policy>,
) -> Result<ShellOutput, String> {
    let mut spawned = spawn(line, cwd, sandbox, &[])?;
    let buffer = Arc::new(Mutex::new((Vec::new(), false)));
    let stop = Arc::new(AtomicBool::new(false));
    let readers = [
        drain(
            spawned.child.stdout.take().expect("piped"),
            buffer.clone(),
            cap,
            stop.clone(),
        ),
        drain(
            spawned.child.stderr.take().expect("piped"),
            buffer.clone(),
            cap,
            stop.clone(),
        ),
    ];
    let started = Instant::now();
    let mut timed_out = false;

    let status = loop {
        match spawned.child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                kill_tree(&mut spawned.child);
                break spawned.child.wait().ok();
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(error.to_string()),
        }
    };

    // Whatever the command started and left running dies with it; output it already
    // wrote stays readable in the pipe.
    kill_tree(&mut spawned.child);

    // The group is gone, so a host that stops now must not signal its number: it may be someone else's by then.
    #[cfg(unix)]
    drop(spawned.tracked.take());

    // The readers are joined: once stopped they leave within a poll slice, so nothing is written after the output is read.
    finish_readers(readers, &stop);

    let (bytes, truncated) = std::mem::take(&mut *buffer.lock().unwrap());
    let exit_code = status.and_then(|status| status.code());
    let mut output = String::from_utf8_lossy(&bytes).into_owned();

    // A failed run that asked the filter for a host it does not list: say so, or the failure reads as a broken network.
    if let Some(proxy) = spawned.proxy.as_ref().filter(|_| exit_code != Some(0)) {
        output.push_str(&proxy.refused_note());
    }

    Ok(ShellOutput {
        exit_code,
        output,
        timed_out,
        truncated,
    })
}

/// How a terminal's command ended: its exit code, or the signal that ended it.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// What a terminal printed so far (its tail) and, once it has ended, how.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub exit_status: Option<TerminalExit>,
    pub output: String,
    pub truncated: bool,
}

struct TerminalState {
    exit: Option<TerminalExit>,
    kill: bool,
}

struct TerminalShared {
    buffer: Arc<Mutex<(Vec<u8>, bool)>>,
    changed: std::sync::Condvar,
    state: Mutex<TerminalState>,
}

/// A command started for a coding agent's `terminal/create` (`acp_terminal.rs`): it returns at once and is read
/// while it runs. It always runs in the sandbox (the type takes a policy, never an absent one), keeps the tail of its
/// output, and is killed with its whole process group when killed, dropped, past `timeout`, or once its shell ended
/// (background children die with it, as for `shell_run`). One watcher thread owns the process.
pub struct Terminal {
    shared: Arc<TerminalShared>,
    cap: usize,
}

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGTERM => "SIGTERM".into(),
        other => format!("SIG{other}"),
    }
}

fn exit_of(status: Option<std::process::ExitStatus>) -> TerminalExit {
    let Some(status) = status else {
        return TerminalExit::default();
    };
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;

        status.signal().map(signal_name)
    };
    #[cfg(not(unix))]
    let signal = None;

    TerminalExit {
        exit_code: status.code(),
        signal,
    }
}

impl Terminal {
    /// Starts `line` in `cwd` inside `sandbox`, keeping the last `cap` bytes of its output. Fails when the sandbox cannot
    /// be set up: a terminal never runs outside it.
    pub fn start(
        line: &str,
        cwd: &Path,
        sandbox: &Policy,
        env: &[(String, String)],
        cap: usize,
        timeout: Duration,
    ) -> Result<Terminal, String> {
        let mut spawned = spawn(line, cwd, Some(sandbox), env)?;
        let buffer = Arc::new(Mutex::new((Vec::new(), false)));
        let stop = Arc::new(AtomicBool::new(false));
        let readers = [
            drain_with(
                spawned.child.stdout.take().expect("piped"),
                buffer.clone(),
                cap,
                stop.clone(),
                store_tail,
            ),
            drain_with(
                spawned.child.stderr.take().expect("piped"),
                buffer.clone(),
                cap,
                stop.clone(),
                store_tail,
            ),
        ];
        let shared = Arc::new(TerminalShared {
            buffer,
            changed: std::sync::Condvar::new(),
            state: Mutex::new(TerminalState {
                exit: None,
                kill: false,
            }),
        });
        let watched = Arc::clone(&shared);

        thread::spawn(move || {
            let started = Instant::now();
            // The leader is observed, not reaped, until its group has been signalled: an unreaped leader keeps its process group id
            // reserved, so the group signal cannot reach a process that took that id after the leader was gone.
            loop {
                let kill = watched.state.lock().unwrap().kill;

                match has_exited(&mut spawned.child) {
                    Ok(true) | Err(_) => break,
                    Ok(false) if kill || started.elapsed() >= timeout => break,
                    Ok(false) => thread::sleep(Duration::from_millis(25)),
                }
            }

            kill_tree(&mut spawned.child);
            let status = spawned.child.wait().ok();
            #[cfg(unix)]
            drop(spawned.tracked.take());
            finish_readers(readers, &stop);

            let exit = exit_of(status);

            if let Some(proxy) = spawned.proxy.as_ref().filter(|_| exit.exit_code != Some(0)) {
                store_tail(&watched.buffer, proxy.refused_note().as_bytes(), cap);
            }

            // The temp folder, the filter and the guard go only now, after the group is gone.
            drop(spawned);
            watched.state.lock().unwrap().exit = Some(exit);
            watched.changed.notify_all();
        });

        Ok(Terminal { shared, cap })
    }

    /// The tail of the output so far and, once the command has ended, how it ended.
    pub fn output(&self) -> TerminalOutput {
        // Read before the exit, so an ended terminal's output is whole: the watcher sets the exit after its readers.
        let exit_status = self.shared.state.lock().unwrap().exit.clone();
        let (bytes, truncated) = self.shared.buffer.lock().unwrap().clone();
        let (output, cut) = tail_text(&bytes, truncated, self.cap);

        TerminalOutput {
            exit_status,
            output,
            truncated: truncated || cut,
        }
    }

    /// Blocks until the command ended, or `limit` passed (`None` then).
    pub fn wait(&self, limit: Duration) -> Option<TerminalExit> {
        let state = self.shared.state.lock().unwrap();
        let (state, _) = self
            .shared
            .changed
            .wait_timeout_while(state, limit, |state| state.exit.is_none())
            .unwrap();

        state.exit.clone()
    }

    /// Ends the command and everything it started. Its output stays readable.
    pub fn kill(&self) {
        self.shared.state.lock().unwrap().kill = true;
    }

    pub fn exited(&self) -> bool {
        self.shared.state.lock().unwrap().exit.is_some()
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[allow(dead_code)]
    fn tier(network: bool) -> NetworkTier {
        if network {
            NetworkTier::On
        } else {
            NetworkTier::Off
        }
    }

    #[test]
    fn a_reader_returns_once_stopped_even_while_its_pipe_stays_open() {
        let (reader, writer) = std::io::pipe().expect("pipe");
        let buffer = Arc::new(Mutex::new((Vec::new(), false)));
        let stop = Arc::new(AtomicBool::new(false));
        let handle = drain(reader, buffer, 64, stop.clone());

        stop.store(true, Ordering::Relaxed);

        let (done, finished) = std::sync::mpsc::channel();

        thread::spawn(move || {
            let _ = handle.join();
            let _ = done.send(());
        });

        let returned = finished.recv_timeout(Duration::from_secs(5)).is_ok();

        // The writer stays open until the reader has been judged, the way a detached child would hold it.
        drop(writer);
        assert!(
            returned,
            "the reader stayed blocked on a pipe that a detached child holds open"
        );
    }

    #[test]
    fn returns_when_a_background_child_holds_stdout() {
        let started = Instant::now();
        let result = run(
            "sleep 30 & echo done",
            Path::new("/"),
            Duration::from_secs(10),
            64 * 1024,
            None,
        )
        .unwrap();

        assert!(result.output.contains("done"));
        assert!(!result.timed_out);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn kills_background_children_when_the_command_finishes() {
        let marker = std::env::temp_dir().join(format!("neore-shell-bg-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let result = run(
            &format!("(sleep 1; touch '{}') & echo done", marker.display()),
            Path::new("/"),
            Duration::from_secs(10),
            1024,
            None,
        )
        .unwrap();

        thread::sleep(Duration::from_millis(1500));

        assert!(result.output.contains("done"));
        assert!(!marker.exists());
    }

    #[test]
    fn captures_output_and_exit_code() {
        let result = run(
            "echo hello; echo oops 1>&2; exit 3",
            Path::new("/"),
            Duration::from_secs(5),
            1024,
            None,
        )
        .unwrap();

        assert!(result.output.contains("hello"));
        assert!(result.output.contains("oops"));
        assert_eq!(result.exit_code, Some(3));
        assert!(!result.timed_out);
    }

    #[test]
    fn kills_the_whole_group_on_timeout() {
        let started = Instant::now();
        let result = run(
            "sleep 5 & sleep 5",
            Path::new("/"),
            Duration::from_millis(200),
            1024,
            None,
        )
        .unwrap();

        assert!(result.timed_out);
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn caps_the_output() {
        let result = run(
            "yes | head -c 100000",
            Path::new("/"),
            Duration::from_secs(5),
            1000,
            None,
        )
        .unwrap();

        assert_eq!(result.output.len(), 1000);
        assert!(result.truncated);
    }

    /// A shared folder and a folder next to it, both under a fresh temp dir.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn folders(name: &str) -> (PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("neore-sandbox-{name}-{}", std::process::id()));
        let shared = base.join("shared");
        let outside = base.join("outside");

        std::fs::create_dir_all(&shared).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "TOP-SECRET-CONTENT").unwrap();

        (
            std::fs::canonicalize(shared).unwrap(),
            std::fs::canonicalize(outside).unwrap(),
        )
    }

    /// The first Bash the sandbox tests can run, by absolute path so the test
    /// does not depend on the test process's `PATH`.
    #[cfg(target_os = "linux")]
    fn bash_path() -> Option<&'static str> {
        ["/bin/bash", "/usr/bin/bash"]
            .into_iter()
            .find(|path| Path::new(path).exists())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn sandbox_or_skip() -> bool {
        #[cfg(target_os = "linux")]
        {
            if let Err(reason) = super::super::sandbox::network_filter() {
                eprintln!("skipping: {reason}");
                return false;
            }
        }

        match super::super::sandbox::support() {
            super::super::sandbox::Support::Available(_) => true,
            super::super::sandbox::Support::Unavailable(reason) => {
                eprintln!("skipping: {reason}");
                false
            }
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_sandboxed_command_writes_only_inside_the_shared_folder() {
        if !sandbox_or_skip() {
            return;
        }

        let (shared, outside) = folders("write");
        let policy = Policy::for_roots(std::slice::from_ref(&shared), None);
        let result = run(
            &format!(
                "echo in > inside.txt && echo ok-inside; \
                 echo out > '{0}/escaped.txt' && echo WROTE-OUTSIDE; \
                 cat '{0}/secret.txt' || echo no-read; \
                 echo tmp > \"$TMPDIR/t\" && echo ok-tmp; \
                 ls /usr > /dev/null && echo ok-system; \
                 mkdir -p \"$XDG_CACHE_HOME/x\" && echo ok-cache",
                outside.display()
            ),
            &shared,
            Duration::from_secs(10),
            4096,
            Some(&policy),
        )
        .unwrap();

        assert!(result.output.contains("ok-inside"), "{}", result.output);
        assert!(result.output.contains("ok-tmp"), "{}", result.output);
        assert!(result.output.contains("ok-system"), "{}", result.output);
        assert!(result.output.contains("ok-cache"), "{}", result.output);
        // Reads outside the shared folder are confined on Linux only; macOS does not
        // confine them yet (see the report on the sandbox read policy).
        #[cfg(target_os = "linux")]
        assert!(result.output.contains("no-read"), "{}", result.output);
        assert!(
            !result.output.contains("WROTE-OUTSIDE"),
            "{}",
            result.output
        );
        #[cfg(target_os = "linux")]
        assert!(
            !result.output.contains("TOP-SECRET-CONTENT"),
            "{}",
            result.output
        );
        assert!(shared.join("inside.txt").exists());
        assert!(!outside.join("escaped.txt").exists());

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    /// The seccomp network filter reaches the real child, and only when the
    /// policy has no network. The count is relative, since a container or
    /// service manager may already filter the test process itself.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_command_gets_the_network_filter_only_without_network() {
        if !sandbox_or_skip() {
            return;
        }

        let (shared, _outside) = folders("seccomp");
        let filters = |network: bool| {
            let policy = Policy {
                network: tier(network),
                ..Policy::for_roots(std::slice::from_ref(&shared), None)
            };
            let result = run(
                "grep '^Seccomp_filters:' /proc/self/status",
                &shared,
                Duration::from_secs(10),
                4096,
                Some(&policy),
            )
            .unwrap();

            result
                .output
                .trim()
                .trim_start_matches("Seccomp_filters:")
                .trim()
                .parse::<u32>()
                .unwrap_or_else(|_| panic!("unexpected output: {}", result.output))
        };

        assert_eq!(filters(false), filters(true) + 1);

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    /// A shell that opens a TCP connection to a local listener: refused with
    /// no network, accepted with it. Skipped without bash (`/dev/tcp`).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_command_cannot_connect_without_network() {
        if !sandbox_or_skip() {
            return;
        }
        let Some(bash) = bash_path() else {
            return;
        };

        let (shared, _outside) = folders("connect");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let line = format!(
            "{bash} -c 'exec 3<>/dev/tcp/127.0.0.1/{}' && echo connected || echo refused",
            listener.local_addr().unwrap().port()
        );
        let outcome = |network: bool| {
            let policy = Policy {
                network: tier(network),
                ..Policy::for_roots(std::slice::from_ref(&shared), None)
            };

            run(&line, &shared, Duration::from_secs(10), 4096, Some(&policy))
                .unwrap()
                .output
        };

        assert!(outcome(false).contains("refused"));
        assert!(outcome(true).contains("connected"));

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    /// A connected socket the parent leaves inheritable is closed in the child,
    /// whatever the network setting: the seccomp filter only stops new sockets.
    /// The unsandboxed control proves the descriptor does reach a child.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_command_cannot_use_an_inherited_socket() {
        if !sandbox_or_skip() {
            return;
        }
        let Some(bash) = bash_path() else {
            return;
        };

        let (shared, _outside) = folders("inherited");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let fd = client.as_raw_fd();

        // SAFETY: plain flag update on a descriptor this test owns.
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFD, 0) }, 0);

        let line = format!("{bash} -c 'echo x >&{fd}' 2>/dev/null && echo leaked || echo closed");
        let outcome = |policy: Option<&Policy>| {
            run(&line, &shared, Duration::from_secs(10), 4096, policy)
                .unwrap()
                .output
        };

        assert!(outcome(None).contains("leaked"));

        for network in [false, true] {
            let policy = Policy {
                network: tier(network),
                ..Policy::for_roots(std::slice::from_ref(&shared), None)
            };

            assert!(
                outcome(Some(&policy)).contains("closed"),
                "network: {network}"
            );
        }

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    /// The descriptor sweep must leave the close-on-exec pipe `std` reports an
    /// `exec` failure through, or a missing program would look like a success.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_spawn_still_reports_a_failed_exec() {
        if !sandbox_or_skip() {
            return;
        }

        let (shared, _outside) = folders("exec-error");
        let policy = Policy::for_roots(std::slice::from_ref(&shared), None);
        let mut command = Command::new("/nonexistent/neore-program");
        let _guard = super::super::sandbox::confine(&mut command, &policy).unwrap();
        let error = command.spawn().unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    /// A sandboxed command inherits only the allowlisted environment, so a
    /// variable that points at an IPC socket never reaches it.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_sandboxed_command_does_not_inherit_ipc_variables() {
        if !sandbox_or_skip() {
            return;
        }

        let (shared, _outside) = folders("env");
        let policy = Policy::for_roots(std::slice::from_ref(&shared), None);

        std::env::set_var("NEORE_TEST_IPC_SOCKET", "/tmp/not-for-the-sandbox");

        let result = run(
            "echo ipc=${NEORE_TEST_IPC_SOCKET:-absent} path=${PATH:+set}",
            &shared,
            Duration::from_secs(10),
            4096,
            Some(&policy),
        )
        .unwrap();

        assert!(result.output.contains("ipc=absent"), "{}", result.output);
        assert!(result.output.contains("path=set"), "{}", result.output);

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    /// The macOS escape routes are denied inside the sandbox. The control run,
    /// unsandboxed, proves the same commands do succeed (so "failed" means denied).
    #[cfg(target_os = "macos")]
    #[test]
    fn a_sandboxed_command_cannot_exec_the_app_escape_tools() {
        if !sandbox_or_skip() {
            return;
        }

        let (shared, _outside) = folders("exec");
        let policy = Policy::for_roots(std::slice::from_ref(&shared), None);
        let line = "/usr/bin/osascript -e 'return 1' >/dev/null 2>&1; echo osa=$?; \
                    /usr/bin/open -g -a Finder >/dev/null 2>&1; echo open=$?; \
                    /bin/launchctl version >/dev/null 2>&1; echo lctl=$?";

        let sandboxed = run(line, &shared, Duration::from_secs(20), 4096, Some(&policy)).unwrap();
        let control = run(line, &shared, Duration::from_secs(20), 4096, None).unwrap();

        assert!(control.output.contains("osa=0"), "{}", control.output);
        assert!(!sandboxed.output.contains("osa=0"), "{}", sandboxed.output);
        assert!(!sandboxed.output.contains("open=0"), "{}", sandboxed.output);
        assert!(!sandboxed.output.contains("lctl=0"), "{}", sandboxed.output);

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    // Only macOS enforces the network setting (see `sandbox.rs`).
    #[cfg(target_os = "macos")]
    #[test]
    fn a_sandboxed_command_cannot_reach_the_network_unless_allowed() {
        if !sandbox_or_skip() {
            return;
        }

        // Loopback is network too: a listener this test owns accepts the connect.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let command = format!(
            "exec 3<>/dev/tcp/127.0.0.1/{} && echo CONNECTED",
            listener.local_addr().unwrap().port()
        );
        let (shared, _) = folders("network");
        let blocked = Policy::for_roots(std::slice::from_ref(&shared), None);
        let allowed = Policy {
            network: NetworkTier::On,
            ..blocked.clone()
        };
        let run_with = |policy: &Policy| {
            run(
                &command,
                &shared,
                Duration::from_secs(10),
                4096,
                Some(policy),
            )
            .unwrap()
        };

        let refused = run_with(&blocked);
        let open = run_with(&allowed);

        assert!(!refused.output.contains("CONNECTED"), "{}", refused.output);
        assert!(open.output.contains("CONNECTED"), "{}", open.output);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_sandboxed_command_cannot_read_the_home_folder() {
        if !sandbox_or_skip() {
            return;
        }

        // Stands in for $HOME: a folder the policy names as home but does not share.
        let (shared, fake_home) = folders("home");
        let policy = Policy::for_roots(std::slice::from_ref(&shared), Some(&fake_home));
        let result = run(
            &format!(
                "ls '{0}' && echo LISTED; cat '{0}/secret.txt'",
                fake_home.display()
            ),
            &shared,
            Duration::from_secs(10),
            4096,
            Some(&policy),
        )
        .unwrap();

        assert!(!result.output.contains("LISTED"), "{}", result.output);
        assert!(
            !result.output.contains("TOP-SECRET-CONTENT"),
            "{}",
            result.output
        );

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    #[test]
    fn caches_go_to_the_temp_folder_unless_already_in_a_shared_folder() {
        let temp = Path::new("/tmp/neore-shell-1");
        let roots = vec![PathBuf::from("/work/project")];
        let env = cache_env(temp, &roots, |name| match name {
            "npm_config_cache" => Some("/work/project/.npm".into()),
            "PIP_CACHE_DIR" => Some("/home/me/.cache/pip".into()),
            "GOCACHE" => Some("relative/project".into()),
            _ => None,
        });
        let names: Vec<_> = env.iter().map(|(name, _)| *name).collect();

        assert!(!names.contains(&"npm_config_cache"));
        assert!(env.contains(&("PIP_CACHE_DIR", temp.join("cache/pip"))));
        assert!(env.contains(&("GOCACHE", temp.join("cache/go-build"))));
        assert!(env.contains(&("XDG_CACHE_HOME", temp.join("cache/xdg"))));
        assert!(!names.contains(&"CARGO_HOME") && !names.contains(&"RUSTUP_HOME"));
        assert_eq!(env.len(), CACHE_VARS.len() - 1);
        assert!(env.iter().all(|(_, path)| path.starts_with(temp)));
    }

    #[test]
    fn the_private_temp_folder_is_removed_after_the_run() {
        let temp = TempDir::new().unwrap();
        let path = temp.0.clone();

        assert!(path.is_dir());
        drop(temp);
        assert!(!path.exists());
    }

    #[test]
    fn a_tail_keeps_the_end_and_drops_a_character_split_at_the_front() {
        let buffer = Mutex::new((Vec::new(), false));

        store_tail(&buffer, "abé".as_bytes(), 3);
        store_tail(&buffer, b"xy", 3);

        let (bytes, truncated) = buffer.lock().unwrap().clone();

        assert!(truncated);
        // "é" is two bytes; the cut left only its second, which is not shown.
        assert_eq!(tail_text(&bytes, truncated, 3), ("xy".to_owned(), false));
    }

    #[test]
    fn a_tail_of_invalid_bytes_stays_within_its_cap() {
        // Each 0xFF decodes to a three-byte replacement, so a 6-byte cap is exceeded by the decoded text unless it is cut.
        let bytes = [0xFF_u8; 6];
        let (text, cut) = tail_text(&bytes, false, 6);

        assert!(text.len() <= 6, "{text:?} is {} bytes", text.len());
        assert!(cut);
        assert_eq!(text, "\u{FFFD}\u{FFFD}");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn terminal_policy(name: &str) -> Option<(Policy, PathBuf, PathBuf)> {
        if !sandbox_or_skip() {
            return None;
        }

        let (shared, outside) = folders(name);

        Some((
            Policy::for_roots(std::slice::from_ref(&shared), None),
            shared,
            outside,
        ))
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_terminal_output_does_not_change_once_its_end_is_reported() {
        let Some((policy, shared, _)) = terminal_policy("sealed") else {
            return;
        };
        // A background child keeps the pipe open past the shell's exit and writes once more later. Guard, not a repro: the
        // group is killed with the shell, so the late line should never be written at all.
        let terminal = Terminal::start(
            "echo first; (sleep 1; echo late) & exit 0",
            &shared,
            &policy,
            &[],
            64 * 1024,
            Duration::from_secs(20),
        )
        .unwrap();

        terminal.wait(Duration::from_secs(20)).expect("ended");
        let at_end = terminal.output().output;

        std::thread::sleep(Duration::from_millis(1500));

        assert!(at_end.contains("first"));
        assert_eq!(terminal.output().output, at_end);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_terminal_returns_at_once_and_reports_its_output_and_exit_later() {
        let Some((policy, shared, _)) = terminal_policy("term-exit") else {
            return;
        };
        // The command waits for a gate the test opens after `start` has returned: returning at once is then shown by the command
        // still running, not by a wall-clock limit that a loaded machine can miss.
        let terminal = Terminal::start(
            "until [ -f gate ]; do sleep 0.05; done; echo first; echo second 1>&2; exit 3",
            &shared,
            &policy,
            &[],
            64 * 1024,
            Duration::from_secs(30),
        )
        .unwrap();

        assert!(terminal.output().exit_status.is_none());
        std::fs::write(shared.join("gate"), b"").unwrap();

        let exit = terminal.wait(Duration::from_secs(20)).expect("ended");
        let output = terminal.output();

        assert_eq!(exit.exit_code, Some(3));
        assert_eq!(output.exit_status, Some(exit));
        assert!(output.output.contains("first") && output.output.contains("second"));
        assert!(!output.truncated);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_killed_terminal_ends_with_its_group_and_says_so() {
        let Some((policy, shared, _)) = terminal_policy("term-kill") else {
            return;
        };
        let terminal = Terminal::start(
            "sleep 30 & sleep 30",
            &shared,
            &policy,
            &[],
            1024,
            Duration::from_secs(60),
        )
        .unwrap();

        assert!(terminal.wait(Duration::from_millis(200)).is_none());
        terminal.kill();

        let exit = terminal.wait(Duration::from_secs(10)).expect("ended");

        assert_eq!(exit.exit_code, None);
        assert_eq!(exit.signal.as_deref(), Some("SIGKILL"));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_terminal_keeps_the_tail_of_a_long_output_and_stops_at_its_timeout() {
        let Some((policy, shared, _)) = terminal_policy("term-tail") else {
            return;
        };
        let long = Terminal::start(
            "yes | head -c 100000; echo END",
            &shared,
            &policy,
            &[],
            1000,
            Duration::from_secs(30),
        )
        .unwrap();

        long.wait(Duration::from_secs(20)).expect("ended");

        let output = long.output();

        assert!(output.truncated);
        assert_eq!(output.output.len(), 1000);
        assert!(output.output.ends_with("END\n"));

        let slow = Terminal::start(
            "sleep 30",
            &shared,
            &policy,
            &[],
            1024,
            Duration::from_millis(300),
        )
        .unwrap();

        assert_eq!(
            slow.wait(Duration::from_secs(10))
                .and_then(|exit| exit.signal),
            Some("SIGKILL".to_owned())
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_terminal_writes_only_inside_the_shared_folder_and_sees_the_variables_it_was_given() {
        let Some((policy, shared, outside)) = terminal_policy("term-write") else {
            return;
        };
        let terminal = Terminal::start(
            &format!(
                "echo \"$GREETING\"; echo in > inside.txt; echo out > '{}/escaped.txt' || echo refused",
                outside.display()
            ),
            &shared,
            &policy,
            &[("GREETING".to_owned(), "hello".to_owned())],
            64 * 1024,
            Duration::from_secs(30),
        )
        .unwrap();

        terminal.wait(Duration::from_secs(20)).expect("ended");

        let output = terminal.output().output;

        assert!(output.contains("hello"), "{output}");
        assert!(output.contains("refused"), "{output}");
        assert!(shared.join("inside.txt").exists());
        assert!(!outside.join("escaped.txt").exists());
    }
}
