//! The OS sandbox around `shell_run`: an approved command can change files only
//! in the shared folders (and its own private temp folder), can read the system
//! and toolchain folders it needs to run, and cannot see the rest of the home
//! folder.
//!
//! - **Linux:** Landlock, applied in the child between `fork` and `exec` together
//!   with `PR_SET_NO_NEW_PRIVS`. The ruleset is built in the parent; the child
//!   only makes two syscalls. Best effort across ABIs (5.13+), but a kernel
//!   without Landlock is reported as unavailable, never silently skipped.
//! - **macOS:** `sandbox-exec` with a generated SBPL profile. Every path reaches
//!   the profile as a `-D` parameter, never spliced into its text.
//! - **Windows:** no sandbox. Commands run in a kill-on-close Job Object
//!   (`shell.rs`) and are reported as unsandboxed.
//!
//! Network access is NOT restricted on any platform. The user's "Require sandbox
//! for shell commands" setting (default on) refuses `shell_run` where
//! [`support`] says unavailable.

use std::path::{Path, PathBuf};

/// Whether this computer can confine a shell command, probed per call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Support {
    /// Commands run confined; the text names the mechanism.
    Available(String),
    /// Commands would run with the user's full access; the text says why.
    Unavailable(String),
}

/// What a sandboxed command may reach.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Read, write, create, delete and execute: the shared folders, plus the
    /// run's private temp folder (added by `shell.rs`).
    pub writable: Vec<PathBuf>,
    /// Read and execute only: system and toolchain folders. Missing ones are skipped.
    pub readable: Vec<PathBuf>,
    /// Hidden except for `writable`/`readable` entries under it (macOS; on
    /// Linux everything not listed is hidden anyway).
    pub home: Option<PathBuf>,
}

/// Read-only system folders on Linux. `/run` is NOT listed whole: the user's
/// `/run/user/<uid>` can hold credentials (e.g. container registry auth).
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
const LINUX_SYSTEM_READ: &[&str] = &[
    "/bin",
    "/dev",
    "/etc",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/nix",
    "/opt",
    "/proc",
    "/run/NetworkManager",
    "/run/current-system",
    "/run/resolvconf",
    "/run/systemd/resolve",
    "/sbin",
    "/snap",
    "/sys",
    "/usr",
];

/// Device files and shared memory a normal command writes to (`> /dev/null`).
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
const LINUX_DEVICE_WRITE: &[&str] = &[
    "/dev/full",
    "/dev/null",
    "/dev/ptmx",
    "/dev/pts",
    "/dev/random",
    "/dev/shm",
    "/dev/tty",
    "/dev/urandom",
    "/dev/zero",
];

/// Toolchain folders under the home folder, readable so `cargo`, `node`,
/// `python`… installed per user still run. Deliberately NOT whole `~/.cargo`
/// (credentials.toml), `~/.npmrc`, `~/.ssh`, `~/.config` or `~/.gitconfig`.
const HOME_TOOLCHAINS: &[&str] = &[
    ".asdf",
    ".bun",
    ".cargo/bin",
    ".deno",
    ".local/bin",
    ".local/lib",
    ".local/share/fnm",
    ".local/share/mise",
    ".local/share/pnpm",
    ".local/share/uv",
    ".nix-profile",
    ".nvm",
    ".pyenv",
    ".rbenv",
    ".rustup",
    ".sdkman",
    ".volta",
    "go/bin",
];

pub fn home() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");

    home.map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.parent().is_some())
}

impl Policy {
    /// The policy for commands in `roots` (canonical shared folders).
    pub fn for_roots(roots: &[PathBuf], home: Option<&Path>) -> Policy {
        let mut readable: Vec<PathBuf> = if cfg!(target_os = "linux") {
            LINUX_SYSTEM_READ.iter().map(PathBuf::from).collect()
        } else {
            Vec::new()
        };

        if let Some(home) = home {
            readable.extend(HOME_TOOLCHAINS.iter().map(|dir| home.join(dir)));
        }

        Policy {
            writable: roots.to_vec(),
            readable,
            home: home.map(Path::to_path_buf),
        }
    }
}

/// One Landlock rule: a folder (or file) and whether it is read-only.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LandlockRule {
    pub path: PathBuf,
    pub writable: bool,
}

/// The Landlock rules for `policy`: everything it lists, plus the device files.
/// Everything else — the home folder included — is unreachable.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub fn landlock_rules(policy: &Policy) -> Vec<LandlockRule> {
    let read = policy.readable.iter().map(|path| LandlockRule {
        path: path.clone(),
        writable: false,
    });
    let write = LINUX_DEVICE_WRITE
        .iter()
        .map(PathBuf::from)
        .chain(policy.writable.iter().cloned())
        .map(|path| LandlockRule {
            path,
            writable: true,
        });

    read.chain(write).collect()
}

/// The `sandbox-exec` profile and its `-D` parameters for `policy`. Later rules
/// win in SBPL, so each `deny` is followed by the exceptions to it.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub fn seatbelt_profile(policy: &Policy) -> (String, Vec<(String, String)>) {
    let mut params: Vec<(String, String)> = Vec::new();
    let mut param = |prefix: &str, path: &Path| {
        let name = format!("{prefix}_{}", params.len());

        params.push((name.clone(), path.to_string_lossy().into_owned()));
        format!("(subpath (param \"{name}\"))")
    };
    let writable: Vec<String> = policy
        .writable
        .iter()
        .map(|path| param("WRITE", path))
        .collect();
    let readable: Vec<String> = policy
        .readable
        .iter()
        .map(|path| param("READ", path))
        .collect();
    let mut profile = String::from(
        "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n    \
         (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/dtracehelper\")\n    \
         (regex #\"^/dev/tty\") (regex #\"^/dev/fd/\")",
    );

    for rule in &writable {
        profile.push_str("\n    ");
        profile.push_str(rule);
    }

    profile.push_str(")\n");

    if let Some(home) = &policy.home {
        params.push(("HOME".to_owned(), home.to_string_lossy().into_owned()));
        // Contents hidden; names and sizes (stat) stay visible so path walks work.
        profile.push_str(
            "(deny file-read* (subpath (param \"HOME\")))\n\
             (allow file-read-metadata (subpath (param \"HOME\")))\n",
        );

        if !writable.is_empty() || !readable.is_empty() {
            profile.push_str("(allow file-read*");

            for rule in writable.iter().chain(&readable) {
                profile.push_str("\n    ");
                profile.push_str(rule);
            }

            profile.push_str(")\n");
        }
    }

    (profile, params)
}

/// Keeps what the sandbox needs alive until the child has been spawned.
#[derive(Default)]
pub struct Guard {
    #[cfg(target_os = "linux")]
    _ruleset: Option<std::os::fd::OwnedFd>,
}

#[cfg(target_os = "linux")]
mod linux {
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    use landlock::{
        path_beneath_rules, Access, AccessFs, CompatLevel, Compatible, Ruleset, RulesetAttr,
        RulesetCreatedAttr, Scope, ABI,
    };

    use super::{landlock_rules, Guard, Policy};

    /// The kernel's Landlock ABI version, 0 when it has none.
    pub fn abi() -> i64 {
        const LANDLOCK_CREATE_RULESET_VERSION: libc::c_uint = 1;

        // SAFETY: the documented version query; no pointer is dereferenced.
        let version = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<libc::c_void>(),
                0usize,
                LANDLOCK_CREATE_RULESET_VERSION,
            )
        };

        version.max(0)
    }

    fn ruleset(policy: &Policy) -> Result<OwnedFd, String> {
        // The newest ABI this code was written and tested against; older
        // kernels get the subset they support (best effort).
        let target = ABI::V5;
        let rules = landlock_rules(policy);
        let read: Vec<_> = rules
            .iter()
            .filter(|rule| !rule.writable)
            .map(|rule| &rule.path)
            .collect();
        let write: Vec<_> = rules
            .iter()
            .filter(|rule| rule.writable)
            .map(|rule| &rule.path)
            .collect();
        let created = Ruleset::default()
            .set_compatibility(CompatLevel::BestEffort)
            .handle_access(AccessFs::from_all(target))
            .and_then(|ruleset| ruleset.scope(Scope::from_all(ABI::V6)))
            .and_then(|ruleset| ruleset.create())
            .and_then(|ruleset| {
                ruleset.add_rules(path_beneath_rules(read, AccessFs::from_read(target)))
            })
            .and_then(|ruleset| {
                ruleset.add_rules(path_beneath_rules(write, AccessFs::from_all(target)))
            })
            .map_err(|error| format!("could not build the sandbox: {error}"))?;

        Option::<OwnedFd>::from(created)
            .ok_or_else(|| "this kernel does not support Landlock".to_owned())
    }

    /// Confines `command`'s child with Landlock. Fails closed: if the child
    /// cannot restrict itself, it never execs and the spawn errors.
    pub fn confine(command: &mut Command, policy: &Policy) -> Result<Guard, String> {
        let ruleset = ruleset(policy)?;
        let fd = ruleset.as_raw_fd();

        // SAFETY: only async-signal-safe syscalls between fork and exec; `fd`
        // stays open in the parent (the guard) until the spawn has returned.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }

                if libc::syscall(libc::SYS_landlock_restrict_self, fd, 0u32) != 0 {
                    return Err(std::io::Error::last_os_error());
                }

                Ok(())
            });
        }

        Ok(Guard {
            _ruleset: Some(ruleset),
        })
    }
}

#[cfg(target_os = "linux")]
pub use linux::confine;

/// Whether `shell_run` can be sandboxed on this computer right now.
pub fn support() -> Support {
    #[cfg(target_os = "linux")]
    {
        match linux::abi() {
            0 => Support::Unavailable(
                "this Linux kernel has no Landlock (needs 5.13+ with Landlock enabled)".into(),
            ),
            abi => Support::Available(format!("Landlock ABI {abi}")),
        }
    }

    #[cfg(target_os = "macos")]
    {
        if Path::new(SANDBOX_EXEC).exists() {
            Support::Available("macOS sandbox-exec".into())
        } else {
            Support::Unavailable(format!("{SANDBOX_EXEC} is missing"))
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Support::Unavailable("there is no shell sandbox on this operating system".into())
    }
}

#[cfg(target_os = "macos")]
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Decides how a `shell_run` call runs: `Ok(Some)` sandboxed, `Ok(None)`
/// unsandboxed because the user allowed that, `Err` refused.
pub fn policy_for_call(
    support: &Support,
    allow_unsandboxed: bool,
    roots: &[PathBuf],
    home: Option<&Path>,
) -> Result<Option<Policy>, String> {
    match support {
        Support::Available(_) => Ok(Some(Policy::for_roots(roots, home))),
        Support::Unavailable(_) if allow_unsandboxed => Ok(None),
        Support::Unavailable(reason) => Err(format!(
            "shell commands must run sandboxed, and {reason}. To run them without a sandbox, \
             turn off \"Require sandbox for shell commands\" in this computer's device settings."
        )),
    }
}

/// The line the approval prompt shows about the sandbox.
pub fn describe(support: &Support, policy: Option<&Policy>) -> String {
    match (support, policy) {
        (Support::Available(mechanism), Some(_)) => format!(
            "Sandboxed ({mechanism}): it can change files only in the shared folders, reads only \
             system and toolchain folders besides them, and cannot see the rest of your home \
             folder. Network access is allowed."
        ),
        (Support::Unavailable(reason), _) => {
            format!("NOT sandboxed ({reason}): it runs with your full access to this computer.")
        }
        (Support::Available(_), None) => {
            "NOT sandboxed: it runs with your full access to this computer.".to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy {
            writable: vec![PathBuf::from("/home/me/project")],
            readable: vec![PathBuf::from("/usr"), PathBuf::from("/home/me/.rustup")],
            home: Some(PathBuf::from("/home/me")),
        }
    }

    #[test]
    fn the_policy_writes_only_the_roots_and_never_reads_the_whole_home() {
        let roots = vec![PathBuf::from("/home/me/project")];
        let policy = Policy::for_roots(&roots, Some(Path::new("/home/me")));

        assert_eq!(policy.writable, roots);
        assert!(!policy.readable.contains(&PathBuf::from("/home/me")));
        assert!(!policy.readable.contains(&PathBuf::from("/home/me/.cargo")));
        assert!(!policy.readable.contains(&PathBuf::from("/home/me/.ssh")));
        assert!(!policy.readable.contains(&PathBuf::from("/run")));
        assert!(policy
            .readable
            .contains(&PathBuf::from("/home/me/.cargo/bin")));
    }

    #[test]
    fn landlock_grants_writes_to_the_roots_and_devices_only() {
        let rules = landlock_rules(&policy());
        let writable: Vec<_> = rules
            .iter()
            .filter(|rule| rule.writable)
            .map(|rule| rule.path.clone())
            .collect();

        assert!(writable.contains(&PathBuf::from("/home/me/project")));
        assert!(writable.contains(&PathBuf::from("/dev/null")));
        assert!(!writable.contains(&PathBuf::from("/usr")));
        assert!(!writable
            .iter()
            .any(|path| path == Path::new("/home/me") || path == Path::new("/dev")));
        assert!(rules.contains(&LandlockRule {
            path: PathBuf::from("/usr"),
            writable: false,
        }));
        assert!(!rules.iter().any(|rule| rule.path == Path::new("/home/me")));
    }

    #[test]
    fn the_seatbelt_profile_passes_every_path_as_a_parameter() {
        let tricky = Policy {
            writable: vec![PathBuf::from("/tmp/a\") (allow default")],
            ..policy()
        };
        let (profile, params) = seatbelt_profile(&tricky);

        assert!(!profile.contains("/tmp/a"));
        assert!(!profile.contains("/home/me"));
        assert!(params.contains(&("WRITE_0".to_owned(), "/tmp/a\") (allow default".to_owned())));
        assert!(params.contains(&("HOME".to_owned(), "/home/me".to_owned())));
    }

    #[test]
    fn the_seatbelt_profile_denies_writes_and_home_reads_before_the_exceptions() {
        let (profile, params) = seatbelt_profile(&policy());
        let deny_write = profile.find("(deny file-write*)").unwrap();
        let allow_write = profile.find("(allow file-write*").unwrap();
        let deny_home = profile
            .find("(deny file-read* (subpath (param \"HOME\")))")
            .unwrap();
        let allow_read = profile.find("(allow file-read*\n").unwrap();

        assert!(profile.starts_with("(version 1)\n(allow default)\n"));
        assert!(deny_write < allow_write && allow_write < deny_home && deny_home < allow_read);
        assert!(profile[allow_write..deny_home].contains("(subpath (param \"WRITE_0\"))"));
        assert!(!profile[allow_write..deny_home].contains("READ_"));
        assert!(profile[allow_read..].contains("(subpath (param \"WRITE_0\"))"));
        assert!(profile[allow_read..].contains("(subpath (param \"READ_1\"))"));
        assert_eq!(params.len(), 4);
        assert_eq!(profile.matches('(').count(), profile.matches(')').count());
    }

    #[test]
    fn refuses_unsandboxed_unless_allowed() {
        let roots = vec![PathBuf::from("/srv/p")];
        let missing = Support::Unavailable("no Landlock".into());

        assert!(policy_for_call(&missing, false, &roots, None)
            .unwrap_err()
            .contains("no Landlock"));
        assert_eq!(policy_for_call(&missing, true, &roots, None), Ok(None));
        assert_eq!(
            policy_for_call(&Support::Available("x".into()), false, &roots, None)
                .unwrap()
                .unwrap()
                .writable,
            roots
        );
    }

    #[test]
    fn describes_the_sandbox_for_the_prompt() {
        let available = Support::Available("Landlock ABI 5".into());
        let missing = Support::Unavailable("no Landlock".into());

        assert!(describe(&available, Some(&policy())).starts_with("Sandboxed (Landlock ABI 5)"));
        assert!(describe(&missing, None).starts_with("NOT sandboxed (no Landlock)"));
    }
}
