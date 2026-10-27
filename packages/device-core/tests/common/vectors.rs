//! The action vectors (`actions.json`), shared by the engine's unit test (the path the napi addon calls) and
//! `tests/host_stdio.rs` (the in-process function and the real binary over stdio). Each path runs the same
//! list against its own fresh copy of the fixture and must observe the same thing.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const VECTORS: &str = include_str!("actions.json");

/// What running one action came to, however it was run.
#[derive(Debug, PartialEq)]
pub struct Observed {
    pub error: Option<String>,
    pub exit_code: Option<i64>,
    pub output: Option<String>,
    pub status: String,
}

pub struct Vector {
    pub expect: Value,
    pub input: Value,
    pub name: String,
    only: Option<String>,
    pub tool: String,
}

pub fn vectors() -> Vec<Vector> {
    let parsed: Value = serde_json::from_str(VECTORS).unwrap();

    parsed["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|vector| Vector {
            expect: vector["expect"].clone(),
            input: vector["input"].clone(),
            name: vector["name"].as_str().unwrap().to_owned(),
            only: vector["only"].as_str().map(str::to_owned),
            tool: vector["tool"].as_str().unwrap().to_owned(),
        })
        .collect()
}

impl Vector {
    /// Whether this machine runs the vector. `sandboxed` ones need a working shell sandbox; `unsandboxed`
    /// ones are the refusal where there is none. A machine whose sandbox is only partly there (Landlock but no
    /// seccomp filter) runs neither.
    pub fn applies(&self, sandbox: Sandbox) -> bool {
        matches!(
            (self.only.as_deref(), sandbox),
            (None, _)
                | (Some("sandboxed"), Sandbox::Confines)
                | (Some("unsandboxed"), Sandbox::None)
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sandbox {
    /// `shell_run` is confined and nothing gets in the way of the vectors.
    Confines,
    /// There is no sandbox here, so `shell_run` is refused.
    None,
    /// Something in between; the shell vectors are skipped.
    Partial,
}

/// Asks the planner what a `shell_run` would get here, so a runner without Landlock (or without the seccomp
/// filter) skips the sandboxed vectors instead of failing them. With `NEORE_REQUIRE_SANDBOX` non-empty (CI, on the
/// systems that have a sandbox) anything but a confining one panics, so a runner that lost its sandbox cannot
/// pass by skipping.
pub fn sandbox() -> Sandbox {
    use device_core::sandbox::{self, Support};

    let support = sandbox::support();

    let found = match (
        &support,
        sandbox::policy_for_call(&support, false, false, &[], None),
    ) {
        (Support::Unavailable(_), _) => Sandbox::None,
        (Support::Available(_), Ok(_)) => Sandbox::Confines,
        (Support::Available(_), Err(reason)) => {
            eprintln!("the shell vectors are skipped: {reason}");

            Sandbox::Partial
        }
    };

    let required = std::env::var("NEORE_REQUIRE_SANDBOX").is_ok_and(|value| !value.is_empty());

    assert!(
        found == Sandbox::Confines || !required,
        "NEORE_REQUIRE_SANDBOX is set, and this machine's shell sandbox is {found:?}: {support:?}"
    );

    found
}

/// A fresh fixture: `<scratch>/<name>/root` holds the files, and its parent is where an escape would land.
pub fn fixture(name: &str) -> PathBuf {
    let parsed: Value = serde_json::from_str(VECTORS).unwrap();
    let base = std::env::temp_dir().join(format!("neore-vectors-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = base.join("root");

    for (path, content) in parsed["fixture"].as_object().unwrap() {
        let file = root.join(path);

        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, content.as_str().unwrap()).unwrap();
    }

    root.canonicalize().unwrap()
}

/// What must still be true after the vectors ran: nothing escaped the shared folder, and a refused command
/// never started.
pub fn assert_nothing_escaped(root: &Path) {
    let base = root.parent().unwrap();

    assert!(
        !base.join("escaped.txt").exists(),
        "a command wrote outside the shared folder"
    );
    assert!(
        !root.join("refused-marker.txt").exists(),
        "a refused command ran"
    );
}

/// The observation with the shared folder's path replaced, for comparing two runs that used two folders. The
/// path appears as is and, inside `fs_list`'s JSON text, escaped (a Windows `\\?\C:\…` doubles its backslashes);
/// what follows it is written with `/` whatever the platform. A folder's own size is the file system's
/// business (0 on NTFS, 96 on APFS, 4096 on ext4), so a listing reports it as 0.
pub fn normalised(observed: &Observed, root: &Path) -> Observed {
    let plain = root.to_string_lossy().into_owned();
    let escaped = serde_json::to_string(&plain).unwrap();
    let escaped = escaped.trim_matches('"');
    let normalise = |text: &String| {
        text.replace(escaped, "{root}")
            .replace(&plain, "{root}")
            .replace("{root}\\\\", "{root}/")
            .replace("{root}\\", "{root}/")
    };

    Observed {
        error: observed.error.as_ref().map(normalise),
        exit_code: observed.exit_code,
        output: observed
            .output
            .as_ref()
            .map(|text| normalise(&with_folder_sizes_zeroed(text))),
        status: observed.status.clone(),
    }
}

fn with_folder_sizes_zeroed(output: &str) -> String {
    let Ok(mut listing) = serde_json::from_str::<Value>(output) else {
        return output.to_owned();
    };
    let Some(entries) = listing["entries"].as_array_mut() else {
        return output.to_owned();
    };

    for entry in entries {
        if entry["type"] == "dir" {
            entry["size"] = 0.into();
        }
    }

    serde_json::to_string_pretty(&listing).unwrap()
}

/// Checks one observation against the complete expectation. `output` and `error` are exact when the vector
/// names them and must be absent when it does not; `outputContains` / `errorContains` stand in for text that
/// differs by platform.
pub fn assert_observed(vector: &Vector, root: &Path, observed: &Observed) {
    let at = format!("vector \"{}\": {observed:?}", vector.name);
    let expect = &vector.expect;
    let observed = &normalised(observed, root);

    assert_eq!(observed.status, expect["status"].as_str().unwrap(), "{at}");
    assert_eq!(observed.exit_code, expect["exitCode"].as_i64(), "{at}");

    for (key, contains, seen) in [
        ("output", "outputContains", &observed.output),
        ("error", "errorContains", &observed.error),
    ] {
        if expect[contains].is_array() {
            let seen = seen.as_deref().unwrap_or_default();

            for needle in expect[contains].as_array().unwrap() {
                assert!(
                    seen.contains(needle.as_str().unwrap()),
                    "{at}: missing {needle}"
                );
            }
        } else {
            assert_eq!(seen.as_deref(), expect[key].as_str(), "{at}");
        }
    }
}
