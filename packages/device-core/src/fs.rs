//! Local files, confined to the folders the user allowed.
//!
//! Every path is resolved against the CANONICAL roots: symlinks are followed
//! before the check, so neither `..` nor a symlink inside a root can reach
//! outside it. A path that does not exist yet (a write) is checked through its
//! canonical parent plus a plain file name.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

/// Largest file `fs_read` opens and `fs_write` writes.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Directory entries `fs_list` returns.
pub const MAX_LIST_ENTRIES: usize = 1000;

/// The roots that still exist, canonicalised. Missing folders are skipped.
pub fn canonical_roots(roots: &[String]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .filter(|root| root.is_dir())
        .collect()
}

fn within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// A path from the model: absolute, or relative to the first root.
fn candidate(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let raw = raw.trim();
    let root = roots
        .first()
        .ok_or("no folders are shared with the agent")?;

    if raw.is_empty() || raw == "." {
        return Ok(root.clone());
    }

    if raw.contains('\0') {
        return Err("invalid path".into());
    }

    let path = Path::new(raw);

    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
}

/// An EXISTING path inside a root.
pub fn resolve_existing(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let resolved =
        fs::canonicalize(candidate(raw, roots)?).map_err(|_| format!("{raw}: not found"))?;

    if !within_roots(&resolved, roots) {
        return Err(format!("{raw}: outside the shared folders"));
    }

    Ok(resolved)
}

/// A path to WRITE: its parent must exist inside a root, its name must be a
/// plain file name, and if it already exists it must itself resolve inside.
pub fn resolve_for_write(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let path = candidate(raw, roots)?;
    let name = match path.components().next_back() {
        Some(Component::Normal(name)) => name.to_owned(),
        _ => return Err(format!("{raw}: not a file name")),
    };
    let parent = path
        .parent()
        .ok_or_else(|| format!("{raw}: no parent folder"))?;
    let parent =
        fs::canonicalize(parent).map_err(|_| format!("{raw}: the folder does not exist"))?;

    if !within_roots(&parent, roots) {
        return Err(format!("{raw}: outside the shared folders"));
    }

    let target = parent.join(name);

    if fs::symlink_metadata(&target).is_ok() {
        let real = fs::canonicalize(&target).map_err(|_| format!("{raw}: cannot resolve"))?;

        if !within_roots(&real, roots) {
            return Err(format!("{raw}: outside the shared folders"));
        }

        if real.is_dir() {
            return Err(format!("{raw}: is a folder"));
        }
    }

    Ok(target)
}

pub fn list(path: &Path) -> Result<Value, String> {
    let entries = fs::read_dir(path).map_err(|error| error.to_string())?;
    let mut listed = Vec::new();
    let mut truncated = false;

    for entry in entries.flatten() {
        if listed.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }

        let kind = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => "symlink",
            Ok(kind) if kind.is_dir() => "dir",
            Ok(_) => "file",
            Err(_) => "unknown",
        };
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);

        listed.push(
            json!({ "name": entry.file_name().to_string_lossy(), "type": kind, "size": size }),
        );
    }

    listed.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    Ok(json!({ "path": path.to_string_lossy(), "entries": listed, "truncated": truncated }))
}

/// Up to [`MAX_FILE_BYTES`] of a file as text. Binary files are described, not dumped.
pub fn read(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|error| error.to_string())?;

    if meta.is_dir() {
        return Err("is a folder; use fs_list".into());
    }

    let mut bytes = Vec::new();

    fs::File::open(path)
        .and_then(|file| file.take(MAX_FILE_BYTES).read_to_end(&mut bytes))
        .map_err(|error| error.to_string())?;

    if bytes.contains(&0) {
        return Ok(format!("[binary file, {} bytes]", meta.len()));
    }

    let mut text = String::from_utf8_lossy(&bytes).into_owned();

    if meta.len() > MAX_FILE_BYTES {
        text.push_str(&format!(
            "\n[… file is {} bytes; only the first {MAX_FILE_BYTES} were read]",
            meta.len()
        ));
    }

    Ok(text)
}

pub fn write(path: &Path, content: &str, overwrite: bool) -> Result<String, String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("content is larger than 1 MiB".into());
    }

    if path.exists() && !overwrite {
        return Err("the file exists; pass overwrite: true to replace it".into());
    }

    fs::write(path, content).map_err(|error| error.to_string())?;

    Ok(format!(
        "wrote {} bytes to {}",
        content.len(),
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("neore-device-fs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("root/sub")).unwrap();
        fs::write(dir.join("root/a.txt"), "hello").unwrap();
        fs::write(dir.join("secret.txt"), "nope").unwrap();
        dir
    }

    #[test]
    fn resolves_inside_and_refuses_dot_dot() {
        let dir = scratch("dotdot");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);

        assert!(resolve_existing("a.txt", &roots).is_ok());
        assert!(resolve_existing("sub/../a.txt", &roots).is_ok());
        assert!(resolve_existing("../secret.txt", &roots).is_err());
        assert!(resolve_existing(&dir.join("secret.txt").to_string_lossy(), &roots).is_err());
        assert!(resolve_for_write("../evil.txt", &roots).is_err());
        assert!(resolve_for_write("sub/new.txt", &roots).is_ok());
        assert!(resolve_for_write("missing/new.txt", &roots).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_escapes_a_root() {
        let dir = scratch("symlink");
        std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("root/link.txt")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("root/up")).unwrap();
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);

        assert!(resolve_existing("link.txt", &roots).is_err());
        assert!(resolve_existing("up/secret.txt", &roots).is_err());
        assert!(resolve_for_write("link.txt", &roots).is_err());
        assert!(resolve_for_write("up/new.txt", &roots).is_err());
    }

    #[test]
    fn nothing_resolves_without_roots() {
        assert!(resolve_existing("a.txt", &[]).is_err());
    }

    #[test]
    fn write_refuses_to_clobber_unless_asked() {
        let dir = scratch("write");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);
        let target = resolve_for_write("a.txt", &roots).unwrap();

        assert!(write(&target, "x", false).is_err());
        assert!(write(&target, "x", true).is_ok());
        assert_eq!(read(&target).unwrap(), "x");
    }
}
