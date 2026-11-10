//! Checking the files of an installed npm registry agent against what was recorded at install.
//!
//! An npm install pins a hash of the whole installed folder ([`tree_hash`]: every file, folder and link, with
//! executable bits) in [`AcpInstall::tree_sha256`]. The agent runs as `node <program>`; nothing is resolved at
//! launch. Before every start [`DeviceState::verify_installed_tree`] hashes the folder again and refuses to launch
//! when it no longer matches. The hash covers the dependencies npm fetched, which the package index's integrity
//! does not: they are trusted as they were at install, and a change afterwards is caught.

use std::fs;
use std::path::Path;

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::acp::{AcpAgent, AcpInstall};
use crate::acp_install::sha256_reader;
use crate::engine::{now_ms, DeviceState};
use crate::hmac::to_hex;

const MAX_TREE_ENTRIES: usize = 200_000;

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
        (Err(_), _) => true,
        (_, Err(_)) => false,
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

    walk(root, root, &mut hasher, &mut 0)?;

    Ok(to_hex(&hasher.finalize()))
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
            return Err(format!(
                "{} {} was installed to run with {}, which is gone. Reinstall it from the registry, or edit its command to the full path of the Node.js that is here now.",
                agent.label, pin.version, agent.command
            ));
        }

        // Node looks for modules in every `node_modules` above the program too. The two such folders inside our
        // own install root are never made by an install, so one that exists is planted: refuse. Folders above the
        // app's data folder (the person's home, their projects) are theirs and are not checked; see the consent text.
        for outside in [
            self.install_root().join(&agent.key).join("node_modules"),
            self.install_root().join("node_modules"),
        ] {
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
