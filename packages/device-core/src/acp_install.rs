//! Installing a coding agent from the ACP registry: checks the downloaded archive, unpacks it and registers the
//! command.
//!
//! The desktop main process asks the user (publisher, version and source, in a native dialog) and downloads the
//! archive into a staging folder this module made ([`DeviceState::acp_install_stage`]); everything after that
//! is decided here, and reachable only through the addon, never through `acp_update`:
//!
//! 1. the archive's SHA-256 must equal the registry's, or the install is refused and nothing is kept;
//! 2. it is unpacked into the staging folder, refusing any entry that is absolute, climbs out with `..`, or is not
//!    a plain file or folder (a link could point anywhere), and any archive that unpacks past a size or entry cap;
//! 3. the command is resolved INSIDE the unpacked folder and must be a regular file, and only now gets its
//!    executable bit;
//! 4. the folder is renamed to `acp-agents/<key>/<version>` next to `device.json` and the agent is recorded with
//!    its pin ([`AcpInstall`]).
//!
//! An install grants no folder: the (agent, folder) approval still comes from the local window, as for any agent.
//! Nothing here looks for a newer version. A second install of the same key is another explicit install, and it
//! drops the approvals because the command is a different program.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::acp::{
    changes_program, validate_agent, validate_env_var, AcpAgent, AcpInstall, AcpView, EnvVars,
};
use crate::engine::{now_ms, DeviceState, Event};
use crate::hmac::to_hex;

const INSTALL_DIR: &str = "acp-agents";
const STAGING_DIR: &str = ".staging";
const UNPACKED_DIR: &str = "unpacked";
const MAX_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
/// A staging folder left by a crash is removed after this long.
const STALE_STAGING_MS: u64 = 24 * 60 * 60 * 1000;

static STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum ArchiveFormat {
    #[serde(rename = "raw")]
    Raw,
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "zip")]
    Zip,
}

/// What the main process read from the registry entry it showed the user. The archive is a file it downloaded
/// into [`DeviceState::acp_install_stage`]'s folder; this module trusts none of the rest until it has checked it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallRequest {
    pub archive: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The executable inside the archive, relative to its root (`./agent`, `bin/agent.exe`).
    pub cmd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub format: ArchiveFormat,
    pub key: String,
    pub label: String,
    pub publisher: String,
    pub sha256: String,
    pub source: String,
    pub version: String,
}

fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

fn valid_version(version: &str) -> bool {
    (1..=40).contains(&version.len())
        && version.starts_with(|c: char| c.is_ascii_digit())
        && !version.contains("..")
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
}

/// `path` as a relative path of plain names. `.` is dropped; an absolute path, a drive prefix or `..` is refused.
fn safe_relative(path: &Path) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Normal(name) => clean.push(name),
            Component::CurDir => {}
            _ => return Err(format!("{} leaves the folder", path.display())),
        }
    }

    Ok(clean)
}

fn validate(request: &InstallRequest) -> Result<(), String> {
    let hex = request.sha256.as_bytes();

    if hex.len() != 64 || !hex.iter().all(u8::is_ascii_hexdigit) {
        return Err("the registry gave no usable SHA-256 for this download".into());
    }

    if !valid_version(&request.version) {
        return Err("the registry's version is not a plain version number".into());
    }

    for (name, text, max) in [
        ("publisher", &request.publisher, 200),
        ("source", &request.source, 1000),
    ] {
        if text.trim().is_empty() || text.len() > max || has_control(text) {
            return Err(format!("the registry's {name} is empty or too long"));
        }
    }

    // Every variable goes through the same checks as one the user types, and a name that changes which code runs
    // would make this a different program than the one the approvals were given for.
    for (name, value) in &request.env {
        validate_env_var(name, value)?;

        if changes_program(name) {
            return Err(format!("{name} changes which code the agent runs"));
        }
    }

    Ok(())
}

impl DeviceState {
    fn install_root(&self) -> PathBuf {
        self.data_dir().join(INSTALL_DIR)
    }

    /// A fresh, empty, owner-only folder for one download. The caller writes the archive there and passes its
    /// path to [`Self::acp_install`], which removes the folder whatever the outcome; a caller whose download
    /// fails removes it itself.
    pub fn acp_install_stage(&self) -> Result<String, String> {
        let staging = self.install_root().join(STAGING_DIR);

        fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
        remove_stale(&staging);

        let name = format!(
            "{}-{}-{}",
            std::process::id(),
            now_ms(),
            STAGING_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let dir = staging.join(name);

        create_private_dir(&dir)?;

        Ok(dir.to_string_lossy().into_owned())
    }

    /// Verifies, unpacks and registers `request`. Any refusal leaves no file behind.
    pub fn acp_install(&self, request: InstallRequest) -> Result<AcpView, String> {
        validate(&request)?;

        let staged = self.staged_archive(&request.archive)?;
        let stage_dir = staged
            .parent()
            .ok_or("the download is not in a staging folder")?
            .to_path_buf();
        let result = self.install_staged(&request, &staged, &stage_dir);

        // The archive and anything half-unpacked go whatever happened; a successful install already moved its
        // folder out.
        let _ = fs::remove_dir_all(&stage_dir);

        result
    }

    /// The archive's canonical path, which must be a file directly inside one folder made by `acp_install_stage`.
    fn staged_archive(&self, archive: &str) -> Result<PathBuf, String> {
        let staging = self.install_root().join(STAGING_DIR);
        let staging = fs::canonicalize(&staging)
            .map_err(|_| "no download was staged: start the install again".to_owned())?;
        let archive =
            fs::canonicalize(archive).map_err(|_| "the downloaded file is missing".to_owned())?;
        let in_a_stage = archive
            .parent()
            .and_then(Path::parent)
            .is_some_and(|grandparent| grandparent == staging);

        if !in_a_stage || !fs::metadata(&archive).is_ok_and(|meta| meta.is_file()) {
            return Err("the download is not in a staging folder".into());
        }

        Ok(archive)
    }

    fn install_staged(
        &self,
        request: &InstallRequest,
        archive: &Path,
        stage_dir: &Path,
    ) -> Result<AcpView, String> {
        let actual = sha256_file(archive)?;

        if actual != request.sha256.to_ascii_lowercase() {
            self.audit(json!({
                "at": now_ms(), "decision": "refused", "detail": format!("{} {}: checksum mismatch", request.label, request.version),
                "status": "refused", "tool": "acp_install",
            }));

            return Err(format!(
                "The download does not match the checksum the registry published (expected {}, got {actual}). Nothing was installed.",
                request.sha256.to_ascii_lowercase()
            ));
        }

        let unpacked = stage_dir.join(UNPACKED_DIR);

        fs::create_dir(&unpacked).map_err(|error| error.to_string())?;

        let wanted = safe_relative(Path::new(&request.cmd))?;

        match request.format {
            ArchiveFormat::Raw => {
                if wanted.components().count() != 1 {
                    return Err("a raw download holds one file: the command is its name".into());
                }

                fs::copy(archive, unpacked.join(&wanted)).map_err(|error| error.to_string())?;
            }
            ArchiveFormat::TarGz => unpack_tar_gz(archive, &unpacked)?,
            ArchiveFormat::Zip => unpack_zip(archive, &unpacked)?,
        }

        let relative = resolve_command(&unpacked, &wanted)?;
        let final_dir = self
            .install_root()
            .join(&request.key)
            .join(&request.version);
        let command = final_dir.join(&relative).to_string_lossy().into_owned();
        let mut agent = AcpAgent {
            args: request.args.clone(),
            command,
            env: EnvVars(request.env.clone()),
            install: Some(AcpInstall {
                publisher: request.publisher.clone(),
                sha256: actual,
                source: request.source.clone(),
                version: request.version.clone(),
            }),
            key: request.key.clone(),
            label: request.label.trim().to_owned(),
        };

        validate_agent(&agent)?;
        self.check_free(&agent)?;

        // Replacing the same version (an explicit reinstall) starts clean.
        let _ = fs::remove_dir_all(&final_dir);
        fs::create_dir_all(final_dir.parent().unwrap_or(&final_dir))
            .map_err(|error| error.to_string())?;
        fs::rename(&unpacked, &final_dir).map_err(|error| error.to_string())?;

        let recorded = self.change_settings(|settings| {
            let existing = settings
                .acp_agents
                .iter()
                .position(|candidate| candidate.key == agent.key);

            match existing {
                Some(i) => {
                    if settings.acp_agents[i].install.is_none() {
                        return Err(already_registered(&agent.key));
                    }

                    // The user's own variables stay; the registry's are laid over them.
                    let mut env = settings.acp_agents[i].env.clone();

                    env.0.extend(std::mem::take(&mut agent.env.0));
                    agent.env = env;

                    // A different version is a different program than the one the folders were approved for.
                    if settings.acp_agents[i].command != agent.command
                        || settings.acp_agents[i].args != agent.args
                    {
                        settings.acp_consents.retain(|c| c.agent_key != agent.key);
                    }

                    settings.acp_agents[i] = agent.clone();
                }
                None if settings.acp_agents.len() >= crate::acp::MAX_AGENTS => {
                    return Err(format!("at most {} agents", crate::acp::MAX_AGENTS));
                }
                None => settings.acp_agents.push(agent.clone()),
            }

            Ok(())
        });

        if let Err(error) = recorded {
            let _ = fs::remove_dir_all(&final_dir);

            return Err(error);
        }

        // Only the pinned version stays on disk.
        prune_other_versions(final_dir.parent(), &request.version);

        self.audit(json!({
            "at": now_ms(), "decision": "approved", "detail": format!("{} {} by {} sha256 {}", request.label, request.version, request.publisher, request.sha256.to_ascii_lowercase()),
            "status": "installed", "tool": "acp_install",
        }));
        self.emit(Event::Changed);

        Ok(self.acp_view())
    }

    /// An agent registered by hand under this key is not replaced by an install.
    fn check_free(&self, agent: &AcpAgent) -> Result<(), String> {
        let settings = self.settings();

        match settings
            .acp_agents
            .iter()
            .find(|candidate| candidate.key == agent.key)
        {
            Some(existing) if existing.install.is_none() => Err(already_registered(&agent.key)),
            _ => Ok(()),
        }
    }

    /// Deletes what an installed agent left on disk. `key` is a validated agent key, so it is one folder name.
    pub(crate) fn remove_installed_files(&self, key: &str) {
        if safe_relative(Path::new(key)).is_ok_and(|clean| clean.components().count() == 1) {
            let _ = fs::remove_dir_all(self.install_root().join(key));
        }
    }
}

fn already_registered(key: &str) -> String {
    format!("an agent with the key “{key}” is already registered by hand: remove it first")
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;

        fs::DirBuilder::new()
            .mode(0o700)
            .create(dir)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(dir).map_err(|error| error.to_string())
    }
}

fn remove_stale(staging: &Path) {
    let Ok(entries) = fs::read_dir(staging) else {
        return;
    };

    for entry in entries.flatten() {
        let age = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok());

        if age.is_some_and(|age| age.as_millis() as u64 > STALE_STAGING_MS) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn prune_other_versions(key_dir: Option<&Path>, keep: &str) {
    let Some(key_dir) = key_dir else { return };
    let Ok(entries) = fs::read_dir(key_dir) else {
        return;
    };

    for entry in entries.flatten() {
        if entry.file_name() != keep {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];

    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;

        if read == 0 {
            return Ok(to_hex(&hasher.finalize()));
        }

        hasher.update(&buffer[..read]);
    }
}

/// Tracks what an unpack has written, so an archive that is far larger than it looks is stopped.
#[derive(Default)]
struct Budget {
    bytes: u64,
    entries: usize,
}

impl Budget {
    fn entry(&mut self) -> Result<(), String> {
        self.entries += 1;

        if self.entries > MAX_ENTRIES {
            return Err("the archive holds too many files".into());
        }

        Ok(())
    }
}

/// Writes `source` to `target` (a new file), counting against the budget. `executable` keeps the archive's
/// exec bit; the command gets it again after it is resolved.
fn write_entry(
    source: &mut impl Read,
    target: &Path,
    executable: bool,
    budget: &mut Budget,
) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    // `create_new`: a name that appears twice, or one that already is a link, is an error, not an overwrite.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("{}: {error}", target.display()))?;
    let remaining = MAX_UNPACKED_BYTES - budget.bytes;
    let copied =
        io::copy(&mut source.take(remaining + 1), &mut file).map_err(|error| error.to_string())?;

    budget.bytes += copied;

    if budget.bytes > MAX_UNPACKED_BYTES {
        return Err("the archive unpacks to more than 2 GiB".into());
    }

    set_mode(target, if executable { 0o755 } else { 0o644 })
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

fn unpack_tar_gz(archive: &Path, into: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut budget = Budget::default();

    for entry in tar.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.header().entry_type();

        budget.entry()?;

        if kind.is_pax_global_extensions() {
            continue;
        }

        let path = entry.path().map_err(|error| error.to_string())?;
        let relative = safe_relative(&path)?;

        if kind.is_dir() {
            fs::create_dir_all(into.join(relative)).map_err(|error| error.to_string())?;
        } else if kind.is_file() {
            if relative.as_os_str().is_empty() {
                return Err("the archive has a file with no name".into());
            }

            let executable = entry.header().mode().is_ok_and(|mode| mode & 0o111 != 0);

            write_entry(&mut entry, &into.join(relative), executable, &mut budget)?;
        } else {
            // Links can point anywhere, and devices and pipes are not part of a program.
            return Err(format!(
                "the archive holds an entry that is not a plain file or folder: {}",
                path.display()
            ));
        }
    }

    Ok(())
}

fn unpack_zip(archive: &Path, into: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut budget = Budget::default();

    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;

        budget.entry()?;

        let name = entry
            .name()
            .map_or_else(|_| "an unreadable name".into(), |name| name.into_owned());
        let relative = safe_relative(
            &entry
                .enclosed_name()
                .ok_or_else(|| format!("{name} leaves the folder"))?,
        )?;
        let mode = entry.unix_mode().unwrap_or(0o644);

        // S_IFMT: a symbolic link (or anything but a file or folder) is refused.
        if !matches!(mode & 0o170_000, 0 | 0o100_000 | 0o040_000) {
            return Err(format!(
                "the archive holds an entry that is not a plain file or folder: {name}"
            ));
        }

        if entry.is_dir() {
            fs::create_dir_all(into.join(relative)).map_err(|error| error.to_string())?;
        } else {
            if relative.as_os_str().is_empty() {
                return Err("the archive has a file with no name".into());
            }

            write_entry(
                &mut entry,
                &into.join(relative),
                mode & 0o111 != 0,
                &mut budget,
            )?;
        }
    }

    Ok(())
}

/// The command's path inside `unpacked`, relative to it. It must be a regular file there (never a link, never a
/// bare name that could be looked up on PATH) and only now gets its executable bit.
fn resolve_command(unpacked: &Path, wanted: &Path) -> Result<PathBuf, String> {
    let candidate = unpacked.join(wanted);
    let meta = fs::symlink_metadata(&candidate).map_err(|_| {
        format!(
            "the archive does not contain the command {}",
            wanted.display()
        )
    })?;

    if !meta.is_file() {
        return Err(format!("{} is not a plain file", wanted.display()));
    }

    let canonical = fs::canonicalize(&candidate).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(unpacked).map_err(|error| error.to_string())?;

    if !canonical.starts_with(&root) {
        return Err(format!("{} leaves the folder", wanted.display()));
    }

    set_mode(&candidate, 0o755)?;

    Ok(wanted.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::AcpUpdate;
    use std::io::Write;

    fn state(name: &str) -> (DeviceState, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("neore-acp-install-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        (DeviceState::new(&dir, Box::new(|_| {})), dir)
    }

    fn sha(bytes: &[u8]) -> String {
        to_hex(&Sha256::digest(bytes))
    }

    /// A gzip tar from `(path, bytes, mode)` entries, plus extra raw header kinds for the refusal tests.
    fn tar_gz(files: &[(&str, &[u8], u32)], links: &[(&str, &str, tar::EntryType)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());

        for (path, bytes, mode) in files {
            let mut header = tar::Header::new_gnu();

            header.set_size(bytes.len() as u64);
            header.set_mode(*mode);
            header.set_entry_type(tar::EntryType::Regular);
            // `set_path` itself refuses `..` and absolute paths; the raw name field does not.
            header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            builder.append(&header, *bytes).unwrap();
        }

        for (path, target, kind) in links {
            let mut header = tar::Header::new_gnu();

            header.set_size(0);
            header.set_mode(0o777);
            header.set_entry_type(*kind);
            header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
            header.as_old_mut().linkname[..target.len()].copy_from_slice(target.as_bytes());
            header.set_cksum();
            builder.append(&header, io::empty()).unwrap();
        }

        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());

        gz.write_all(&builder.into_inner().unwrap()).unwrap();
        gz.finish().unwrap()
    }

    fn zip_of(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));

        for (path, bytes, mode) in files {
            writer
                .start_file(
                    *path,
                    zip::write::SimpleFileOptions::default().unix_permissions(*mode),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }

        writer.finish().unwrap().into_inner()
    }

    fn request(stage: &str, bytes: &[u8], format: ArchiveFormat, cmd: &str) -> InstallRequest {
        let archive = Path::new(stage).join("download");

        fs::write(&archive, bytes).unwrap();

        InstallRequest {
            archive: archive.to_string_lossy().into_owned(),
            args: vec!["acp".into()],
            cmd: cmd.into(),
            env: BTreeMap::new(),
            format,
            key: "demo".into(),
            label: "Demo".into(),
            publisher: "Example Inc.".into(),
            sha256: sha(bytes),
            source: "https://example.com/demo.tar.gz".into(),
            version: "1.2.3".into(),
        }
    }

    fn install_tree(dir: &Path) -> Vec<String> {
        fn walk(path: &Path, out: &mut Vec<String>) {
            for entry in fs::read_dir(path).into_iter().flatten().flatten() {
                out.push(entry.path().to_string_lossy().into_owned());

                if entry.path().is_dir() {
                    walk(&entry.path(), out);
                }
            }
        }

        let mut out = Vec::new();

        walk(&dir.join(INSTALL_DIR), &mut out);

        out
    }

    #[test]
    fn a_checksum_mismatch_is_refused_and_nothing_is_kept() {
        let (state, dir) = state("mismatch");
        let archive = tar_gz(&[("agent", b"#!/bin/sh\n", 0o644)], &[]);
        let stage = state.acp_install_stage().unwrap();
        let mut bad = request(&stage, &archive, ArchiveFormat::TarGz, "./agent");

        bad.sha256 = sha(b"something else");

        let error = state.acp_install(bad).unwrap_err();

        assert!(error.contains("does not match the checksum"), "{error}");
        assert!(state.acp_view().agents.is_empty());
        assert!(!Path::new(&stage).exists(), "the staging folder is removed");
        assert!(
            install_tree(&dir)
                .iter()
                .all(|path| path.ends_with(".staging")),
            "{:?}",
            install_tree(&dir)
        );
        assert!(fs::read_to_string(dir.join("device-audit.jsonl"))
            .unwrap()
            .contains("checksum mismatch"));
    }

    #[test]
    fn a_verified_archive_is_unpacked_made_executable_and_pinned() {
        let (state, dir) = state("ok");
        let archive = tar_gz(
            &[
                ("./agent", b"#!/bin/sh\n", 0o644),
                ("lib/data.txt", b"x", 0o644),
            ],
            &[],
        );
        let stage = state.acp_install_stage().unwrap();
        let view = state
            .acp_install(request(&stage, &archive, ArchiveFormat::TarGz, "./agent"))
            .unwrap();
        let agent = &view.agents[0];
        let install = agent.install.as_ref().unwrap();

        assert_eq!(agent.key, "demo");
        assert_eq!(install.version, "1.2.3");
        assert_eq!(install.publisher, "Example Inc.");
        assert_eq!(install.sha256, sha(&archive));
        assert_eq!(
            Path::new(&agent.command),
            dir.join("acp-agents/demo/1.2.3/agent")
        );
        assert!(dir.join("acp-agents/demo/1.2.3/lib/data.txt").exists());
        assert!(!Path::new(&stage).exists());
        assert!(view.consents.is_empty(), "an install approves no folder");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(&agent.command).unwrap().permissions().mode();

            assert_eq!(mode & 0o777, 0o755, "the command is executable");
        }
    }

    #[test]
    fn zip_and_raw_downloads_install_too() {
        let (state, dir) = state("formats");
        let zipped = zip_of(&[("bin/agent.exe", b"MZ", 0o644)]);
        let stage = state.acp_install_stage().unwrap();

        state
            .acp_install(request(
                &stage,
                &zipped,
                ArchiveFormat::Zip,
                "bin/agent.exe",
            ))
            .unwrap();
        assert!(dir.join("acp-agents/demo/1.2.3/bin/agent.exe").is_file());

        let stage = state.acp_install_stage().unwrap();
        let mut raw = request(&stage, b"\x7fELF", ArchiveFormat::Raw, "./tool");

        raw.key = "tool".into();
        state.acp_install(raw).unwrap();
        assert!(dir.join("acp-agents/tool/1.2.3/tool").is_file());
    }

    #[test]
    fn entries_that_leave_the_folder_or_link_out_are_refused() {
        let (state, dir) = state("traversal");
        let cases: [(&str, Vec<u8>); 4] = [
            (
                "dotdot",
                tar_gz(&[("../escape", b"x", 0o644), ("agent", b"x", 0o755)], &[]),
            ),
            (
                "absolute",
                tar_gz(
                    &[("/tmp/neore-escape", b"x", 0o644), ("agent", b"x", 0o755)],
                    &[],
                ),
            ),
            (
                "symlink",
                tar_gz(
                    &[("agent", b"x", 0o755)],
                    &[("link", "/etc/passwd", tar::EntryType::Symlink)],
                ),
            ),
            (
                "hardlink",
                tar_gz(
                    &[("agent", b"x", 0o755)],
                    &[("link", "agent", tar::EntryType::Link)],
                ),
            ),
        ];

        for (name, archive) in cases {
            let stage = state.acp_install_stage().unwrap();
            let error = state
                .acp_install(request(&stage, &archive, ArchiveFormat::TarGz, "agent"))
                .unwrap_err();

            assert!(
                error.contains("leaves the folder") || error.contains("not a plain file"),
                "{name}: {error}"
            );
        }

        assert!(!dir.join("escape").exists());
        assert!(!Path::new("/tmp/neore-escape").exists());
        assert!(state.acp_view().agents.is_empty());
        assert!(install_tree(&dir).iter().all(|p| p.ends_with(".staging")));
    }

    #[test]
    fn a_zip_entry_that_climbs_out_is_refused() {
        let (state, dir) = state("zip-traversal");
        let archive = zip_of(&[("../escape", b"x", 0o644), ("agent", b"x", 0o755)]);
        let stage = state.acp_install_stage().unwrap();
        let error = state
            .acp_install(request(&stage, &archive, ArchiveFormat::Zip, "agent"))
            .unwrap_err();

        assert!(error.contains("leaves the folder"), "{error}");
        assert!(!dir.join("escape").exists());
    }

    #[test]
    fn the_command_must_be_a_file_inside_the_archive() {
        let (state, _dir) = state("command");
        let archive = tar_gz(&[("agent", b"x", 0o755)], &[]);

        for cmd in ["missing", "../agent", "/bin/sh", "bin"] {
            let stage = state.acp_install_stage().unwrap();
            let error = state
                .acp_install(request(&stage, &archive, ArchiveFormat::TarGz, cmd))
                .unwrap_err();

            assert!(
                error.contains("does not contain")
                    || error.contains("leaves the folder")
                    || error.contains("not a plain file"),
                "{cmd}: {error}"
            );
        }
    }

    #[test]
    fn only_a_download_in_a_staging_folder_is_installed() {
        let (state, dir) = state("outside");
        let archive = tar_gz(&[("agent", b"x", 0o755)], &[]);
        let outside = dir.join("download");

        fs::write(&outside, &archive).unwrap();
        state.acp_install_stage().unwrap();

        let mut req = request(
            &state.acp_install_stage().unwrap(),
            &archive,
            ArchiveFormat::TarGz,
            "agent",
        );

        req.archive = outside.to_string_lossy().into_owned();

        assert!(state.acp_install(req).unwrap_err().contains("staging"));
        assert!(outside.exists(), "a file outside is not touched");
    }

    #[test]
    fn registry_variables_are_checked_like_typed_ones() {
        let (state, _dir) = state("env");
        let archive = tar_gz(&[("agent", b"x", 0o755)], &[]);

        for name in ["NODE_OPTIONS", "NEORE_TOKEN", "LD_PRELOAD", "PATH"] {
            let stage = state.acp_install_stage().unwrap();
            let mut req = request(&stage, &archive, ArchiveFormat::TarGz, "agent");

            req.env.insert(name.into(), "x".into());

            let error = state.acp_install(req).unwrap_err();

            assert!(
                error.contains("reserved") || error.contains("changes which code"),
                "{name}: {error}"
            );
            assert!(!error.contains("=x"), "a value is never quoted back");
        }

        let stage = state.acp_install_stage().unwrap();
        let mut ok = request(&stage, &archive, ArchiveFormat::TarGz, "agent");

        ok.env.insert("DEMO_MODE".into(), "acp".into());

        assert_eq!(
            state.acp_install(ok).unwrap().agents[0].env_names,
            ["DEMO_MODE"]
        );
    }

    #[test]
    fn an_agent_registered_by_hand_is_not_replaced() {
        let (state, dir) = state("collision");
        let archive = tar_gz(&[("agent", b"x", 0o755)], &[]);

        state
            .acp_update(
                serde_json::from_str(
                    r#"{"op":"saveAgent","key":"demo","label":"Mine","command":"/bin/mine","args":[]}"#,
                )
                .unwrap(),
            )
            .unwrap();

        let stage = state.acp_install_stage().unwrap();
        let error = state
            .acp_install(request(&stage, &archive, ArchiveFormat::TarGz, "agent"))
            .unwrap_err();

        assert!(error.contains("already registered"), "{error}");
        assert_eq!(state.acp_view().agents[0].command, "/bin/mine");
        assert!(!dir.join("acp-agents/demo").exists());
    }

    #[test]
    fn a_new_install_is_explicit_and_drops_the_approvals_of_the_old_one() {
        let (state, dir) = state("reinstall");
        let first = tar_gz(&[("agent", b"one", 0o755)], &[]);
        let second = tar_gz(&[("agent", b"two", 0o755)], &[]);
        let folder = dir.join("work");

        fs::create_dir_all(&folder).unwrap();

        let stage = state.acp_install_stage().unwrap();

        state
            .acp_install(request(&stage, &first, ArchiveFormat::TarGz, "agent"))
            .unwrap();
        state
            .acp_update(AcpUpdate::Grant {
                agent_key: "demo".into(),
                folder: folder.to_string_lossy().into_owned(),
            })
            .unwrap();
        assert_eq!(state.acp_view().consents.len(), 1);

        // Nothing but an install changes the pin: the recorded command and version stay put.
        let plan = state
            .acp_spawn_plan("demo", Some(&folder.to_string_lossy()))
            .unwrap();

        assert!(plan.command.ends_with("acp-agents/demo/1.2.3/agent"));

        let stage = state.acp_install_stage().unwrap();
        let mut newer = request(&stage, &second, ArchiveFormat::TarGz, "agent");

        newer.version = "1.3.0".into();

        let view = state.acp_install(newer).unwrap();

        assert_eq!(view.agents[0].install.as_ref().unwrap().version, "1.3.0");
        assert!(
            view.consents.is_empty(),
            "a different program, a new approval"
        );
        assert!(
            !dir.join("acp-agents/demo/1.2.3").exists(),
            "only the pinned version stays"
        );
        assert!(dir.join("acp-agents/demo/1.3.0/agent").is_file());
    }

    #[test]
    fn changing_an_installed_command_clears_its_pin_and_removing_it_deletes_the_files() {
        let (state, dir) = state("remove");
        let archive = tar_gz(&[("agent", b"x", 0o755)], &[]);
        let stage = state.acp_install_stage().unwrap();
        let view = state
            .acp_install(request(&stage, &archive, ArchiveFormat::TarGz, "agent"))
            .unwrap();
        let command = view.agents[0].command.clone();
        let save = |command: &str| {
            state
                .acp_update(
                    serde_json::from_str(&format!(
                        r#"{{"op":"saveAgent","key":"demo","label":"Demo!","command":"{command}","args":["acp"]}}"#
                    ))
                    .unwrap(),
                )
                .unwrap()
        };

        assert!(
            save(&command).agents[0].install.is_some(),
            "a rename keeps the pin"
        );
        assert!(
            save("/bin/other").agents[0].install.is_none(),
            "a different command is not the installed one"
        );

        // Removing a hand-registered agent never touches the install folder; the pin was cleared above.
        state
            .acp_update(AcpUpdate::RemoveAgent { key: "demo".into() })
            .unwrap();
        assert!(dir.join("acp-agents/demo").exists());

        let stage = state.acp_install_stage().unwrap();

        state
            .acp_install(request(&stage, &archive, ArchiveFormat::TarGz, "agent"))
            .unwrap();
        state
            .acp_update(AcpUpdate::RemoveAgent { key: "demo".into() })
            .unwrap();
        assert!(!dir.join("acp-agents/demo").exists());
    }

    #[test]
    fn the_install_record_reaches_the_window_only_as_part_of_the_view() {
        // `acp_update` cannot carry an install: its ops are closed and reject unknown fields.
        assert!(serde_json::from_str::<AcpUpdate>(
            r#"{"op":"saveAgent","key":"a","label":"A","command":"c","args":[],"install":{"version":"1"}}"#
        )
        .is_err());
    }
}
