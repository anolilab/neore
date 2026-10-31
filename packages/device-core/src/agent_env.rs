//! The environment a coding agent starts with, shared by the desktop (which plans a start) and `neore-host` (which
//! builds the agent's environment on the server from its own). It is a list, not a copy: only what [`BUILT_ENV_NAMES`]
//! names passes from the process's own environment, and a user variable that Neore keeps for itself is refused.

use std::collections::BTreeMap;
use std::ffi::OsString;

pub const MAX_ENV_NAME: usize = 128;
pub const MAX_ENV_VALUE_BYTES: usize = 8 * 1024;

/// Variables copied from the app's own environment into an agent's. Everything else is dropped, so no Neore
/// or Electron variable, token or `NODE_OPTIONS` reaches the agent. Matched case-insensitively (Windows).
const BUILT_ENV_NAMES: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TERM",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    // Windows
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "USERNAME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "TEMP",
    "TMP",
];
/// Locale variables are many (`LC_ALL`, `LC_CTYPE`, …); all of them pass.
const BUILT_ENV_PREFIXES: &[&str] = &["LC_"];

/// Names Neore keeps for itself. A user variable with one of these is refused, so the agent can never be handed
/// a Neore or Electron setting, or a Node option that loads code, through this list.
const RESERVED_PREFIXES: &[&str] = &["NEORE_", "ELECTRON_"];
const RESERVED_NAMES: &[&str] = &["NODE_OPTIONS"];

/// Whether `name` is one Neore keeps for itself (case-insensitive: Windows names are).
pub fn is_reserved_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();

    RESERVED_NAMES.contains(&upper.as_str())
        || RESERVED_PREFIXES
            .iter()
            .any(|prefix| upper.starts_with(prefix))
}

/// The error never repeats a value.
pub fn validate_env_var(name: &str, value: &str) -> Result<(), String> {
    let name_ok = (1..=MAX_ENV_NAME).contains(&name.len())
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()));

    if !name_ok {
        return Err(
            "a variable name is letters, digits and _, and does not start with a digit".into(),
        );
    }

    if is_reserved_env_name(name) {
        return Err(format!("{name} is reserved by Neore"));
    }

    if value.len() > MAX_ENV_VALUE_BYTES || value.contains('\0') {
        return Err(format!("{name}: the value is too long or contains a NUL"));
    }

    Ok(())
}

/// The variables an agent starts with before the user's: only what [`BUILT_ENV_NAMES`] lists, from `vars`
/// (the app's own environment). Not inherited.
pub fn built_env(vars: impl Iterator<Item = (String, String)>) -> BTreeMap<String, String> {
    vars.filter(|(name, value)| {
        let upper = name.to_ascii_uppercase();

        (BUILT_ENV_NAMES.contains(&upper.as_str())
            || BUILT_ENV_PREFIXES
                .iter()
                .any(|prefix| upper.starts_with(prefix)))
            && !value.contains('\0')
    })
    .collect()
}

/// The app's own environment as text. A variable whose name or value is not UTF-8 is skipped: `env::vars`
/// panics on one, and a panic here would take the Electron main process down with it.
pub fn app_vars(
    vars: impl Iterator<Item = (OsString, OsString)>,
) -> impl Iterator<Item = (String, String)> {
    vars.filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
}
