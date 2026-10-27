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

use super::sandbox::{Guard, Policy};

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
    mut stream: impl Read + AsRawFd + Send + 'static,
    buffer: Arc<Mutex<(Vec<u8>, bool)>>,
    cap: usize,
    stop: Arc<AtomicBool>,
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
                Ok(read) => store(&buffer, &chunk[..read], cap),
            }
        }
    })
}

#[cfg(not(unix))]
fn drain(
    mut stream: impl Read + Send + 'static,
    buffer: Arc<Mutex<(Vec<u8>, bool)>>,
    cap: usize,
    _stop: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];

        while let Ok(read) = stream.read(&mut chunk) {
            if read == 0 {
                break;
            }

            store(&buffer, &chunk[..read], cap);
        }
    })
}

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

/// The run's private temp folder (owner-only), removed when the run ends. A
/// sandboxed command may write here and in the shared folders, nowhere else.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<TempDir, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let path = std::env::temp_dir().join(format!("neore-shell-{}-{nanos}", std::process::id()));
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
const CACHE_VARS: &[(&str, &str)] = &[
    ("BUN_INSTALL_CACHE_DIR", "bun"),
    ("GOCACHE", "go-build"),
    ("GOMODCACHE", "go-mod"),
    ("PIP_CACHE_DIR", "pip"),
    ("UV_CACHE_DIR", "uv"),
    ("XDG_CACHE_HOME", "xdg"),
    ("YARN_CACHE_FOLDER", "yarn"),
    ("npm_config_cache", "npm"),
];

/// The cache variables to set for a sandboxed run: each one under
/// `<temp>/cache/`, unless the user's own value already points inside a
/// shared folder (`roots`), which the sandbox lets it write.
fn cache_env(
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

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;

        let mut command = match policy {
            None => Command::new("sh"),
            Some(policy) => {
                let (profile, params) = super::sandbox::seatbelt_profile(policy);
                let mut command = Command::new(super::sandbox::SANDBOX_EXEC);

                command.arg("-p").arg(profile);

                for (name, value) in params {
                    command.arg("-D").arg(format!("{name}={value}"));
                }

                command.arg("/bin/sh");
                command
            }
        };

        command.args(["-c", line]);
        // Its own process group, so a timeout kills everything it started.
        command.process_group(0);
        Ok((command, Guard::default()))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::process::CommandExt;

        let mut command = Command::new("sh");
        command.args(["-c", line]);
        // Its own process group, so a timeout kills everything it started.
        command.process_group(0);

        let guard = match policy {
            #[cfg(target_os = "linux")]
            Some(policy) => super::sandbox::confine(&mut command, policy)?,
            #[cfg(not(target_os = "linux"))]
            Some(_) => return Err("there is no shell sandbox on this operating system".into()),
            None => Guard::default(),
        };

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

/// Runs `line` in `cwd`. With a `sandbox` policy it runs confined or not at
/// all: a sandbox that cannot be set up fails the call.
pub fn run(
    line: &str,
    cwd: &Path,
    timeout: Duration,
    cap: usize,
    sandbox: Option<&Policy>,
) -> Result<ShellOutput, String> {
    let temp = sandbox.map(|_| TempDir::new()).transpose()?;
    let policy = sandbox.zip(temp.as_ref()).map(|(policy, temp)| {
        let mut policy = policy.clone();

        policy.writable.push(temp.0.clone());
        policy
    });
    // Holds the Landlock ruleset open until the child has it; closed with the run.
    let (mut command, _guard) = command(line, policy.as_ref())?;

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

    if let Some((temp, sandbox)) = temp.as_ref().zip(sandbox) {
        command
            .env("TMPDIR", &temp.0)
            .env("TMP", &temp.0)
            .env("TEMP", &temp.0)
            .envs(cache_env(&temp.0, &sandbox.writable, |name| {
                std::env::var_os(name)
            }));
    }

    let spawned = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = spawned.map_err(|error| match sandbox {
        Some(_) => format!("could not start the sandboxed shell: {error}"),
        None => format!("could not start the shell: {error}"),
    })?;
    #[cfg(windows)]
    let _job = Job::attach(&child);

    let buffer = Arc::new(Mutex::new((Vec::new(), false)));
    let stop = Arc::new(AtomicBool::new(false));
    let readers = [
        drain(
            child.stdout.take().expect("piped"),
            buffer.clone(),
            cap,
            stop.clone(),
        ),
        drain(
            child.stderr.take().expect("piped"),
            buffer.clone(),
            cap,
            stop.clone(),
        ),
    ];
    let started = Instant::now();
    let mut timed_out = false;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                kill_tree(&mut child);
                break child.wait().ok();
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(error.to_string()),
        }
    };

    // Whatever the command started and left running dies with it; output it already
    // wrote stays readable in the pipe.
    kill_tree(&mut child);

    // A background child can inherit stdout and hold the pipe open after the
    // shell exits, so wait for the readers only up to a deadline. Unfinished
    // readers are left to end on their own; they write only into the capped buffer.
    let deadline = Instant::now() + READER_GRACE;

    for reader in readers {
        while !reader.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }

        if reader.is_finished() {
            let _ = reader.join();
        }
    }

    // Readers still open are held by a detached child. They see this flag within one poll slice and exit,
    // so repeated calls do not leave threads behind.
    stop.store(true, Ordering::Relaxed);

    let (bytes, truncated) = std::mem::take(&mut *buffer.lock().unwrap());

    Ok(ShellOutput {
        exit_code: status.and_then(|status| status.code()),
        output: String::from_utf8_lossy(&bytes).into_owned(),
        timed_out,
        truncated,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

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
                network,
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
                network,
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
                network,
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
            network: true,
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
}
