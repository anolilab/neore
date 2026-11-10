//! Installing a registry agent that is distributed as an npm package, pinned, with trust on first use.
//!
//! The desktop main process takes the package index's integrity hash for the exact version (npm's
//! `dist.integrity`) BEFORE the person confirms, shows it, and downloads the tarball only after a "yes". The
//! registry's own data carries no hash for these agents, so the trust is the package index's at install time,
//! not the publisher's. Everything after the download is decided here, through the addon only:
//!
//! 1. the tarball's SHA-512 must equal that integrity, or nothing is installed;
//! 2. npm installs the verified tarball into a private prefix with `--ignore-scripts`: no lifecycle script of the
//!    package or of its dependencies runs. npm and node are the absolute paths the main process found, started
//!    with a scrubbed environment, so no `PATH` lookup, user `.npmrc` or `NODE_OPTIONS` reaches them;
//! 3. the installed package must be the name and version that was pinned, and its program is resolved INSIDE it;
//! 4. every file, folder and link of the prefix is hashed ([`tree_hash`]) and the hash recorded in the pin next
//!    to the index's integrity, the folder is renamed to `acp-agents/<key>/<version>` and the agent is recorded
//!    to run `node <program>`: the command is never `npx`, and nothing is resolved at launch.
//!
//! Only the package's own dependencies are checked before npm runs (`refuse_unverified_dependencies`): what the
//! registry's packages depend on in turn is still left to npm, so one hop through a registry package can reach a
//! spec that is not from the index. The folder hash below is what holds those afterwards.
//!
//! Before every start [`DeviceState::verify_installed_tree`] hashes the folder again and refuses to launch when
//! it no longer matches. The hash covers the dependencies npm fetched, which the index's integrity does not: they
//! are trusted as they were at install, and a change afterwards is caught. There is no update path: a newer
//! version is a new install the person confirms.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};

use crate::acp::{validate_agent, AcpAgent, AcpInstall, AcpView, EnvVars};
use crate::acp_install::{
    create_private_dir, run_id, safe_relative, sha256_reader, validate_provenance, INSTALLING_DIR,
    UNPACKED_DIR,
};
use crate::engine::{now_ms, DeviceState, Event};
use crate::hmac::to_hex;

const MAX_TREE_ENTRIES: usize = 200_000;
const TARBALL: &str = "package.tgz";
const HOME_DIR: &str = "home";
/// How often the staging folder is measured while npm runs, in 100 ms polls.
const STAGE_CHECK_EVERY: u32 = 5;
/// Variables the install passes on: a proxy and certificate settings decide whether the network is reachable behind
/// a corporate proxy. None of them names a program to run. Everything else is left out.
const PASSED_ENV: [&str; 7] = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
];

const OVER_BUDGET: &str =
    "the package needs more disk space than an agent may use. Nothing was installed";

/// What one install may take: the download, the staging folder while npm fills it (the package, its dependencies
/// and npm's cache) and the time npm may run. Tests pass smaller ones.
struct Limits {
    tarball_bytes: u64,
    stage_bytes: u64,
    npm_timeout: Duration,
}

const LIMITS: Limits = Limits {
    tarball_bytes: 256 * 1024 * 1024,
    stage_bytes: 2 * 1024 * 1024 * 1024,
    npm_timeout: Duration::from_secs(10 * 60),
};

/// A path's bytes as the file system holds them (Unix); elsewhere its text.
fn raw_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;

        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().replace('\\', "/").into_bytes()
    }
}

fn put(hasher: &mut Sha256, tag: u8, parts: &[&[u8]]) {
    hasher.update([tag]);

    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
}

/// A link may point only at something inside `root`: its target is resolved by name first (an absolute target or
/// one that climbs out of `root` is refused), then through the file system when it exists, which catches a path
/// through another link.
fn link_stays_inside(root: &Path, link: &Path, target: &Path) -> bool {
    use std::path::Component;

    let Some(parent) = link.parent().and_then(|dir| dir.strip_prefix(root).ok()) else {
        return false;
    };
    let mut depth = parent.components().count() as i64;

    if target.is_absolute() {
        return false;
    }

    for component in target.components() {
        match component {
            Component::ParentDir => {
                depth -= 1;

                if depth < 0 {
                    return false;
                }
            }
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            _ => return false,
        }
    }

    match (fs::canonicalize(link), fs::canonicalize(root)) {
        (Ok(resolved), Ok(root)) => resolved.starts_with(root),
        // A link that resolves to nothing could be made to point outside later, and what it then reached would run
        // without changing the hash. npm does not leave one in an install.
        (Err(_), _) | (_, Err(_)) => false,
    }
}

fn walk(
    root: &Path,
    dir: &Path,
    hasher: &mut Sha256,
    entries: &mut usize,
    limit: usize,
) -> Result<(), String> {
    let mut names = Vec::new();

    // Counted while the folder is read: a folder with millions of names is refused before they are all held.
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        *entries += 1;

        if *entries > limit {
            return Err("the installed folder holds too many entries".into());
        }

        names.push(entry.map_err(|error| error.to_string())?.file_name());
    }

    names.sort();

    for name in names {
        let path = dir.join(&name);
        let meta = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        let relative_path = path.strip_prefix(root).map_err(|error| error.to_string())?;
        // The hash takes the names as the file system holds them: two names that differ only in bytes no
        // text form keeps must not hash alike. `relative` is for messages.
        let raw = raw_bytes(relative_path);
        let relative = relative_path.to_string_lossy().into_owned();
        let kind = meta.file_type();

        if kind.is_symlink() {
            let target = fs::read_link(&path).map_err(|error| error.to_string())?;

            if !link_stays_inside(root, &path, &target) {
                return Err(format!(
                    "{relative} is a link to somewhere outside the package"
                ));
            }

            put(hasher, b'L', &[&raw, &raw_bytes(&target)]);
        } else if kind.is_dir() {
            put(hasher, b'D', &[&raw]);
            walk(root, &path, hasher, entries, limit)?;
        } else if kind.is_file() {
            #[cfg(unix)]
            let executable = {
                use std::os::unix::fs::PermissionsExt;

                meta.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let executable = false;
            let mut file = fs::File::open(&path).map_err(|error| error.to_string())?;
            let content = sha256_reader(&mut file)?;

            put(
                hasher,
                b'F',
                &[
                    &raw,
                    &[u8::from(executable)],
                    &meta.len().to_le_bytes(),
                    content.as_bytes(),
                ],
            );
        } else {
            return Err(format!("{relative} is not a plain file, folder or link"));
        }
    }

    Ok(())
}

/// SHA-256 over every entry under `root`, in name order: its path, and for a file its content and executable bit,
/// for a link its target. Times and owners are left out; a file added, removed, changed or swapped for a link is not.
pub(crate) fn tree_hash(root: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();

    walk(root, root, &mut hasher, &mut 0, MAX_TREE_ENTRIES)?;

    Ok(to_hex(&hasher.finalize()))
}

/// What the main process read from the registry entry and the package index. The tarball is a file it downloaded
/// into [`DeviceState::acp_install_stage`]'s folder; this module trusts none of the rest until it has checked it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NpmInstallRequest {
    pub archive: String,
    /// Arguments after the program, from the registry entry.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The index's `dist.integrity` for this version: `sha512-<base64>`.
    pub integrity: String,
    pub key: String,
    pub label: String,
    /// Absolute path of `node`, as found (its name is `node`; it may be a link).
    pub node: String,
    /// [`tool_identity`] of `node` when the person confirmed. The install is refused if the file there now has
    /// another identity, so the interpreter that is shown, the one npm runs under and the one recorded are the same
    /// file. For a version-manager shim (mise, Volta) this covers the shim only, not the tool it starts.
    pub node_identity: String,
    /// The same for `npm`.
    pub npm_identity: String,
    /// Absolute path of `npm`.
    pub npm: String,
    /// The package name, `name` or `@scope/name`.
    pub package: String,
    pub publisher: String,
    /// The tarball's URL, as the index gave it.
    pub source: String,
    pub version: String,
}

/// What a tool file is, for "is this still the file the person confirmed": on Unix the device, inode, size,
/// modification time and change time of what the path names (links followed), so a file replaced, re-pointed or
/// rewritten in place is another one, even when its modification time was set back (the change time cannot be).
/// Elsewhere only the resolved path is available, which a replaced file keeps. Opaque to callers: take it from here
/// when the person confirms the install (not just before it runs) and hand it back unchanged.
pub fn tool_identity(path: &Path) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let meta = fs::metadata(path).ok()?;

        Some(format!(
            "{}:{}:{}:{}.{}:{}.{}",
            meta.dev(),
            meta.ino(),
            meta.len(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec()
        ))
    }
    #[cfg(not(unix))]
    {
        fs::canonicalize(path)
            .ok()
            .map(|resolved| resolved.to_string_lossy().into_owned())
    }
}

fn valid_package_name(name: &str) -> bool {
    let plain = |part: &str| {
        !part.is_empty()
            && !part.starts_with(['.', '_'])
            && part.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'-' | b'.' | b'_' | b'~')
            })
    };

    name.len() <= 214
        && match name.strip_prefix('@') {
            Some(scoped) => scoped
                .split_once('/')
                .is_some_and(|(scope, rest)| plain(scope) && plain(rest)),
            None => plain(name),
        }
}

fn valid_integrity(text: &str) -> bool {
    text.strip_prefix("sha512-").is_some_and(|b64| {
        b64.len() == 88
            && b64.ends_with("==")
            && b64[..86]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
    })
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let n = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));

        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }

    out
}

fn program_path(text: &str, name: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(text);
    let named = path.file_name().is_some_and(|file| file == name);

    if !path.is_absolute() || !named || !fs::metadata(&path).is_ok_and(|meta| meta.is_file()) {
        return Err(format!(
            "{name} was not found at an absolute path. Install Node.js (which includes npm) and try again"
        ));
    }

    Ok(path)
}

fn validate(request: &NpmInstallRequest) -> Result<(PathBuf, PathBuf), String> {
    if cfg!(windows) {
        return Err("installing an npm agent is not supported on Windows yet".into());
    }

    if !valid_integrity(&request.integrity) {
        return Err("the package index gave no usable SHA-512 integrity for this version".into());
    }

    if !valid_package_name(&request.package) {
        return Err("the package name is not a plain npm package name".into());
    }

    validate_provenance(
        &request.version,
        &request.publisher,
        &request.source,
        &request.env,
    )?;

    let node = program_path(&request.node, "node")?;

    if tool_identity(&node).as_deref() != Some(request.node_identity.as_str()) {
        return Err("Node.js is not the file it was when you confirmed (it was replaced, rewritten or re-pointed). Nothing was installed; try again".into());
    }

    let npm = program_path(&request.npm, "npm")?;

    if tool_identity(&npm).as_deref() != Some(request.npm_identity.as_str()) {
        return Err("npm is not the file it was when you confirmed (it was replaced, rewritten or re-pointed). Nothing was installed; try again".into());
    }

    Ok((node, npm))
}

/// The tarball's `package.json`, read before npm runs, in a tarball that npm will extract the way it was read.
///
/// npm unpacks with the first path component stripped, and a later entry of the same path overwrites an earlier
/// one. So the file read here is the file npm installs only when it is the single top-level `package.json` (whatever
/// the top folder is called). More than one is refused, and so is a top-level `npm-shrinkwrap.json`: npm follows the
/// `resolved` addresses of a dependency's shrinkwrap, which can be git or https URLs with no integrity.
fn package_manifest(tarball: &Path) -> Result<Value, String> {
    const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

    let file = fs::File::open(tarball).map_err(|error| error.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut manifest = None;

    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        // Extraction strips a leading `/` and walks `..`, so such an entry can land on the file that was checked
        // under a name that does not look like it. No tarball of a package has one.
        if path.components().any(|part| {
            matches!(
                part,
                std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
                    | std::path::Component::ParentDir
            )
        }) {
            return Err("the download holds an entry with an absolute path or a `..`. Nothing was installed".into());
        }

        // `./package/package.json` and `package/package.json` are the same entry (as is `package/./package.json`,
        // which `components` already reads without the dot).
        let names: Vec<_> = path
            .components()
            .filter(|part| !matches!(part, std::path::Component::CurDir))
            .collect();
        let [_, name] = names.as_slice() else {
            continue;
        };

        // A case-insensitive file system (macOS) reads `PACKAGE.JSON` as `package.json`, and folds more than case
        // (`ſ` is `s`). Real packages keep ASCII names at their top level, so anything else is refused outright,
        // and the two names below are matched whatever their case.
        let Some(name) = name.as_os_str().to_str().filter(|text| text.is_ascii()) else {
            return Err("the download holds a top-level file whose name is not plain ASCII. Nothing was installed".into());
        };
        let name = name.to_ascii_lowercase();

        if name == "npm-shrinkwrap.json" {
            return Err("the package ships an npm-shrinkwrap.json, whose addresses cannot be checked. Nothing was installed".into());
        }

        if name != "package.json" {
            continue;
        }

        if manifest.is_some() {
            return Err("the download holds more than one package.json at its top level. Nothing was installed".into());
        }

        let mut bytes = Vec::new();

        if entry.header().entry_type().is_file() {
            (&mut entry)
                .take(MAX_MANIFEST_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
        }

        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("the package's package.json is too large".into());
        }

        manifest = Some(bytes);
    }

    let bytes = manifest
        .filter(|bytes| !bytes.is_empty())
        .ok_or("the download has no package.json")?;

    serde_json::from_slice(&bytes)
        .map_err(|_| "the package's package.json is not valid JSON".to_owned())
}

/// Whether `spec` asks the package index for a version: a semver range, a tag or an `npm:` alias. A URL, a git or
/// hosting-service address (`git+…`, `github:`, `user/repo`), a path (`file:`, `link:`) and the like are fetched
/// with no integrity, and a git checkout can run `prepare` scripts of its own.
fn is_registry_spec(spec: &str) -> bool {
    // An alias names `name@range` or `@scope/name@range`: the scope's slash is the only one allowed.
    let spec = match spec.strip_prefix("npm:") {
        Some(alias) => alias
            .strip_prefix('@')
            .map_or_else(|| alias.to_owned(), |scoped| scoped.replacen('/', "", 1)),
        None => spec.to_owned(),
    };

    // A semver range or a tag has neither character: they only appear in addresses and paths. npm also takes a
    // spec that starts with a dot, or names an archive, for a file on disk.
    !spec.contains(['/', ':'])
        && !spec.starts_with('.')
        && ![".tgz", ".tar", ".tar.gz"]
            .iter()
            .any(|suffix| spec.ends_with(suffix))
}

/// Refuses a package that depends on something npm would fetch without a registry integrity. Only this package's
/// own dependencies are known before npm runs; what the registry's packages depend on in turn is the index's.
fn refuse_unverified_dependencies(manifest: &Value) -> Result<(), String> {
    for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
        let Some(Value::Object(dependencies)) = manifest.get(field) else {
            continue;
        };

        for (name, spec) in dependencies {
            if !spec.as_str().is_some_and(is_registry_spec) {
                return Err(format!(
                    "the package depends on {name} from an address that is not the package index, which cannot be checked. Nothing was installed"
                ));
            }
        }
    }

    Ok(())
}

/// The program `npx <package>` would run: the single `bin`, or the one named like the package.
fn pick_bin(manifest: &Value, package: &str) -> Result<String, String> {
    let short = package.rsplit('/').next().unwrap_or(package);

    match manifest.get("bin") {
        Some(Value::String(path)) => Ok(path.clone()),
        Some(Value::Object(map)) => {
            if let Some(Value::String(path)) = map.get(short) {
                return Ok(path.clone());
            }

            // Several names for one file are one program (`npm exec` runs it); different files are a choice
            // this installer will not make for the person.
            let files: Vec<&str> = map
                .values()
                .filter_map(|value| value.as_str().map(|path| path.trim_start_matches("./")))
                .collect();

            match files.first() {
                Some(first)
                    if files.len() == map.len() && files.iter().all(|file| file == first) =>
                {
                    Ok(map
                        .values()
                        .next()
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned())
                }
                _ => Err("the package starts several programs and none is named like it".into()),
            }
        }
        _ => Err("the package declares no program to start".into()),
    }
}

fn tail(path: &Path) -> String {
    let text = fs::read(path).unwrap_or_default();
    let start = text.len().saturating_sub(400);

    String::from_utf8_lossy(&text[start..]).trim().to_owned()
}

/// Whether `node <script>` can run `script`: a JavaScript file by name, or one whose first line is a shebang for
/// node. Anything else (a shell script, a native executable) npm could run through its `.bin` link, but the
/// recorded command is `node <script>`.
fn runs_under_node(script: &Path) -> bool {
    if script
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension, "js" | "mjs" | "cjs"))
    {
        return true;
    }

    let mut head = [0_u8; 128];
    let read = fs::File::open(script)
        .and_then(|mut file| file.read(&mut head))
        .unwrap_or(0);
    let first = head[..read]
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or(&[]);

    is_node_shebang(&String::from_utf8_lossy(first))
}

/// Whether a first line is `#!` for node: the interpreter's file name is `node`, or it is `env` and the first
/// argument that is not an option (`-S` and its like) is `node`. A line that only mentions node somewhere, as
/// `#!/bin/sh # node` does, is not.
fn is_node_shebang(line: &str) -> bool {
    let Some(line) = line.trim().strip_prefix("#!") else {
        return false;
    };
    let mut words = line.split_whitespace();
    let Some(interpreter) = words.next() else {
        return false;
    };

    match Path::new(interpreter)
        .file_name()
        .and_then(|name| name.to_str())
    {
        Some("node") => true,
        Some("env") => words.find(|word| !word.starts_with('-')) == Some("node"),
        _ => false,
    }
}

/// Runs `npm install --ignore-scripts` of `tarball` into `prefix`, with an environment built from nothing.
///
/// npm is stopped, with everything it started, when it runs past `limits.npm_timeout` or when the staging folder
/// `stage` grows past `limits.stage_bytes`. This runs outside the install lock (`lock_installs` is taken only to
/// commit), so a hung npm holds nothing but its own reserved download.
fn run_npm(
    node: &Path,
    npm: &Path,
    prefix: &Path,
    tarball: &Path,
    home: &Path,
    stage: &Path,
    limits: &Limits,
) -> Result<(), String> {
    let log = home.join("npm.log");
    let out = fs::File::create(&log).map_err(|error| error.to_string())?;
    let err = out.try_clone().map_err(|error| error.to_string())?;
    let user_config = home.join("userrc");
    let global_config = home.join("globalrc");

    for config in [&user_config, &global_config] {
        fs::write(config, "").map_err(|error| error.to_string())?;
    }

    // npm is a script that starts `node` by name: its folder comes first, so that is the node that runs.
    let mut dirs: Vec<PathBuf> = [node, npm]
        .iter()
        .filter_map(|program| program.parent().map(Path::to_path_buf))
        .collect();

    dirs.extend(["/usr/bin", "/bin"].map(PathBuf::from));

    let path = std::env::join_paths(dirs).map_err(|error| error.to_string())?;
    // npm is usually a link to its `npm-cli.js`, and a launcher script can name its own interpreter by an absolute
    // path, which no `PATH` decides. So the confirmed node runs npm's real file, and that file has to be one node
    // can run.
    let entry = fs::canonicalize(npm).map_err(|error| error.to_string())?;

    if !runs_under_node(&entry) {
        return Err("npm is not a JavaScript file that Node can run (it may be a native program or a shell script), so Neore cannot run it with the Node.js you confirmed. Nothing was installed".into());
    }

    let mut command = Command::new(node);

    command
        .arg(&entry)
        .args([
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            "--no-update-notifier",
            "--loglevel=error",
            "--registry=https://registry.npmjs.org/",
            "--prefix",
        ])
        .arg(prefix)
        .arg(tarball)
        .current_dir(home)
        .env_clear()
        .env("PATH", path)
        .env("HOME", home)
        .env("TMPDIR", home)
        .env("npm_config_cache", home.join("cache"))
        .env("npm_config_userconfig", &user_config)
        .env("npm_config_globalconfig", &global_config)
        .env("npm_config_ignore_scripts", "true")
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);

    // Its own process group, so what npm starts (a git checkout, a download helper) goes with it.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);

    for name in PASSED_ENV {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }

    let mut child = spawn_retrying_busy(&mut command)
        .map_err(|error| format!("npm could not be started: {error}"))?;
    let deadline = Instant::now() + limits.npm_timeout;
    let mut until_check = STAGE_CHECK_EVERY;

    loop {
        until_check -= 1;

        // A package and its dependencies can expand far beyond the tarball that was verified: stop npm while it
        // runs, not after it has filled the disk.
        if until_check == 0 {
            until_check = STAGE_CHECK_EVERY;

            if stage_over(stage, limits.stage_bytes) {
                stop_npm(&mut child);

                return Err(OVER_BUDGET.into());
            }
        }

        let waited = match child.try_wait() {
            Ok(waited) => waited,
            Err(error) => {
                // npm may still be running, with its helpers: stop and reap the group before giving up.
                stop_npm(&mut child);

                return Err(error.to_string());
            }
        };

        match waited {
            Some(status) if status.success() => {
                // npm can finish, or grow in its last moments, between two measurements.
                if stage_over(stage, limits.stage_bytes) {
                    return Err(OVER_BUDGET.into());
                }

                return Ok(());
            }
            Some(_) => {
                return Err(format!(
                    "npm could not install the package ({}). Nothing was installed",
                    tail(&log)
                ))
            }
            None if Instant::now() >= deadline => {
                stop_npm(&mut child);

                return Err(
                    "npm took too long to install the package. Nothing was installed".into(),
                );
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

/// Kills npm and everything it started: they share the process group `run_npm` made for it.
fn stop_npm(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // SAFETY: plain syscall with no memory arguments; the group is the one `run_npm` made for this child.
        unsafe {
            libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// True when `dir` holds more than `limit` bytes (links are not followed; a tree too large to count is over).
fn stage_over(dir: &Path, limit: u64) -> bool {
    fn add(limit: u64, dir: &Path, bytes: &mut u64, entries: &mut usize) -> bool {
        let Ok(read) = fs::read_dir(dir) else {
            return false;
        };

        for entry in read.flatten() {
            *entries += 1;

            if *entries > MAX_TREE_ENTRIES {
                return true;
            }

            let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                continue;
            };

            if meta.is_dir() {
                if add(limit, &entry.path(), bytes, entries) {
                    return true;
                }
            } else {
                *bytes += meta.len();
            }

            if *bytes > limit {
                return true;
            }
        }

        false
    }

    add(limit, dir, &mut 0, &mut 0)
}

/// Starts `command`, trying again a few times when the system says the program file is still open for writing
/// (`ETXTBSY`): a script written just before, with another thread's `fork` still holding a copy of its write handle.
/// The handle is closed as soon as that fork execs, so a short wait is enough.
fn spawn_retrying_busy(command: &mut Command) -> std::io::Result<std::process::Child> {
    #[cfg(unix)]
    {
        let mut attempts = 0;

        loop {
            match command.spawn() {
                Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) && attempts < 20 => {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                result => return result,
            }
        }
    }
    #[cfg(not(unix))]
    {
        command.spawn()
    }
}

fn too_large(size: u64, limits: &Limits) -> String {
    format!(
        "the download is {} MiB, more than an agent may be ({} MiB). Nothing was installed",
        size / (1024 * 1024),
        limits.tarball_bytes / (1024 * 1024)
    )
}

/// [`digests`] of at most `limits.tarball_bytes` of `reader`; a longer stream is refused.
fn bounded_digests(reader: impl Read, limits: &Limits) -> Result<(String, String), String> {
    let mut bounded = reader.take(limits.tarball_bytes + 1);
    let hashes = digests(&mut bounded)?;

    if bounded.limit() == 0 {
        return Err(too_large(limits.tarball_bytes + 1, limits));
    }

    Ok(hashes)
}

/// The tarball's SHA-512 as an SRI string, and its SHA-256 as hex, from one pass over one open handle.
fn digests(file: &mut impl Read) -> Result<(String, String), String> {
    let (mut sha512, mut sha256) = (Sha512::new(), Sha256::new());
    let mut buffer = vec![0_u8; 64 * 1024];

    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;

        if read == 0 {
            return Ok((
                format!("sha512-{}", base64(&sha512.finalize())),
                to_hex(&sha256.finalize()),
            ));
        }

        sha512.update(&buffer[..read]);
        sha256.update(&buffer[..read]);
    }
}

/// Takes the staging folder of `staged` for this call alone, by renaming it into `acp-agents/.installing` under a
/// name no other call has: two calls that resolved the same download cannot both install it or delete each other's
/// working folder. That folder is outside `.staging`, whose entries older than a day are swept as abandoned, so a long
/// install is not deleted under its own feet. Returns the archive's new path and the reserved folder.
fn reserve_stage(install_root: &Path, staged: &Path) -> Result<(PathBuf, PathBuf), String> {
    static RESERVED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    let not_staged = "the download is not in a staging folder";
    let stage_dir = staged.parent().ok_or(not_staged)?;
    let file = staged.file_name().ok_or(not_staged)?;
    let holding = install_root.join(INSTALLING_DIR);

    // A folder already reserved by a call is that call's alone: it is never taken or renamed again.
    if stage_dir.parent() == Some(holding.as_path()) {
        return Err("this download is already being installed".into());
    }

    // A real folder under app data: through a link the reserved folders would land somewhere else.
    if fs::symlink_metadata(&holding).is_ok_and(|meta| !meta.is_dir()) {
        return Err("the folder for downloads being installed is not a plain folder".into());
    }

    fs::create_dir_all(&holding).map_err(|error| error.to_string())?;

    // Named with this run's id, like the trash: the sweep of the folder at start-up deletes the entries of other
    // runs only, so it never takes an install that is going on now (in this state or in another over the same
    // folder: the id belongs to the process).
    let reserved = holding.join(format!(
        "{}-{}",
        run_id(),
        RESERVED.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));

    fs::rename(stage_dir, &reserved).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "this download is already being installed".to_owned()
        } else {
            format!("the download could not be set aside for the install: {error}")
        }
    })?;

    Ok((reserved.join(file), reserved))
}

impl DeviceState {
    /// Verifies, installs and registers `request`. Any refusal leaves no file behind.
    pub fn acp_install_npm(&self, request: NpmInstallRequest) -> Result<AcpView, String> {
        self.acp_install_npm_within(request, &LIMITS)
    }

    fn acp_install_npm_within(
        &self,
        request: NpmInstallRequest,
        limits: &Limits,
    ) -> Result<AcpView, String> {
        let (node, npm) = validate(&request)?;
        let staged = self.staged_archive(&request.archive)?;
        let (staged, stage_dir) = reserve_stage(&self.install_root(), &staged)?;
        let result = self.install_npm_staged(&request, &node, &npm, &staged, &stage_dir, limits);

        // npm's cache and anything half-installed go whatever happened; a successful install already moved its
        // folder out. Moved to the trash and deleted on a thread: a failed install can be a very large tree. Only
        // the folder this call reserved: another call's is not ours to delete.
        self.discard(&stage_dir);

        result
    }

    fn install_npm_staged(
        &self,
        request: &NpmInstallRequest,
        node: &Path,
        npm: &Path,
        archive: &Path,
        stage_dir: &Path,
        limits: &Limits,
    ) -> Result<AcpView, String> {
        // One open handle: its size is checked, and what is read through it is bounded as well, so a file that
        // grows after the check is still stopped.
        let file = fs::File::open(archive).map_err(|error| error.to_string())?;
        let size = file.metadata().map_err(|error| error.to_string())?.len();

        if size > limits.tarball_bytes {
            return Err(too_large(size, limits));
        }

        let (integrity, sha256) = bounded_digests(file, limits)?;

        if integrity != request.integrity {
            self.audit(json!({
                "at": now_ms(), "decision": "refused", "detail": format!("{} {}: integrity mismatch", request.label, request.version),
                "status": "refused", "tool": "acp_install",
            }));

            return Err(format!(
                "The download does not match the hash the package index gave when you confirmed (expected {}, got {integrity}). Nothing was installed.",
                request.integrity
            ));
        }

        let tarball = stage_dir.join(TARBALL);
        let prefix = stage_dir.join(UNPACKED_DIR);
        let home = stage_dir.join(HOME_DIR);

        fs::rename(archive, &tarball).map_err(|error| error.to_string())?;
        create_private_dir(&prefix)?;
        create_private_dir(&home)?;
        refuse_unverified_dependencies(&package_manifest(&tarball)?)?;
        run_npm(node, npm, &prefix, &tarball, &home, stage_dir, limits)?;

        // npm opened the tarball by name. The bytes on disk must match the index's hash after npm ran as well as
        // before: what npm read is then the tarball that was checked. Another process of the same user that can
        // write the 0700 staging folder could still race the two reads; that is outside what this guards.
        let (after, _) =
            digests(&mut fs::File::open(&tarball).map_err(|error| error.to_string())?)?;

        if after != request.integrity {
            return Err(
                "the download changed while it was being installed. Nothing was installed".into(),
            );
        }

        let package_dir = prefix.join("node_modules").join(&request.package);

        if !fs::symlink_metadata(&package_dir).is_ok_and(|meta| meta.is_dir()) {
            return Err("npm did not install the package it was asked for".into());
        }

        let manifest: Value = serde_json::from_slice(
            &fs::read(package_dir.join("package.json")).map_err(|error| error.to_string())?,
        )
        .map_err(|_| "the package's package.json is not valid JSON".to_owned())?;

        if manifest.get("name").and_then(Value::as_str) != Some(request.package.as_str())
            || manifest.get("version").and_then(Value::as_str) != Some(request.version.as_str())
        {
            return Err("the installed package is not the name and version that was pinned".into());
        }

        let relative = safe_relative(Path::new(&pick_bin(&manifest, &request.package)?))?;
        let script = package_dir.join(&relative);
        // Inside THIS package, not just the prefix: a link to a sibling under `node_modules` would otherwise run
        // another package's file and record where the link led.
        let inside = fs::canonicalize(&script)
            .ok()
            .zip(fs::canonicalize(&package_dir).ok())
            .is_some_and(|(script, package)| script.starts_with(package));

        if relative.as_os_str().is_empty()
            || !inside
            || !fs::symlink_metadata(&script).is_ok_and(|meta| meta.is_file())
        {
            return Err("the program the package starts is not a file inside it".into());
        }

        if !runs_under_node(&script) {
            return Err("the program the package starts is not a JavaScript file Node can run, so Neore would not be able to start it".into());
        }

        let tree = tree_hash(&prefix)?;
        let final_dir = self
            .install_root()
            .join(&request.key)
            .join(&request.version);
        let in_final = final_dir
            .join("node_modules")
            .join(&request.package)
            .join(&relative);
        let mut args = vec![in_final.to_string_lossy().into_owned()];

        args.extend(request.args.iter().cloned());

        let mut agent = AcpAgent {
            args,
            // The interpreter as found, by the name `node`: a multi-call shim (mise, Volta) decides what to run
            // from the name it is started under, so its resolved target would not run a program. The confirmed
            // identity was checked in `validate`; a link that is re-pointed later is the person's own change.
            command: node.to_string_lossy().into_owned(),
            env: EnvVars(request.env.clone()),
            install: Some(AcpInstall {
                index_integrity: Some(request.integrity.clone()),
                publisher: request.publisher.clone(),
                sha256,
                source: request.source.clone(),
                tree_sha256: Some(tree.clone()),
                version: request.version.clone(),
            }),
            key: request.key.clone(),
            label: request.label.trim().to_owned(),
        };

        validate_agent(&agent)?;
        self.commit_install(&mut agent, &prefix, &final_dir)?;

        self.audit(json!({
            "at": now_ms(), "decision": "approved", "detail": format!("{} {} ({}) by {} integrity {} tree {tree}", request.label, request.version, request.package, request.publisher, request.integrity),
            "status": "installed", "tool": "acp_install",
        }));
        self.emit(Event::Changed);

        Ok(self.acp_view())
    }
}

impl DeviceState {
    /// Refuses to start an agent whose installed files no longer hash to what was recorded at install. An agent
    /// without a recorded tree (a binary install, or one added by hand) is not checked.
    pub(crate) fn verify_installed_tree(
        &self,
        agent: &AcpAgent,
        pin: &AcpInstall,
    ) -> Result<(), String> {
        let Some(expected) = &pin.tree_sha256 else {
            return Ok(());
        };
        let dir = self.install_root().join(&agent.key).join(&pin.version);

        // The interpreter is the person's own Node, not part of the hashed files. When an upgrade or a version
        // manager removed it, say so rather than letting the start fail with an operating-system error.
        if !fs::metadata(&agent.command).is_ok_and(|meta| meta.is_file()) {
            self.audit(json!({
                "at": now_ms(), "decision": "refused", "detail": format!("{} {}: the interpreter it was installed to run with is gone", agent.label, pin.version),
                "status": "refused", "tool": "acp_start",
            }));

            return Err(format!(
                "{} {} was installed to run with {}, which is gone. Reinstall it from the registry, or edit its command to the full path of the Node.js that is here now (changing the interpreter removes the install checks: the pin is dropped and the files stay).",
                agent.label, pin.version, agent.command
            ));
        }

        // Node looks for modules in every `node_modules` above the program too. Those in the agent's folder, the
        // install root and the app's data folder are never made by an install, so one that exists is planted:
        // refuse. Folders above the data folder (the person's home, their projects) are theirs and are not checked;
        // see the consent text.
        let data_dir = self.data_dir();

        for outside in
            self.install_root()
                .join(&agent.key)
                .ancestors()
                .scan(false, |done, folder| {
                    let last = std::mem::replace(done, folder == data_dir);

                    (!last).then(|| folder.join("node_modules"))
                })
        {
            if fs::symlink_metadata(&outside).is_ok() {
                self.audit(json!({
                    "at": now_ms(), "decision": "refused", "detail": format!("{} {}: unexpected node_modules next to the install", agent.label, pin.version),
                    "status": "refused", "tool": "acp_start",
                }));

                return Err(format!(
                    "{} {} has a node_modules folder next to its install that Neore did not put there ({}). Neore will not start it. Remove that folder, or reinstall the agent.",
                    agent.label,
                    pin.version,
                    outside.display()
                ));
            }
        }

        let actual = if fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            match tree_hash(&dir) {
                Ok(hash) => Some(hash),
                Err(reason) => {
                    self.audit(json!({
                        "at": now_ms(), "decision": "refused", "detail": format!("{} {}: installed files could not be checked: {reason}", agent.label, pin.version),
                        "status": "refused", "tool": "acp_start",
                    }));

                    return Err(format!(
                        "{} {} could not be checked against the files recorded when it was installed ({reason}). Neore will not start it. Reinstall it from the registry, or remove it.",
                        agent.label, pin.version
                    ));
                }
            }
        } else {
            None
        };

        if actual.as_ref() == Some(expected) {
            return Ok(());
        }

        self.audit(json!({
            "at": now_ms(), "decision": "refused", "detail": format!("{} {}: installed files changed", agent.label, pin.version),
            "status": "refused", "tool": "acp_start",
        }));

        Err(format!(
            "{} {} no longer matches the files recorded when it was installed (a file was changed, added or removed). Neore will not start it. Reinstall it from the registry, or remove it.",
            agent.label, pin.version
        ))
    }
}

#[cfg(all(test, unix))]
#[path = "acp_install_npm_tests.rs"]
mod tests;
