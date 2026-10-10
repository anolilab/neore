//! `shell_run`: one command through the user's shell, as the user, with a
//! timeout, stdin closed and captured output capped. Given a [`Policy`], it runs
//! inside the OS sandbox (`sandbox.rs`) with a private temp folder; without one
//! (only when the user allowed unsandboxed commands) the approval prompt is the
//! only control.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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

/// Reads a stream to the end (so the child never blocks on a full pipe) and
/// keeps at most `cap` bytes of it.
fn drain(
    mut stream: impl Read + Send + 'static,
    buffer: Arc<Mutex<(Vec<u8>, bool)>>,
    cap: usize,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];

        while let Ok(read) = stream.read(&mut chunk) {
            if read == 0 {
                break;
            }

            let mut guard = buffer.lock().unwrap();
            let room = cap.saturating_sub(guard.0.len());

            if read > room {
                guard.1 = true;
            }

            let keep = read.min(room);
            guard.0.extend_from_slice(&chunk[..keep]);
        }
    })
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
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
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
    let readers = [
        drain(child.stdout.take().expect("piped"), buffer.clone(), cap),
        drain(child.stderr.take().expect("piped"), buffer.clone(), cap),
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

    for reader in readers {
        let _ = reader.join();
    }

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
    #[cfg(target_os = "linux")]
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

    #[cfg(target_os = "linux")]
    fn landlock_or_skip() -> bool {
        match super::super::sandbox::support() {
            super::super::sandbox::Support::Available(_) => true,
            super::super::sandbox::Support::Unavailable(reason) => {
                eprintln!("skipping: {reason}");
                false
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_command_writes_only_inside_the_shared_folder() {
        if !landlock_or_skip() {
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
        assert!(result.output.contains("no-read"), "{}", result.output);
        assert!(
            !result.output.contains("WROTE-OUTSIDE"),
            "{}",
            result.output
        );
        assert!(
            !result.output.contains("TOP-SECRET-CONTENT"),
            "{}",
            result.output
        );
        assert!(shared.join("inside.txt").exists());
        assert!(!outside.join("escaped.txt").exists());

        let _ = std::fs::remove_dir_all(shared.parent().unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_command_cannot_read_the_home_folder() {
        if !landlock_or_skip() {
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
