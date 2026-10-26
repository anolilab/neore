//! The OS sandbox around `shell_run`: an approved command can change files only
//! in the shared folders (and its own private temp folder), can read the system
//! and toolchain folders it needs to run, and cannot see the rest of the home
//! folder.
//!
//! - **Linux:** Landlock, applied in the child between `fork` and `exec` together
//!   with `PR_SET_NO_NEW_PRIVS`. The ruleset is built in the parent; the child
//!   only makes a few syscalls. Best effort across ABIs (5.13+), but a kernel
//!   without Landlock is reported as unavailable, never silently skipped. With
//!   the network off, a seccomp-bpf filter is installed right after it: it
//!   makes `socket(2)` fail with `EPERM` for `AF_INET` and `AF_INET6` (and
//!   refuses `io_uring_setup`, whose `IORING_OP_SOCKET` would sidestep it).
//!   `AF_UNIX` and the rest stay open. If the filter cannot be installed the
//!   spawn fails, so the command never runs unconfined.
//! - **macOS:** `sandbox-exec` with a generated SBPL profile. Every path reaches
//!   the profile as a `-D` parameter, never spliced into its text.
//! - **Windows:** no sandbox. Commands run in a kill-on-close Job Object
//!   (`shell.rs`) and are reported as unsandboxed.
//!
//! Network access is blocked on macOS and Linux unless the user allows it
//! ([`Policy::network`]); on Linux that means no new IPv4/IPv6 sockets. Windows
//! does not restrict it. The user's
//! "Require sandbox for shell commands" setting (default on) refuses `shell_run`
//! where [`support`] says unavailable.

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
    /// Whether the command may reach the network. macOS denies it when false;
    /// Linux refuses new IPv4/IPv6 sockets (seccomp). Windows does not enforce it.
    pub network: bool,
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
/// Terminals (`/dev/tty*`, `/dev/pts/*`) are deliberately absent: a command that
/// can write to one can inject keys into the user's other sessions (TIOCSTI).
/// Landlock cannot restrict the ioctl itself, so withholding write is the control.
/// They stay readable through `/dev` in [`LINUX_SYSTEM_READ`].
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
const LINUX_DEVICE_WRITE: &[&str] = &[
    "/dev/full",
    "/dev/null",
    "/dev/ptmx",
    "/dev/random",
    "/dev/shm",
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
            network: false,
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
    // A denylist over `allow default`, not full confinement: the escape routes
    // to other apps (`open`, `osascript`, `launchctl`), Apple events and the
    // launch-services lookup are closed; other binaries still run.
    let mut profile = String::from(
        "(version 1)\n(allow default)\n(deny file-write*)\n\
         (deny process-exec (literal \"/usr/bin/open\") (literal \"/usr/bin/osascript\") (literal \"/bin/launchctl\"))\n\
         (deny appleevent-send)\n\
         (deny mach-lookup (global-name \"com.apple.coreservices.launchservicesd\"))\n",
    );

    if !policy.network {
        profile.push_str("(deny network*)\n");
    }

    profile.push_str(
        "(allow file-write*\n    \
         (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/dtracehelper\")\n    \
         (regex #\"^/dev/fd/\")",
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

    // The classic BPF opcodes the filter uses (`linux/bpf_common.h`).
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JMP_JEQ_K: u16 = 0x15;
    #[cfg(target_arch = "x86_64")]
    const BPF_JMP_JGE_K: u16 = 0x35;
    const BPF_RET_K: u16 = 0x06;

    // `struct seccomp_data` offsets: `nr`, `arch`, then `args[0]`. Argument 0
    // is read as its low 32-bit word, which sits first only on little endian.
    #[cfg(target_endian = "big")]
    compile_error!("the seccomp network filter reads argument 0 as a little-endian word");

    const OFFSET_NR: u32 = 0;
    const OFFSET_ARCH: u32 = 4;
    const OFFSET_ARG0: u32 = 16;

    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = 0xC000_003E;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = 0xC000_00B7;

    /// x32 syscalls report the x86_64 arch with this bit set in the number.
    #[cfg(target_arch = "x86_64")]
    const X32_SYSCALL_BIT: u32 = 0x4000_0000;

    /// Where a filter instruction goes next.
    #[derive(Clone, Copy)]
    enum To {
        Next,
        Allow,
        Deny,
        Kill,
    }

    fn statement(code: u16, k: u32) -> (u16, u32, To, To) {
        (code, k, To::Next, To::Next)
    }

    fn branch(code: u16, k: u32, yes: To, no: To) -> (u16, u32, To, To) {
        (code, k, yes, no)
    }

    /// The seccomp-bpf program for a command that may not use the network:
    /// `socket(AF_INET | AF_INET6 | AF_PACKET, ..)` and `io_uring_setup` fail with `EPERM`,
    /// every other syscall is allowed, and a process of another architecture
    /// (32-bit compat, x32) is killed. Fails when this architecture has no
    /// filter, so an unsupported machine never runs a command unconfined.
    pub fn network_filter() -> Result<Vec<libc::sock_filter>, String> {
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        {
            Err("the network sandbox supports only x86_64 and aarch64 Linux".to_owned())
        }

        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        {
            let mut program = vec![
                statement(BPF_LD_W_ABS, OFFSET_ARCH),
                branch(BPF_JMP_JEQ_K, AUDIT_ARCH, To::Next, To::Kill),
                statement(BPF_LD_W_ABS, OFFSET_NR),
            ];

            #[cfg(target_arch = "x86_64")]
            program.push(branch(BPF_JMP_JGE_K, X32_SYSCALL_BIT, To::Kill, To::Next));

            program.extend([
                branch(
                    BPF_JMP_JEQ_K,
                    libc::SYS_io_uring_setup as u32,
                    To::Deny,
                    To::Next,
                ),
                branch(BPF_JMP_JEQ_K, libc::SYS_socket as u32, To::Next, To::Allow),
                statement(BPF_LD_W_ABS, OFFSET_ARG0),
                branch(BPF_JMP_JEQ_K, libc::AF_INET as u32, To::Deny, To::Next),
                branch(BPF_JMP_JEQ_K, libc::AF_INET6 as u32, To::Deny, To::Next),
                branch(BPF_JMP_JEQ_K, libc::AF_PACKET as u32, To::Deny, To::Allow),
            ]);

            let allow = program.len();
            let target = |from: usize, to: To| -> u8 {
                let index = match to {
                    To::Next => from + 1,
                    To::Allow => allow,
                    To::Deny => allow + 1,
                    To::Kill => allow + 2,
                };

                u8::try_from(index - from - 1).expect("filter jumps stay short")
            };
            let mut filter: Vec<libc::sock_filter> = program
                .iter()
                .enumerate()
                .map(|(from, &(code, k, yes, no))| libc::sock_filter {
                    code,
                    jt: target(from, yes),
                    jf: target(from, no),
                    k,
                })
                .collect();
            let ret = |k: u32| libc::sock_filter {
                code: BPF_RET_K,
                jt: 0,
                jf: 0,
                k,
            };

            filter.push(ret(libc::SECCOMP_RET_ALLOW));
            filter.push(ret(libc::SECCOMP_RET_ERRNO | libc::EPERM as u32));
            filter.push(ret(libc::SECCOMP_RET_KILL_PROCESS));

            Ok(filter)
        }
    }

    /// Installs `filter` on the calling thread. Only `prctl`: safe between
    /// `fork` and `exec`.
    ///
    /// # Safety
    /// The caller must be the process that is about to `exec` (or a test child),
    /// since the filter cannot be removed.
    pub unsafe fn install_filter(filter: &[libc::sock_filter]) -> std::io::Result<()> {
        let program = libc::sock_fprog {
            len: filter.len() as libc::c_ushort,
            filter: filter.as_ptr().cast_mut(),
        };

        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err(std::io::Error::last_os_error());
        }

        if libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER as libc::c_ulong,
            std::ptr::addr_of!(program),
        ) != 0
        {
            return Err(std::io::Error::last_os_error());
        }

        Ok(())
    }

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

    /// Confines `command`'s child with Landlock and, when the policy has no
    /// network, a seccomp filter on new IPv4/IPv6 sockets. Fails closed: if the
    /// child cannot restrict itself, it never execs and the spawn errors.
    pub fn confine(command: &mut Command, policy: &Policy) -> Result<Guard, String> {
        let ruleset = ruleset(policy)?;
        let fd = ruleset.as_raw_fd();
        let filter = if policy.network {
            None
        } else {
            Some(network_filter()?)
        };

        // SAFETY: only async-signal-safe syscalls between fork and exec (the
        // filter is built here, in the parent); `fd` stays open in the parent
        // (the guard) until the spawn has returned.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }

                if libc::syscall(libc::SYS_landlock_restrict_self, fd, 0u32) != 0 {
                    return Err(std::io::Error::last_os_error());
                }

                match &filter {
                    Some(filter) => install_filter(filter),
                    None => Ok(()),
                }
            });
        }

        Ok(Guard {
            _ruleset: Some(ruleset),
        })
    }
}

#[cfg(target_os = "linux")]
pub use linux::confine;

#[cfg(all(target_os = "linux", test))]
pub use linux::{install_filter, network_filter};

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
/// `support`, narrowed to what a command with this network setting can
/// enforce. A command without network needs a seccomp filter, which this
/// architecture may not be able to build, so the prompt must not claim a
/// sandbox that every approved command would then fail to start under.
#[cfg(target_os = "linux")]
fn enforceable(support: &Support, network: bool) -> Support {
    if let (Support::Available(_), false) = (support, network) {
        if let Err(reason) = linux::network_filter() {
            return Support::Unavailable(reason);
        }
    }

    support.clone()
}

#[cfg(not(target_os = "linux"))]
fn enforceable(support: &Support, _network: bool) -> Support {
    support.clone()
}

pub fn policy_for_call(
    support: &Support,
    allow_unsandboxed: bool,
    allow_network: bool,
    roots: &[PathBuf],
    home: Option<&Path>,
) -> Result<Option<Policy>, String> {
    match enforceable(support, allow_network) {
        Support::Available(_) => Ok(Some(Policy {
            network: allow_network,
            ..Policy::for_roots(roots, home)
        })),
        Support::Unavailable(_) if allow_unsandboxed => Ok(None),
        Support::Unavailable(reason) => Err(format!(
            "shell commands must run sandboxed, and {reason}. To run them without a sandbox, \
             turn off \"Require sandbox for shell commands\" in this computer's device settings."
        )),
    }
}

/// What a sandboxed command can and cannot do, as the prompt says it. Each
/// platform states only what its mechanism enforces (see the module docs).
#[cfg(target_os = "macos")]
const SANDBOX_LIMITS: &str = "it can change files only in the shared folders, cannot see the rest of \
     your home folder, cannot run open, osascript or launchctl from their standard locations, and cannot send Apple \
     events. Other \
     programs can still run, it can READ files outside the shared folders, and local services \
     (Mach IPC) are not restricted.";

#[cfg(target_os = "linux")]
const SANDBOX_LIMITS: &str =
    "it can change files only in the shared folders and reads only system \
     and toolchain folders besides them. Local IPC (D-Bus, SSH and GPG agents, other sockets) is \
     NOT isolated.";

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const SANDBOX_LIMITS: &str =
    "it can change files only in the shared folders and reads only system \
     and toolchain folders besides them. Local IPC (D-Bus, SSH and GPG agents, other sockets) and \
     network access are NOT isolated.";

/// The network clause of the sandbox line. Empty where the mechanism does not
/// enforce it: [`SANDBOX_LIMITS`] already says so.
#[cfg(target_os = "macos")]
fn network_sentence(policy: &Policy) -> &'static str {
    if policy.network {
        " Network access is allowed by this computer's device settings."
    } else {
        " Network access is blocked. Turn on \"Allow network for shell commands\" in this computer's device settings to allow it."
    }
}

#[cfg(target_os = "linux")]
fn network_sentence(policy: &Policy) -> &'static str {
    if policy.network {
        " Network access is allowed by this computer's device settings."
    } else {
        " New IPv4 and IPv6 connections are blocked (Unix sockets are not). Turn on \"Allow network for shell commands\" in this computer's device settings to allow them."
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn network_sentence(_policy: &Policy) -> &'static str {
    ""
}

/// The line the approval prompt shows about the sandbox.
pub fn describe(support: &Support, policy: Option<&Policy>) -> String {
    match (support, policy) {
        (Support::Available(mechanism), Some(policy)) => {
            format!(
                "Sandboxed ({mechanism}): {SANDBOX_LIMITS}{}",
                network_sentence(policy)
            )
        }
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
            network: false,
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
    fn no_policy_grants_writes_to_terminals() {
        let rules = landlock_rules(&policy());
        let terminal = |path: &Path| {
            let text = path.to_string_lossy();
            text.starts_with("/dev/tty") || text.starts_with("/dev/pts")
        };

        assert!(!rules
            .iter()
            .any(|rule| rule.writable && terminal(&rule.path)));

        let (profile, _) = seatbelt_profile(&policy());
        assert!(!profile.contains("/dev/tty"));
        assert!(!profile.contains("/dev/pts"));
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

        assert!(policy_for_call(&missing, false, false, &roots, None)
            .unwrap_err()
            .contains("no Landlock"));
        assert_eq!(
            policy_for_call(&missing, true, false, &roots, None),
            Ok(None)
        );
        assert_eq!(
            policy_for_call(&Support::Available("x".into()), false, false, &roots, None)
                .unwrap()
                .unwrap()
                .writable,
            roots
        );
    }

    #[test]
    fn network_is_blocked_unless_the_user_allows_it() {
        let roots = vec![PathBuf::from("/srv/p")];
        let available = Support::Available("x".into());
        let blocked = policy_for_call(&available, false, false, &roots, None)
            .unwrap()
            .unwrap();
        let allowed = policy_for_call(&available, false, true, &roots, None)
            .unwrap()
            .unwrap();

        assert!(!blocked.network);
        assert!(allowed.network);
    }

    #[test]
    fn the_seatbelt_profile_denies_the_network_unless_allowed() {
        let (blocked, _) = seatbelt_profile(&policy());
        let (allowed, _) = seatbelt_profile(&Policy {
            network: true,
            ..policy()
        });

        assert!(blocked.contains("(deny network*)"));
        assert!(!allowed.contains("network"));
        assert_eq!(blocked.matches('(').count(), blocked.matches(')').count());
    }

    #[test]
    fn describes_the_sandbox_for_the_prompt() {
        let available = Support::Available("Landlock ABI 5".into());
        let missing = Support::Unavailable("no Landlock".into());

        assert!(describe(&available, Some(&policy())).starts_with("Sandboxed (Landlock ABI 5)"));
        #[cfg(not(target_os = "macos"))]
        assert!(describe(&available, Some(&policy())).contains("NOT isolated"));
        #[cfg(target_os = "macos")]
        assert!(describe(&available, Some(&policy()))
            .contains("cannot run open, osascript or launchctl from their standard locations"));
        #[cfg(target_os = "macos")]
        assert!(describe(&available, Some(&policy())).contains("Network access is blocked"));
        #[cfg(target_os = "linux")]
        assert!(describe(&available, Some(&policy()))
            .contains("New IPv4 and IPv6 connections are blocked (Unix sockets are not)"));
        #[cfg(target_os = "linux")]
        assert!(!describe(&available, Some(&policy())).contains("network access are NOT"));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(describe(
            &available,
            Some(&Policy {
                network: true,
                ..policy()
            })
        )
        .contains("Network access is allowed"));
        assert!(describe(&missing, None).starts_with("NOT sandboxed (no Landlock)"));
    }

    /// What a forked child sees from `socket(2)` after `filter` (if any) is
    /// installed: bit 0 AF_INET failed with EPERM, bit 1 AF_INET6 failed with
    /// EPERM, bit 2 AF_UNIX succeeded, bit 3 AF_INET succeeded, bit 4 AF_PACKET
    /// failed with EPERM. The child
    /// allocates nothing and only `_exit`s, so forking the test process is safe.
    #[cfg(target_os = "linux")]
    fn probe_sockets(filter: Option<&[libc::sock_filter]>) -> i32 {
        // SAFETY: the child makes only raw syscalls and exits without unwinding.
        unsafe {
            let pid = libc::fork();

            assert!(pid >= 0, "fork failed");

            if pid == 0 {
                if let Some(filter) = filter {
                    if install_filter(filter).is_err() {
                        libc::_exit(100);
                    }
                }

                let denied = |domain: libc::c_int| {
                    let fd = libc::socket(domain, libc::SOCK_STREAM, 0);

                    if fd >= 0 {
                        libc::close(fd);
                        return false;
                    }

                    *libc::__errno_location() == libc::EPERM
                };
                let opens = |domain: libc::c_int| {
                    let fd = libc::socket(domain, libc::SOCK_STREAM, 0);

                    if fd >= 0 {
                        libc::close(fd);
                    }

                    fd >= 0
                };
                let bits = i32::from(denied(libc::AF_INET))
                    | i32::from(denied(libc::AF_INET6)) << 1
                    | i32::from(opens(libc::AF_UNIX)) << 2
                    | i32::from(opens(libc::AF_INET)) << 3
                    | i32::from(denied(libc::AF_PACKET)) << 4;

                libc::_exit(bits);
            }

            let mut status = 0;

            assert_eq!(libc::waitpid(pid, &mut status, 0), pid);
            assert!(libc::WIFEXITED(status), "child ended abnormally: {status}");

            libc::WEXITSTATUS(status)
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_network_filter_refuses_ip_sockets_and_keeps_unix_sockets() {
        let filter = network_filter().unwrap();

        assert_eq!(probe_sockets(Some(&filter)), 0b1_0111);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn without_the_filter_ip_sockets_open() {
        let bits = probe_sockets(None);

        assert_eq!(bits & 0b1011, 0b1000, "control run: {bits:#06b}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_network_filter_ends_in_its_three_verdicts_and_jumps_stay_inside() {
        let filter = network_filter().unwrap();
        let len = filter.len();

        assert_eq!(filter[len - 3].k, libc::SECCOMP_RET_ALLOW);
        assert_eq!(
            filter[len - 2].k,
            libc::SECCOMP_RET_ERRNO | libc::EPERM as u32
        );
        assert_eq!(filter[len - 1].k, libc::SECCOMP_RET_KILL_PROCESS);

        for (index, instruction) in filter[..len - 3].iter().enumerate() {
            assert!(index + 1 + usize::from(instruction.jt) < len);
            assert!(index + 1 + usize::from(instruction.jf) < len);
        }
    }
}
