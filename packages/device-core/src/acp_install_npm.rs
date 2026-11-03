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
    create_private_dir, safe_relative, sha256_reader, validate_provenance, UNPACKED_DIR,
};
use crate::engine::{now_ms, DeviceState, Event};
use crate::hmac::to_hex;

const NPM_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_TREE_ENTRIES: usize = 200_000;
const TARBALL: &str = "package.tgz";
const HOME_DIR: &str = "home";
/// Variables the install passes on: a proxy and certificate settings decide whether the network is reachable, and
/// nothing in them chooses which code runs.
const PASSED_ENV: [&str; 8] = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
];

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
    /// Absolute path of `node`.
    pub node: String,
    /// Absolute path of `npm`.
    pub npm: String,
    /// The package name, `name` or `@scope/name`.
    pub package: String,
    pub publisher: String,
    /// The tarball's URL, as the index gave it.
    pub source: String,
    pub version: String,
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

    Ok((
        program_path(&request.node, "node")?,
        program_path(&request.npm, "npm")?,
    ))
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

            match (map.len(), map.values().next()) {
                (1, Some(Value::String(path))) => Ok(path.clone()),
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

/// Runs `npm install --ignore-scripts` of `tarball` into `prefix`, with an environment built from nothing.
fn run_npm(
    node: &Path,
    npm: &Path,
    prefix: &Path,
    tarball: &Path,
    home: &Path,
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
    let mut command = Command::new(npm);

    command
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

    for name in PASSED_ENV {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("npm could not be started: {error}"))?;
    let deadline = Instant::now() + NPM_TIMEOUT;

    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(_) => {
                return Err(format!(
                    "npm could not install the package ({}). Nothing was installed",
                    tail(&log)
                ))
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();

                return Err(
                    "npm took too long to install the package. Nothing was installed".into(),
                );
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn put(hasher: &mut Sha256, tag: u8, parts: &[&[u8]]) {
    hasher.update([tag]);

    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
}

fn walk(root: &Path, dir: &Path, hasher: &mut Sha256, entries: &mut usize) -> Result<(), String> {
    let mut names = fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    names.sort();

    for name in names {
        *entries += 1;

        if *entries > MAX_TREE_ENTRIES {
            return Err("the installed folder holds too many entries".into());
        }

        let path = dir.join(&name);
        let meta = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let kind = meta.file_type();

        if kind.is_symlink() {
            let target = fs::read_link(&path).map_err(|error| error.to_string())?;

            put(
                hasher,
                b'L',
                &[relative.as_bytes(), target.to_string_lossy().as_bytes()],
            );
        } else if kind.is_dir() {
            put(hasher, b'D', &[relative.as_bytes()]);
            walk(root, &path, hasher, entries)?;
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
                    relative.as_bytes(),
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

    walk(root, root, &mut hasher, &mut 0)?;

    Ok(to_hex(&hasher.finalize()))
}

/// The tarball's SHA-512 as an SRI string, and its SHA-256 as hex, from one pass over one open handle.
fn digests(file: &mut fs::File) -> Result<(String, String), String> {
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

impl DeviceState {
    /// Verifies, installs and registers `request`. Any refusal leaves no file behind.
    pub fn acp_install_npm(&self, request: NpmInstallRequest) -> Result<AcpView, String> {
        let (node, npm) = validate(&request)?;
        let staged = self.staged_archive(&request.archive)?;
        let stage_dir = staged
            .parent()
            .ok_or("the download is not in a staging folder")?
            .to_path_buf();
        let result = self.install_npm_staged(&request, &node, &npm, &staged, &stage_dir);

        // npm's cache and anything half-installed go whatever happened; a successful install already moved its
        // folder out.
        let _ = fs::remove_dir_all(&stage_dir);

        result
    }

    fn install_npm_staged(
        &self,
        request: &NpmInstallRequest,
        node: &Path,
        npm: &Path,
        archive: &Path,
        stage_dir: &Path,
    ) -> Result<AcpView, String> {
        let mut file = fs::File::open(archive).map_err(|error| error.to_string())?;
        let (integrity, sha256) = digests(&mut file)?;

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
        run_npm(node, npm, &prefix, &tarball, &home)?;

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
        let inside = fs::canonicalize(&script)
            .ok()
            .zip(fs::canonicalize(&prefix).ok())
            .is_some_and(|(script, prefix)| script.starts_with(prefix));

        if relative.as_os_str().is_empty()
            || !inside
            || !fs::symlink_metadata(&script).is_ok_and(|meta| meta.is_file())
        {
            return Err("the program the package starts is not a file inside it".into());
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
        let actual = if fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            tree_hash(&dir).ok()
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
mod tests {
    use super::*;
    use std::io::Write;

    const PACKAGE: &str = "fixture-agent";

    fn state(name: &str) -> (DeviceState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("neore-acp-npm-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        (DeviceState::new(&dir, Box::new(|_| {})), dir)
    }

    /// A package tarball as the index serves it: everything under `package/`.
    fn tarball(manifest: &Value, extra: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let manifest = manifest.to_string();
        let mut files = vec![
            ("package.json", manifest.as_str()),
            ("cli.js", "console.log('hello');\n"),
        ];

        files.extend_from_slice(extra);

        for (path, text) in files {
            let mut header = tar::Header::new_gnu();

            header.set_size(text.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, format!("package/{path}"), text.as_bytes())
                .unwrap();
        }

        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());

        gz.write_all(&builder.into_inner().unwrap()).unwrap();
        gz.finish().unwrap()
    }

    fn manifest() -> Value {
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": { PACKAGE: "cli.js" } })
    }

    fn integrity(bytes: &[u8]) -> String {
        format!("sha512-{}", base64(&Sha512::digest(bytes)))
    }

    /// A stand-in `node` and an `npm` that records its arguments and unpacks the tarball like a real one would,
    /// so the flow is tested without a network or a Node installation.
    fn fake_tools(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let node = dir.join("node");
        let npm = dir.join("npm");
        let log = dir.join("npm-args.log");

        fs::write(&node, "#!/bin/sh\n").unwrap();
        fs::write(
            &npm,
            format!(
                "#!/bin/sh\necho \"$@\" > '{}'\nfor last; do :; done\nprefix=''\nwhile [ $# -gt 0 ]; do [ \"$1\" = --prefix ] && prefix=\"$2\"; shift; done\nmkdir -p \"$prefix/node_modules/{PACKAGE}\"\ntar xzf \"$last\" -C \"$prefix/node_modules/{PACKAGE}\" --strip-components=1\n",
                log.display()
            ),
        )
        .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            for path in [&node, &npm] {
                fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }

        (node, npm, log)
    }

    fn request(
        state: &DeviceState,
        node: &Path,
        npm: &Path,
        bytes: &[u8],
        integrity: String,
    ) -> NpmInstallRequest {
        let stage = state.acp_install_stage().unwrap();
        let archive = Path::new(&stage).join("download");

        fs::write(&archive, bytes).unwrap();

        NpmInstallRequest {
            archive: archive.to_string_lossy().into_owned(),
            args: vec!["--acp".into()],
            env: BTreeMap::new(),
            integrity,
            key: "fixture".into(),
            label: "Fixture".into(),
            node: node.to_string_lossy().into_owned(),
            npm: npm.to_string_lossy().into_owned(),
            package: PACKAGE.into(),
            publisher: "Example Inc.".into(),
            source: "https://registry.npmjs.org/fixture-agent/-/fixture-agent-1.0.0.tgz".into(),
            version: "1.0.0".into(),
        }
    }

    fn installed(dir: &Path) -> PathBuf {
        dir.join("acp-agents/fixture/1.0.0")
    }

    #[test]
    fn the_integrity_is_the_sri_of_the_bytes() {
        // Known vector: sha512("") in SRI form.
        assert_eq!(
            integrity(b""),
            "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="
        );
        assert!(valid_integrity(&integrity(b"x")));
        assert!(!valid_integrity("sha1-abc"));
        assert!(!valid_integrity(
            &integrity(b"x").replace("sha512-", "sha256-")
        ));
    }

    #[test]
    fn a_hash_that_is_not_the_downloads_is_refused_and_nothing_runs_or_stays() {
        let (state, dir) = state("mismatch");
        let (node, npm, log) = fake_tools(&dir);
        let bytes = tarball(&manifest(), &[]);
        let wrong = integrity(b"some other tarball");
        let error = state
            .acp_install_npm(request(&state, &node, &npm, &bytes, wrong))
            .unwrap_err();

        assert!(
            error.contains("does not match the hash the package index gave"),
            "{error}"
        );
        assert!(
            !log.exists(),
            "npm must not run on a download that fails the hash"
        );
        assert!(!installed(&dir).exists());
        assert!(state.acp_view().agents.is_empty());
        assert_eq!(
            fs::read_dir(dir.join("acp-agents/.staging"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn a_verified_download_is_installed_without_scripts_and_pinned_with_its_hashes() {
        let (state, dir) = state("pin");
        let (node, npm, log) = fake_tools(&dir);
        let bytes = tarball(&manifest(), &[]);
        let want = integrity(&bytes);
        let view = state
            .acp_install_npm(request(&state, &node, &npm, &bytes, want.clone()))
            .unwrap();
        let agent = &view.agents[0];
        let pin = agent.install.as_ref().unwrap();
        let script = installed(&dir)
            .join("node_modules")
            .join(PACKAGE)
            .join("cli.js");

        assert!(fs::read_to_string(&log)
            .unwrap()
            .contains("--ignore-scripts"));
        assert_eq!(agent.command, node.to_string_lossy());
        assert_eq!(
            agent.args,
            vec![script.to_string_lossy().into_owned(), "--acp".into()]
        );
        assert_eq!(pin.index_integrity.as_deref(), Some(want.as_str()));
        assert_eq!(pin.sha256, to_hex(&Sha256::digest(&bytes)));
        assert_eq!(
            pin.tree_sha256.as_deref(),
            Some(tree_hash(&installed(&dir)).unwrap().as_str())
        );
        assert!(script.is_file());
        // The staging folder, npm's cache included, is gone.
        assert_eq!(
            fs::read_dir(dir.join("acp-agents/.staging"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn a_changed_added_or_removed_file_refuses_the_start_and_says_so() {
        let (state, dir) = state("recheck");
        let (node, npm, _) = fake_tools(&dir);
        let bytes = tarball(&manifest(), &[]);

        state
            .acp_install_npm(request(
                &state,
                &node,
                &npm,
                &bytes.clone(),
                integrity(&bytes),
            ))
            .unwrap();

        let script = installed(&dir)
            .join("node_modules")
            .join(PACKAGE)
            .join("cli.js");
        let untouched = state.acp_spawn_plan("fixture", None).unwrap();

        assert_eq!(untouched.command, node.to_string_lossy());

        fs::write(&script, "console.log('changed');\n").unwrap();
        let changed = state.acp_spawn_plan("fixture", None).unwrap_err();
        assert!(
            changed.contains("no longer matches the files recorded"),
            "{changed}"
        );

        fs::write(&script, "console.log('hello');\n").unwrap();
        assert!(
            state.acp_spawn_plan("fixture", None).is_ok(),
            "restoring the bytes restores the start"
        );

        fs::write(
            installed(&dir)
                .join("node_modules")
                .join(PACKAGE)
                .join("extra.js"),
            "x",
        )
        .unwrap();
        assert!(state.acp_spawn_plan("fixture", None).is_err());
        fs::remove_file(
            installed(&dir)
                .join("node_modules")
                .join(PACKAGE)
                .join("extra.js"),
        )
        .unwrap();

        fs::remove_file(&script).unwrap();
        assert!(state.acp_spawn_plan("fixture", None).is_err());
    }

    #[test]
    fn a_missing_install_folder_refuses_the_start() {
        let (state, dir) = state("missing");
        let (node, npm, _) = fake_tools(&dir);
        let bytes = tarball(&manifest(), &[]);

        state
            .acp_install_npm(request(
                &state,
                &node,
                &npm,
                &bytes.clone(),
                integrity(&bytes),
            ))
            .unwrap();
        fs::remove_dir_all(installed(&dir)).unwrap();

        assert!(state.acp_spawn_plan("fixture", None).is_err());
    }

    #[test]
    fn the_installed_package_must_be_the_one_that_was_pinned() {
        let (state, dir) = state("identity");
        let (node, npm, _) = fake_tools(&dir);
        let other = tarball(
            &json!({ "name": PACKAGE, "version": "9.9.9", "bin": "cli.js" }),
            &[],
        );
        let error = state
            .acp_install_npm(request(&state, &node, &npm, &other, integrity(&other)))
            .unwrap_err();

        assert!(
            error.contains("not the name and version that was pinned"),
            "{error}"
        );
        assert!(!installed(&dir).exists());
        assert!(state.acp_view().agents.is_empty());
    }

    #[test]
    fn the_program_is_one_file_inside_the_package() {
        let (state, dir) = state("bin");
        let (node, npm, _) = fake_tools(&dir);

        for manifest in [
            json!({ "name": PACKAGE, "version": "1.0.0", "bin": "../outside.js" }),
            json!({ "name": PACKAGE, "version": "1.0.0", "bin": "/bin/sh" }),
            json!({ "name": PACKAGE, "version": "1.0.0", "bin": "missing.js" }),
            json!({ "name": PACKAGE, "version": "1.0.0", "bin": { "a": "cli.js", "b": "cli.js" } }),
            json!({ "name": PACKAGE, "version": "1.0.0" }),
        ] {
            let bytes = tarball(&manifest, &[]);

            assert!(
                state
                    .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
                    .is_err(),
                "{manifest}"
            );
            assert!(!installed(&dir).exists());
        }
    }

    #[test]
    fn editing_the_arguments_after_the_program_keeps_the_pin_and_the_check() {
        let (state, dir) = state("edit-args");
        let (node, npm, _) = fake_tools(&dir);
        let bytes = tarball(&manifest(), &[]);
        let view = state
            .acp_install_npm(request(
                &state,
                &node,
                &npm,
                &bytes.clone(),
                integrity(&bytes),
            ))
            .unwrap();
        let agent = &view.agents[0];
        let edit = |args: Vec<String>| {
            state
                .acp_update(
                    serde_json::from_value(json!({
                        "op": "saveAgent", "key": "fixture", "label": "Fixture", "command": agent.command, "args": args,
                    }))
                    .unwrap(),
                )
                .unwrap()
        };
        let script = agent.args[0].clone();

        // A trailing argument changes: still the pinned program, still hashed at every start.
        let edited = edit(vec![script.clone(), "--other".into()]);

        assert!(edited.agents[0].install.is_some());
        assert!(Path::new(&script).is_file());
        assert!(state.acp_spawn_plan("fixture", None).is_ok());
        fs::write(&script, "changed").unwrap();
        assert!(state.acp_spawn_plan("fixture", None).is_err());
        fs::write(&script, "console.log('hello');\n").unwrap();

        // The program itself is replaced: no longer the install, and its files go with it, as for a binary.
        let moved = edit(vec!["/elsewhere/agent.js".into()]);

        assert!(moved.agents[0].install.is_none());
        assert!(!installed(&dir).exists());
    }

    #[test]
    fn the_program_is_picked_like_npx_would() {
        let named = json!({ "bin": { "other": "o.js", "agent": "a.js" } });

        assert_eq!(pick_bin(&named, "@scope/agent").unwrap(), "a.js");
        assert_eq!(
            pick_bin(&json!({ "bin": { "x": "x.js" } }), "agent").unwrap(),
            "x.js"
        );
        assert_eq!(
            pick_bin(&json!({ "bin": "x.js" }), "agent").unwrap(),
            "x.js"
        );
        assert!(pick_bin(&json!({ "bin": { "a": "a.js", "b": "b.js" } }), "agent").is_err());
        assert!(pick_bin(&json!({}), "agent").is_err());
    }

    #[test]
    fn tools_must_be_absolute_files_and_names_plain() {
        let (state, dir) = state("tools");
        let (node, npm, _) = fake_tools(&dir);
        let bytes = tarball(&manifest(), &[]);
        let base = |state: &DeviceState| request(state, &node, &npm, &bytes, integrity(&bytes));

        for change in [
            |r: &mut NpmInstallRequest| r.node = "node".into(),
            |r: &mut NpmInstallRequest| r.npm = "/nonexistent/npm".into(),
            |r: &mut NpmInstallRequest| r.package = "../evil".into(),
            |r: &mut NpmInstallRequest| r.package = "Fixture Agent".into(),
            |r: &mut NpmInstallRequest| r.integrity = "sha1-nope".into(),
            |r: &mut NpmInstallRequest| r.version = "latest".into(),
            |r: &mut NpmInstallRequest| {
                r.env.insert("NODE_OPTIONS".into(), "--require x".into());
            },
        ] {
            let mut r = base(&state);

            change(&mut r);
            assert!(state.acp_install_npm(r).is_err());
        }

        assert!(valid_package_name("@scope/agent-x"));
        assert!(!valid_package_name("@scope"));
        assert!(!valid_package_name("a/b"));
    }

    #[test]
    fn only_a_download_in_a_staging_folder_is_installed() {
        let (state, dir) = state("outside");
        let (node, npm, _) = fake_tools(&dir);
        let bytes = tarball(&manifest(), &[]);
        let mut r = request(&state, &node, &npm, &bytes, integrity(&bytes));
        let elsewhere = dir.join("elsewhere.tgz");

        fs::write(&elsewhere, &bytes).unwrap();
        r.archive = elsewhere.to_string_lossy().into_owned();

        assert!(state.acp_install_npm(r).is_err());
    }

    /// A real `node` and `npm` from the PATH, or `None`. `NEORE_REQUIRE_NPM=1` turns a missing one into a failure.
    fn real_tools() -> Option<(PathBuf, PathBuf)> {
        let find = |name: &str| {
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .map(|dir| dir.join(name))
                .find(|path| path.is_file())
        };

        match (find("node"), find("npm")) {
            (Some(node), Some(npm)) => Some((node, npm)),
            _ => {
                assert!(
                    std::env::var_os("NEORE_REQUIRE_NPM").is_none(),
                    "NEORE_REQUIRE_NPM is set but node and npm were not found on PATH"
                );
                eprintln!("skipped: node and npm are not on PATH");

                None
            }
        }
    }

    fn marker_package(marker: &Path) -> Vec<u8> {
        let script = format!(
            "require('fs').writeFileSync({}, 'ran');\n",
            serde_json::to_string(&marker.to_string_lossy()).unwrap()
        );
        let manifest = json!({
            "name": PACKAGE, "version": "1.0.0", "bin": { PACKAGE: "cli.js" },
            "scripts": {
                "preinstall": "node marker.js", "install": "node marker.js",
                "postinstall": "node marker.js", "prepare": "node marker.js"
            }
        });

        tarball(&manifest, &[("marker.js", &script)])
    }

    #[test]
    fn no_lifecycle_script_runs_during_an_install() {
        let Some((node, npm)) = real_tools() else {
            return;
        };
        let (state, dir) = state("scripts");
        let marker = dir.join("script-ran");
        let bytes = marker_package(&marker);

        // The control: the same package, installed by npm without the flag, does run its script. Without this
        // the assertion below could pass for a fixture whose scripts never run.
        let control = dir.join("control");

        fs::create_dir_all(&control).unwrap();
        let tgz = control.join("package.tgz");

        fs::write(&tgz, &bytes).unwrap();
        let status = Command::new(&npm)
            .args([
                "install",
                "--no-audit",
                "--no-fund",
                "--no-package-lock",
                "--prefix",
            ])
            .arg(&control)
            .arg(&tgz)
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", node.parent().unwrap().display()),
            )
            .env("HOME", &control)
            .env("npm_config_cache", control.join("cache"))
            .output()
            .unwrap();

        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(
            marker.exists(),
            "the control install should have run the fixture's scripts"
        );
        fs::remove_file(&marker).unwrap();

        let view = state
            .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
            .unwrap();

        assert_eq!(view.agents.len(), 1);
        assert!(
            !marker.exists(),
            "a lifecycle script ran during the install"
        );
        assert!(state.acp_spawn_plan("fixture", None).is_ok());
    }

    #[test]
    fn a_real_npm_install_runs_the_package_with_the_pinned_node() {
        let Some((node, npm)) = real_tools() else {
            return;
        };
        let (state, dir) = state("real");
        let bytes = tarball(&manifest(), &[]);
        let view = state
            .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
            .unwrap();
        let agent = &view.agents[0];
        let output = Command::new(&agent.command)
            .args(&agent.args[..1])
            .output()
            .unwrap();

        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
        assert!(installed(&dir)
            .join("node_modules")
            .join(PACKAGE)
            .join("cli.js")
            .is_file());
    }
}
