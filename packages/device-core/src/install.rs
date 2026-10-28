//! Putting `neore-host` on a server and keeping it current.
//!
//! The binaries and their checksums ship inside the desktop build ([`Bundle`]); the server never fetches
//! anything. A run asks the server for `uname -sm` first and refuses a machine the bundle has no binary for before
//! any byte moves. The upload goes to a temporary name in the version's folder, its SHA-256 is checked ON the
//! server against the shipped value, and only then is it made executable and renamed into place, so a wrong
//! checksum or a dropped connection leaves nothing executable at the final path.
//!
//! The server's side is a short POSIX script run as `sh -c` (the login shell may be anything). It holds no single
//! quote and interpolates only text this module validated: a version, a hex digest and a hex nonce.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::ssh::{exec, Interact, SshPaths, Target, HOST_VERSION};

/// The platforms `neore-host` is built for, as Rust target triples. Linux is musl, so the binary is static.
pub const TARGETS: [&str; 4] = [
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-musl",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-musl",
];

/// The checksum manifest beside the binaries in the bundle's folder.
pub const MANIFEST_FILE: &str = "manifest.json";

/// The bundle is read whole before it is hashed; a host binary is a few MB.
const MAX_BINARY_BYTES: u64 = 64 * 1024 * 1024;

/// The Rust target for a server's `uname -sm`, or why there is none.
pub fn target_for_uname(output: &str) -> Result<&'static str, String> {
    let mut words = output.split_whitespace();
    let (Some(system), Some(machine), None) = (words.next(), words.next(), words.next()) else {
        return Err(format!(
            "the server answered `uname -sm` with something unexpected: {}",
            output.trim().chars().take(80).collect::<String>()
        ));
    };

    match (system, machine) {
        ("Linux", "x86_64" | "amd64") => Ok("x86_64-unknown-linux-musl"),
        ("Linux", "aarch64" | "arm64") => Ok("aarch64-unknown-linux-musl"),
        ("Darwin", "arm64" | "aarch64") => Ok("aarch64-apple-darwin"),
        ("Darwin", "x86_64") => Ok("x86_64-apple-darwin"),
        _ => Err(format!(
            "neore-host is not built for {system} {machine} (Linux and macOS, x86_64 and arm64)"
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    file: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    targets: BTreeMap<String, Entry>,
    version: String,
}

/// The host binaries shipped with this build and the checksums they must have.
#[derive(Debug)]
pub struct Bundle {
    dir: PathBuf,
    manifest: Manifest,
}

impl Bundle {
    /// Reads `dir/manifest.json`. A bundle of another version, a digest that is not 64 hex characters, a file name
    /// that is not a plain name or a target this module does not know is refused, so a damaged bundle fails here
    /// and not halfway through an upload.
    pub fn load(dir: &Path) -> Result<Bundle, String> {
        let text = fs::read_to_string(dir.join(MANIFEST_FILE))
            .map_err(|error| format!("this build has no host software to install: {error}"))?;
        let manifest: Manifest = serde_json::from_str(&text)
            .map_err(|error| format!("the host software manifest is damaged: {error}"))?;

        if manifest.version != HOST_VERSION {
            return Err(format!(
                "the host software in this build is version {}, the app expects {HOST_VERSION}",
                manifest.version
            ));
        }

        for (triple, entry) in &manifest.targets {
            let plain_name = !entry.file.is_empty()
                && !entry.file.starts_with('.')
                && entry
                    .file
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));

            if !TARGETS.contains(&triple.as_str()) || !plain_name || !is_sha256(&entry.sha256) {
                return Err(format!("the host software manifest is damaged: {triple}"));
            }
        }

        Ok(Bundle {
            dir: dir.to_owned(),
            manifest,
        })
    }

    /// The shipped checksum for `triple`, when the bundle has a binary for it.
    pub fn checksum(&self, triple: &str) -> Option<&str> {
        self.manifest
            .targets
            .get(triple)
            .map(|entry| entry.sha256.as_str())
    }

    /// The binary for `triple`, read and compared with the shipped checksum: a bundle that was changed after the
    /// build is caught before it leaves this computer.
    fn read(&self, triple: &str) -> Result<Vec<u8>, String> {
        let entry = self
            .manifest
            .targets
            .get(triple)
            .ok_or_else(|| format!("this build of Neore ships no neore-host for {triple}"))?;
        let path = self.dir.join(&entry.file);
        let mut bytes = Vec::new();

        fs::File::open(&path)
            .and_then(|file| file.take(MAX_BINARY_BYTES + 1).read_to_end(&mut bytes))
            .map_err(|error| format!("{}: {error}", path.display()))?;

        if bytes.len() as u64 > MAX_BINARY_BYTES || hex(&Sha256::digest(&bytes)) != entry.sha256 {
            return Err(format!(
                "{} does not match the checksum shipped with this build",
                entry.file
            ));
        }

        Ok(bytes)
    }
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Where the versions live on a server. Shell text this module builds, never taken from a page.
#[derive(Clone, Debug)]
pub enum Root {
    /// `~/.neore/host`.
    Home,
    /// An absolute folder, for tests that must not touch the real home.
    Dir(String),
}

impl Root {
    pub fn dir(path: &str) -> Result<Root, String> {
        let plain = path.starts_with('/')
            && path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'-' | b'_'));

        if plain {
            Ok(Root::Dir(path.to_owned()))
        } else {
            Err("the install folder must be a plain absolute path".into())
        }
    }

    /// The folder as it is written inside double quotes.
    fn text(&self) -> &str {
        match self {
            Root::Home => "$HOME/.neore/host",
            Root::Dir(path) => path,
        }
    }

    /// The remote path of the host binary of `version`, quoted for the server's shell.
    pub fn binary(&self, version: &str) -> String {
        format!("\"{}/{version}/neore-host\"", self.text())
    }
}

/// A version is a folder name: digits, letters and `.+-_` only.
fn valid_version(version: &str) -> bool {
    version.starts_with(|c: char| c.is_ascii_digit())
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-' | b'_'))
}

/// `sum` holds the SHA-256 of `$1`, whichever tool the server has.
const SUM_OF_FILE: &str = r#"sum_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d " " -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d " " -f 1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed "s/.*= //"
  else echo "no tool to compute a SHA-256" >&2; return 1
  fi
}
"#;

/// What a server's answer to a query starts with. A login shell's rc files can print before the script runs, so
/// an answer is the line behind this marker and nothing else on stdout.
const ANSWER: &str = "NEORE:";

/// The `PATH` of the clean environment: the usual places plus where NixOS and Guix keep their tools.
const PATH: &str = "/usr/bin:/bin:/usr/sbin:/run/current-system/sw/bin";

/// The command line that runs `script` on the server: a clean environment and `sh`, whatever the login shell is.
fn shell(script: &str) -> String {
    debug_assert!(!script.contains('\''));

    format!("exec env -i HOME=\"$HOME\" PATH={PATH} /bin/sh -c '{script}'")
}

/// The answer in a script's stdout, ignoring whatever else was printed around it.
fn answer_in(stdout: &str) -> Option<&str> {
    stdout
        .lines()
        .find_map(|line| line.trim_end().strip_prefix(ANSWER))
}

fn status_script(root: &Root, version: &str, sha256: &str) -> String {
    format!(
        r#"{SUM_OF_FILE}f="{root}/{version}/neore-host"
if [ -f "$f" ] && [ -x "$f" ]; then
  if [ "$(sum_of "$f")" = "{sha256}" ]; then echo {ANSWER}current; else echo {ANSWER}different; fi
else
  echo {ANSWER}missing
fi
"#,
        root = root.text()
    )
}

fn upload_script(root: &Root, version: &str, sha256: &str, nonce: &str) -> String {
    format!(
        r#"set -eu
umask 077
{SUM_OF_FILE}d="{root}/{version}"
t="$d/neore-host.tmp-{nonce}"
mkdir -p "$d"
cleanup() {{ rm -f -- "$t"; }}
trap cleanup EXIT
trap "exit 1" HUP INT TERM
find "$d" -maxdepth 1 -name "neore-host.tmp-*" -mmin +60 -exec rm -f {{}} + 2>/dev/null || true
cat > "$t"
actual=$(sum_of "$t")
if [ "$actual" != "{sha256}" ]; then echo "checksum mismatch: got $actual" >&2; exit 3; fi
chmod 700 "$t"
mv -f "$t" "$d/neore-host"
"#,
        root = root.text()
    )
}

/// Removes the version folders other than `version`, and nothing else: `run/` and `logs/` do not start with a digit.
fn prune_script(root: &Root, version: &str) -> String {
    format!(
        r#"set -eu
for x in "{root}"/[0-9]*; do
  [ -d "$x" ] || continue
  [ "${{x##*/}}" = "{version}" ] || rm -rf -- "$x"
done
"#,
        root = root.text()
    )
}

fn nonce() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let mut digest = Sha256::new();

    digest.update(now.to_le_bytes());
    digest.update(std::process::id().to_le_bytes());
    digest.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());

    hex(&digest.finalize()[..8])
}

/// Where a run goes and who answers its questions.
pub struct Remote<'a> {
    pub interact: &'a Arc<dyn Interact>,
    pub paths: &'a SshPaths,
    pub target: &'a Target,
}

impl Remote<'_> {
    fn run(&self, script: &str, input: &mut dyn Read) -> Result<String, String> {
        exec(
            self.target,
            self.paths,
            self.interact,
            &shell(script),
            input,
        )
        .map(|done| done.stdout)
        .map_err(String::from)
    }

    /// The Rust target of the server, from its own `uname`.
    pub fn triple(&self) -> Result<&'static str, String> {
        let stdout = self.run(
            &format!("echo \"{ANSWER}$(uname -sm)\""),
            &mut std::io::empty(),
        )?;

        target_for_uname(answer_in(&stdout).unwrap_or_default())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Installed {
    /// The server already had this exact binary.
    Current,
    Uploaded,
}

/// Installs `version`'s binary for the server's platform unless it is already there with the shipped checksum.
pub fn install(remote: &Remote, bundle: &Bundle, root: &Root) -> Result<Installed, String> {
    if !valid_version(HOST_VERSION) {
        return Err("the host version is not a folder name".into());
    }

    // Everything that can refuse does so before the upload: the platform, the bundle's file and its checksum.
    let triple = remote.triple()?;
    let sha256 = bundle
        .checksum(triple)
        .ok_or_else(|| format!("this build of Neore ships no neore-host for {triple}"))?
        .to_owned();
    let bytes = bundle.read(triple)?;
    let state = remote.run(
        &status_script(root, HOST_VERSION, &sha256),
        &mut std::io::empty(),
    )?;

    if answer_in(&state) == Some("current") {
        return Ok(Installed::Current);
    }

    upload(remote, root, &mut bytes.as_slice(), &sha256)?;

    Ok(Installed::Uploaded)
}

/// Sends `input` to the server, checks its SHA-256 there against `sha256` and only then makes it the host binary.
pub fn upload(
    remote: &Remote,
    root: &Root,
    input: &mut dyn Read,
    sha256: &str,
) -> Result<(), String> {
    if !is_sha256(sha256) {
        return Err("the checksum is not a SHA-256".into());
    }

    remote
        .run(&upload_script(root, HOST_VERSION, sha256, &nonce()), input)
        .map(drop)
}

/// Deletes the folders of other versions. Only after the new binary answered its handshake.
pub fn prune(remote: &Remote, root: &Root) -> Result<(), String> {
    remote
        .run(&prune_script(root, HOST_VERSION), &mut std::io::empty())
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn temporary(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neore-bundle-{name}-{}", std::process::id()));

        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        dir
    }

    fn manifest(version: &str, file: &str, sha256: &str, triple: &str) -> String {
        format!(
            r#"{{"version":"{version}","targets":{{"{triple}":{{"file":"{file}","sha256":"{sha256}"}}}}}}"#
        )
    }

    #[test]
    fn uname_maps_to_the_target_and_an_unknown_machine_is_refused() {
        assert_eq!(
            target_for_uname("Linux x86_64\n").unwrap(),
            "x86_64-unknown-linux-musl"
        );
        assert_eq!(
            target_for_uname("Linux aarch64").unwrap(),
            "aarch64-unknown-linux-musl"
        );
        assert_eq!(
            target_for_uname("Darwin arm64").unwrap(),
            "aarch64-apple-darwin"
        );
        assert_eq!(
            target_for_uname("Darwin x86_64").unwrap(),
            "x86_64-apple-darwin"
        );

        for refused in [
            "Linux armv7l",
            "Linux riscv64",
            "FreeBSD amd64",
            "Linux",
            "Linux x86_64 extra",
            "",
        ] {
            assert!(target_for_uname(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn an_answer_is_the_marked_line_whatever_the_login_shell_printed() {
        assert_eq!(
            answer_in("Welcome to box\nNEORE:Linux x86_64\n"),
            Some("Linux x86_64")
        );
        assert_eq!(answer_in("NEORE:current\r\n"), Some("current"));
        assert_eq!(
            answer_in("last login: today\nNEORE:missing\nbye\n"),
            Some("missing")
        );
        assert_eq!(answer_in("Linux x86_64\n"), None);
        assert_eq!(answer_in(""), None);
        assert_eq!(
            target_for_uname(answer_in("motd\nNEORE:Darwin arm64\n").unwrap()).unwrap(),
            "aarch64-apple-darwin"
        );
        assert!(target_for_uname(answer_in("motd\n").unwrap_or_default()).is_err());
    }

    #[test]
    fn a_manifest_of_another_version_or_with_a_bad_entry_is_refused() {
        let dir = temporary("manifest");
        let load = |text: String| {
            fs::write(dir.join(MANIFEST_FILE), text).unwrap();
            Bundle::load(&dir)
        };
        let good = |file: &str, sha: &str, triple: &str| manifest(HOST_VERSION, file, sha, triple);

        assert!(load(good("neore-host-a", SHA, "x86_64-apple-darwin")).is_ok());
        assert!(load(manifest(
            "9.9.9",
            "neore-host-a",
            SHA,
            "x86_64-apple-darwin"
        ))
        .is_err());
        assert!(load(good("neore-host-a", "ABC", "x86_64-apple-darwin")).is_err());
        assert!(load(good("../neore-host", SHA, "x86_64-apple-darwin")).is_err());
        assert!(load(good("/etc/passwd", SHA, "x86_64-apple-darwin")).is_err());
        assert!(load(good("neore-host-a", SHA, "sparc-sun-solaris")).is_err());
        assert!(load("not json".into()).is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_binary_changed_after_the_build_is_refused_before_it_leaves() {
        let dir = temporary("tamper");
        let bytes = b"the real host".to_vec();
        let sha = hex(&Sha256::digest(&bytes));

        fs::write(dir.join("neore-host-a"), &bytes).unwrap();
        fs::write(
            dir.join(MANIFEST_FILE),
            manifest(HOST_VERSION, "neore-host-a", &sha, "x86_64-apple-darwin"),
        )
        .unwrap();

        let bundle = Bundle::load(&dir).unwrap();

        assert_eq!(bundle.read("x86_64-apple-darwin").unwrap(), bytes);
        assert!(bundle.read("aarch64-apple-darwin").is_err());

        fs::write(dir.join("neore-host-a"), b"a replaced host").unwrap();

        let error = bundle.read("x86_64-apple-darwin").unwrap_err();

        assert!(error.contains("does not match the checksum"), "{error}");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_server_scripts_are_safe_to_wrap_in_single_quotes() {
        let root = Root::Home;
        let scripts = [
            status_script(&root, HOST_VERSION, SHA),
            upload_script(&root, HOST_VERSION, SHA, "00112233aabbccdd"),
            prune_script(&root, HOST_VERSION),
        ];

        for script in scripts {
            assert!(!script.contains('\''), "{script}");
            assert!(shell(&script).starts_with("exec env -i HOME=\"$HOME\" PATH=/usr/bin:/bin:"));
        }
    }

    #[test]
    fn the_upload_checks_the_checksum_before_it_makes_anything_executable() {
        let script = upload_script(&Root::Home, HOST_VERSION, SHA, "00112233aabbccdd");
        let check = script.find("checksum mismatch").unwrap();
        let chmod = script.find("chmod 700").unwrap();
        let rename = script.find("mv -f").unwrap();

        assert!(script.contains("umask 077"));
        assert!(check < chmod && chmod < rename);
    }

    #[test]
    fn a_root_is_a_plain_absolute_path_and_the_binary_is_quoted() {
        assert!(Root::dir("/tmp/host-1_a.b").is_ok());

        for refused in ["relative", "/a b", "/a'b", "/a\"b", "/a$b", "/a;b", ""] {
            assert!(Root::dir(refused).is_err(), "{refused}");
        }

        assert_eq!(
            Root::Home.binary("1.2.3"),
            "\"$HOME/.neore/host/1.2.3/neore-host\""
        );
        assert!(valid_version(HOST_VERSION));
        assert!(!valid_version("../1"));
        assert!(!valid_version("1;rm"));
    }
}
