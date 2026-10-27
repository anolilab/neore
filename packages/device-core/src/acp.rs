//! Coding agents that speak the Agent Client Protocol: the registry, the environment they start with, and the
//! plan the Electron main process spawns from.
//!
//! Registered, changed and removed only from the local device window (`acp_update`); the page has no command
//! that reaches this module. The main process owns the child process and the protocol (`apps/desktop/src/acp/`),
//! but it spawns only from [`SpawnPlan`], so the command line, the folder and the environment are decided here.
//!
//! Environment variables are secrets. They live in `device.json` (owner-only) next to the allow rules, never
//! reach the backend or the page (the view lists names only), and are not printed: [`EnvVars`] has a `Debug`
//! that shows names, so a stray `{:?}` of the settings or a plan cannot leak a value.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::acp_permission::{Answered, Outcome, PendingView, PermissionRequest};
use crate::engine::{now_ms, validate_roots, DeviceState, Event};
use crate::hmac::to_hex;

const MAX_AGENTS: usize = 20;
const MAX_CONSENTS: usize = 100;
const MAX_ARGS: usize = 50;
const MAX_ARG_BYTES: usize = 1000;
const MAX_ENV_VARS: usize = 50;
const MAX_ENV_NAME: usize = 128;
const MAX_ENV_VALUE_BYTES: usize = 8 * 1024;

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

/// A set of environment variables. The values are secrets: `Debug` lists the names only.
#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct EnvVars(pub BTreeMap<String, String>);

impl fmt::Debug for EnvVars {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.0.keys()).finish()
    }
}

impl EnvVars {
    pub fn names(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgent {
    /// The command's arguments, one per entry.
    #[serde(default)]
    pub args: Vec<String>,
    pub command: String,
    /// Variables for this agent only; they win over the global ones.
    #[serde(default)]
    pub env: EnvVars,
    /// Stable id, `a-z0-9-`: what a session, a consent and (later) an offer name.
    pub key: String,
    pub label: String,
}

/// The user's approval of one agent in one folder, given in the local window and nowhere else.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpConsent {
    pub agent_key: String,
    /// An opaque id for the folder, stable for its canonical path. What an offer names later; no path leaves here.
    pub folder_id: String,
    pub folder_label: String,
    /// Canonical. The agent's folder must be this one to start.
    pub folder_path: String,
}

/// What the main process spawns: nothing else may start an agent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPlan {
    pub args: Vec<String>,
    pub command: String,
    pub cwd: String,
    pub env: EnvVars,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentView {
    pub args: Vec<String>,
    pub command: String,
    /// Names only: values are masked in the window and never leave this crate.
    pub env_names: Vec<String>,
    pub key: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpView {
    pub agents: Vec<AcpAgentView>,
    pub consents: Vec<AcpConsent>,
    pub env_names: Vec<String>,
}

#[derive(Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "op",
    deny_unknown_fields
)]
pub enum AcpUpdate {
    /// Adds an agent or replaces its command, arguments and label. Its variables stay.
    SaveAgent {
        args: Vec<String>,
        command: String,
        key: String,
        label: String,
    },
    RemoveAgent {
        key: String,
    },
    /// Approves an agent for a folder. The window asks the user first.
    Grant {
        agent_key: String,
        folder: String,
    },
    Revoke {
        agent_key: String,
        folder_id: String,
    },
    /// Sets one variable, for one agent or (without `agent_key`) for all.
    SetEnv {
        agent_key: Option<String>,
        name: String,
        value: String,
    },
    RemoveEnv {
        agent_key: Option<String>,
        name: String,
    },
}

fn folder_id(canonical: &str) -> String {
    to_hex(&Sha256::digest(canonical.as_bytes())[..8])
}

fn folder_label(canonical: &str) -> String {
    Path::new(canonical).file_name().map_or_else(
        || canonical.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

fn valid_key(key: &str) -> bool {
    (1..=40).contains(&key.len())
        && key
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
        && !key.starts_with('-')
}

fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

pub fn validate_agent(agent: &AcpAgent) -> Result<(), String> {
    if !valid_key(&agent.key) {
        return Err("an agent key is 1 to 40 characters of a-z, 0-9 and -".into());
    }

    if agent.label.trim().is_empty()
        || agent.label.chars().count() > 60
        || has_control(&agent.label)
    {
        return Err("an agent needs a name of up to 60 characters".into());
    }

    if agent.command.trim().is_empty()
        || agent.command.len() > MAX_ARG_BYTES
        || agent.command.contains('\0')
    {
        return Err("an agent needs a command".into());
    }

    if agent.args.len() > MAX_ARGS
        || agent
            .args
            .iter()
            .any(|arg| arg.len() > MAX_ARG_BYTES || arg.contains('\0'))
    {
        return Err("agent arguments: at most 50, each up to 1000 bytes".into());
    }

    Ok(())
}

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

/// `layer` over `base`. Windows names are case-insensitive, so `Path` replaces `PATH` there.
fn overlay(base: &mut BTreeMap<String, String>, layer: &EnvVars) {
    for (name, value) in &layer.0 {
        if cfg!(windows) {
            base.retain(|existing, _| !existing.eq_ignore_ascii_case(name));
        }

        base.insert(name.clone(), value.clone());
    }
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

/// The full environment of one agent: built, then the global variables, then the agent's own.
/// Every user variable is validated again here, so a hand-edited `device.json` cannot slip a reserved name in.
pub fn agent_env(
    built: BTreeMap<String, String>,
    global: &EnvVars,
    agent: &EnvVars,
) -> Result<EnvVars, String> {
    let mut env = built;

    for layer in [global, agent] {
        for (name, value) in &layer.0 {
            validate_env_var(name, value)?;
        }

        overlay(&mut env, layer);
    }

    Ok(EnvVars(env))
}

fn scope_env<'a>(
    settings: &'a mut crate::store::Settings,
    agent_key: Option<&str>,
) -> Result<&'a mut EnvVars, String> {
    match agent_key {
        None => Ok(&mut settings.acp_env),
        Some(key) => settings
            .acp_agents
            .iter_mut()
            .find(|agent| agent.key == key)
            .map(|agent| &mut agent.env)
            .ok_or_else(|| "that agent is not registered".to_owned()),
    }
}

impl DeviceState {
    pub fn acp_view(&self) -> AcpView {
        let settings = self.settings();

        AcpView {
            agents: settings
                .acp_agents
                .iter()
                .map(|agent| AcpAgentView {
                    args: agent.args.clone(),
                    command: agent.command.clone(),
                    env_names: agent.env.names(),
                    key: agent.key.clone(),
                    label: agent.label.clone(),
                })
                .collect(),
            env_names: settings.acp_env.names(),
            consents: settings.acp_consents,
        }
    }

    pub fn acp_update(&self, update: AcpUpdate) -> Result<AcpView, String> {
        self.change_settings(|settings| {
            match update {
                AcpUpdate::SaveAgent {
                    args,
                    command,
                    key,
                    label,
                } => {
                    let existing = settings
                        .acp_agents
                        .iter()
                        .position(|agent| agent.key == key);
                    let agent = AcpAgent {
                        args,
                        command,
                        env: existing
                            .map_or_else(EnvVars::default, |i| settings.acp_agents[i].env.clone()),
                        key,
                        label: label.trim().to_owned(),
                    };

                    validate_agent(&agent)?;

                    match existing {
                        Some(i) => {
                            // A different program is not the one the user approved for these folders.
                            if settings.acp_agents[i].command != agent.command
                                || settings.acp_agents[i].args != agent.args
                            {
                                settings.acp_consents.retain(|c| c.agent_key != agent.key);
                            }

                            settings.acp_agents[i] = agent;
                        }
                        None if settings.acp_agents.len() >= MAX_AGENTS => {
                            return Err(format!("at most {MAX_AGENTS} agents"));
                        }
                        None => settings.acp_agents.push(agent),
                    }
                }
                AcpUpdate::RemoveAgent { key } => {
                    settings.acp_agents.retain(|agent| agent.key != key);
                    settings.acp_consents.retain(|c| c.agent_key != key);
                }
                AcpUpdate::Grant { agent_key, folder } => {
                    if !settings
                        .acp_agents
                        .iter()
                        .any(|agent| agent.key == agent_key)
                    {
                        return Err("that agent is not registered".into());
                    }

                    let canonical = validate_roots(&[folder])?.pop().ok_or("choose a folder")?;
                    let folder_id = folder_id(&canonical);

                    if settings.acp_consents.len() >= MAX_CONSENTS {
                        return Err(format!("at most {MAX_CONSENTS} approvals"));
                    }

                    if !settings
                        .acp_consents
                        .iter()
                        .any(|c| c.agent_key == agent_key && c.folder_id == folder_id)
                    {
                        settings.acp_consents.push(AcpConsent {
                            agent_key,
                            folder_id,
                            folder_label: folder_label(&canonical),
                            folder_path: canonical,
                        });
                    }
                }
                AcpUpdate::Revoke {
                    agent_key,
                    folder_id,
                } => {
                    settings
                        .acp_consents
                        .retain(|c| !(c.agent_key == agent_key && c.folder_id == folder_id));
                }
                AcpUpdate::SetEnv {
                    agent_key,
                    name,
                    value,
                } => {
                    validate_env_var(&name, &value)?;

                    let scope = scope_env(settings, agent_key.as_deref())?;

                    if !scope.0.contains_key(&name) && scope.0.len() >= MAX_ENV_VARS {
                        return Err(format!("at most {MAX_ENV_VARS} variables"));
                    }

                    scope.0.insert(name, value);
                }
                AcpUpdate::RemoveEnv { agent_key, name } => {
                    scope_env(settings, agent_key.as_deref())?.0.remove(&name);
                }
            }

            Ok(())
        })?;

        Ok(self.acp_view())
    }

    /// What to spawn for `agent_key`. `folder` is the session's working folder; `None` is a version probe, which
    /// runs in an empty scratch folder and opens no session.
    pub fn acp_spawn_plan(
        &self,
        agent_key: &str,
        folder: Option<&str>,
    ) -> Result<SpawnPlan, String> {
        let settings = self.settings();
        let agent = settings
            .acp_agents
            .iter()
            .find(|agent| agent.key == agent_key)
            .ok_or("that agent is not registered")?;
        let cwd: PathBuf = match folder {
            Some(folder) => {
                let canonical = validate_roots(&[folder.to_owned()])?
                    .pop()
                    .ok_or("choose a folder")?;

                // Checked before anything starts: a valid request for a pair the user did not approve is refused.
                if !settings
                    .acp_consents
                    .iter()
                    .any(|c| c.agent_key == agent_key && c.folder_path == canonical)
                {
                    return Err(format!(
                        "{} is not approved for that folder. Approve it in this window first",
                        agent.label
                    ));
                }

                PathBuf::from(canonical)
            }
            None => {
                let scratch = self.data_dir().join("acp-probe");

                fs::create_dir_all(&scratch).map_err(|error| error.to_string())?;
                scratch
            }
        };
        let env = agent_env(built_env(std::env::vars()), &settings.acp_env, &agent.env)?;

        self.audit(json!({
            "at": now_ms(), "decision": "approved", "detail": format!("{} in {}", agent.label, cwd.display()),
            "status": if folder.is_some() { "started" } else { "probed" }, "tool": "acp_start",
        }));

        Ok(SpawnPlan {
            args: agent.args.clone(),
            command: agent.command.clone(),
            cwd: cwd.to_string_lossy().into_owned(),
            env,
        })
    }
}

impl DeviceState {
    /// Registers a request from a coding agent and blocks until it is answered, cancelled or times out.
    /// Run it on a worker thread. The outcome is exactly what the agent receives.
    pub fn acp_permission_ask(&self, request: PermissionRequest) -> Outcome {
        let (agent, tool) = (request.agent_label.clone(), request.tool.clone());

        self.acp_permissions
            .ask(request, |_| self.emit(Event::AcpPermission { agent, tool }))
    }

    pub fn acp_permissions(&self) -> Vec<PendingView> {
        self.acp_permissions.view()
    }

    /// Answers one request with the agent's own option id. Only "allow once" and "reject once" are accepted.
    pub fn acp_permission_answer(&self, id: u64, option_id: &str) -> Result<(), String> {
        let answer = self.acp_permissions.answer(id, option_id)?;

        self.audit_acp_answers(&[answer], false);

        Ok(())
    }

    pub fn acp_permission_decline(&self, id: u64) -> Result<(), String> {
        let answer = self.acp_permissions.decline(id)?;

        self.audit_acp_answers(&[answer], false);

        Ok(())
    }

    /// Allows exactly the requests named, each once. Returns how many it answered.
    pub fn acp_permission_answer_batch(&self, ids: &[u64]) -> Result<usize, String> {
        let answers = self.acp_permissions.answer_batch(ids)?;

        self.audit_acp_answers(&answers, true);

        Ok(answers.len())
    }

    /// The host sent `session/cancel` or the agent ended: its waiting requests are answered cancelled.
    pub fn acp_permission_cancel_session(&self, session_id: &str) {
        self.acp_permissions.cancel_session(session_id);
    }

    pub(crate) fn acp_decline_all(&self) {
        let answers = self.acp_permissions.decline_all();

        self.audit_acp_answers(&answers, false);
    }

    /// One line per answered request. The tool and its target only: the command may carry a secret.
    fn audit_acp_answers(&self, answers: &[Answered], batch: bool) {
        for answer in answers {
            self.audit(json!({
                "at": now_ms(), "decision": answer.decision, "detail": answer.target.clone().unwrap_or_default(),
                "status": if batch { "approved with others" } else { "answered" }, "thread": answer.agent_label,
                "tool": format!("acp: {}", answer.tool),
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Settings;

    fn state(name: &str) -> (DeviceState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("neore-acp-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        (DeviceState::new(&dir, Box::new(|_| {})), dir)
    }

    fn update(json: &str) -> AcpUpdate {
        serde_json::from_str(json).unwrap()
    }

    fn save(state: &DeviceState, key: &str) {
        state
            .acp_update(update(&format!(
                r#"{{"op":"saveAgent","key":"{key}","label":"Agent {key}","command":"/bin/{key}","args":["--acp"]}}"#
            )))
            .unwrap();
    }

    fn grant(state: &DeviceState, agent: &str, folder: &Path) -> AcpView {
        state
            .acp_update(AcpUpdate::Grant {
                agent_key: agent.into(),
                folder: folder.to_string_lossy().into_owned(),
            })
            .unwrap()
    }

    fn set_env(
        state: &DeviceState,
        agent: Option<&str>,
        name: &str,
        value: &str,
    ) -> Result<AcpView, String> {
        state.acp_update(AcpUpdate::SetEnv {
            agent_key: agent.map(str::to_owned),
            name: name.into(),
            value: value.into(),
        })
    }

    fn vars(pairs: &[(&str, &str)]) -> impl Iterator<Item = (String, String)> {
        pairs
            .iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn the_built_environment_is_a_list_not_a_copy() {
        let env = built_env(vars(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/home/me"),
            ("LC_ALL", "C"),
            ("path", "C:\\Windows"),
            ("NEORE_TOKEN", "nt"),
            ("ELECTRON_RUN_AS_NODE", "1"),
            ("NODE_OPTIONS", "--require x"),
            ("AWS_SECRET_ACCESS_KEY", "aws"),
        ]));

        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert!(env.contains_key("HOME") && env.contains_key("LC_ALL") && env.contains_key("path"));
        for dropped in [
            "NEORE_TOKEN",
            "ELECTRON_RUN_AS_NODE",
            "NODE_OPTIONS",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(
                !env.contains_key(dropped),
                "{dropped} leaked into the agent"
            );
        }
    }

    #[test]
    fn reserved_names_are_refused_in_any_case() {
        for name in [
            "NEORE_X",
            "neore_x",
            "Electron_Run_As_Node",
            "NODE_OPTIONS",
            "node_options",
        ] {
            assert!(validate_env_var(name, "v").is_err(), "{name}");
        }
        for name in ["", "1A", "A=B", "A B", "A\0"] {
            assert!(validate_env_var(name, "v").is_err(), "{name:?}");
        }
        assert!(validate_env_var("HTTPS_PROXY", "http://proxy:3128").is_ok());
        assert!(validate_env_var("NODE_EXTRA_CA_CERTS", "/ca.pem").is_ok());
        assert!(validate_env_var("K", "a\0b").is_err());
        assert!(validate_env_var("K", &"x".repeat(MAX_ENV_VALUE_BYTES + 1)).is_err());
    }

    #[test]
    fn a_refused_variable_is_not_stored_and_its_error_has_no_value() {
        let (state, dir) = state("refuse");

        save(&state, "alpha");
        let error =
            set_env(&state, Some("alpha"), "NEORE_TOKEN", "super-secret-value").unwrap_err();

        assert!(!error.contains("super-secret-value"));
        let error = set_env(&state, None, "OK_NAME", "bad\0super-secret-value").unwrap_err();
        assert!(!error.contains("super-secret-value"));
        assert!(state.acp_view().env_names.is_empty());
        assert!(state.acp_view().agents[0].env_names.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_variable_reaches_its_agent_and_no_other() {
        let (state, dir) = state("scope");

        save(&state, "alpha");
        save(&state, "beta");
        set_env(&state, Some("alpha"), "ONLY_ALPHA", "a1").unwrap();
        set_env(&state, None, "FOR_ALL", "g1").unwrap();
        set_env(&state, Some("beta"), "FOR_ALL", "b-wins").unwrap();

        let alpha = state.acp_spawn_plan("alpha", None).unwrap().env.0;
        let beta = state.acp_spawn_plan("beta", None).unwrap().env.0;

        assert_eq!(alpha.get("ONLY_ALPHA").map(String::as_str), Some("a1"));
        assert_eq!(alpha.get("FOR_ALL").map(String::as_str), Some("g1"));
        assert!(!beta.contains_key("ONLY_ALPHA"));
        assert_eq!(beta.get("FOR_ALL").map(String::as_str), Some("b-wins"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn values_never_reach_the_view_or_a_debug_print() {
        let (state, dir) = state("mask");

        save(&state, "alpha");
        set_env(&state, Some("alpha"), "API_KEY", "sentinel-value-1").unwrap();
        set_env(&state, None, "HTTPS_PROXY", "sentinel-value-2").unwrap();

        let view = serde_json::to_string(&state.acp_view()).unwrap();

        assert!(view.contains("API_KEY") && view.contains("HTTPS_PROXY"));
        assert!(!view.contains("sentinel-value"));
        assert!(!format!("{:?}", state.settings()).contains("sentinel-value"));
        assert!(
            !format!("{:?}", state.acp_spawn_plan("alpha", None).unwrap())
                .contains("sentinel-value")
        );

        // The values are stored (owner-only, in device.json) so the next start still has them.
        let stored = crate::store::load(&dir.join("device.json"));
        assert_eq!(
            stored.acp_agents[0]
                .env
                .0
                .get("API_KEY")
                .map(String::as_str),
            Some("sentinel-value-1")
        );

        let audit = fs::read_to_string(dir.join("device-audit.jsonl")).unwrap_or_default();
        assert!(!audit.contains("sentinel-value"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_hand_edited_reserved_name_is_caught_at_spawn() {
        let mut stored = Settings::default();

        stored
            .acp_env
            .0
            .insert("ELECTRON_RUN_AS_NODE".into(), "1".into());

        assert!(agent_env(BTreeMap::new(), &stored.acp_env, &EnvVars::default()).is_err());
    }

    #[test]
    fn a_probe_runs_in_a_scratch_folder_and_a_session_in_a_real_one() {
        let (state, dir) = state("plan");
        let work = dir.join("work");

        fs::create_dir_all(&work).unwrap();
        save(&state, "alpha");
        grant(&state, "alpha", &work);

        let probe = state.acp_spawn_plan("alpha", None).unwrap();
        assert!(probe.cwd.ends_with("acp-probe"));

        let session = state
            .acp_spawn_plan("alpha", Some(work.to_str().unwrap()))
            .unwrap();
        assert_eq!(
            PathBuf::from(&session.cwd),
            fs::canonicalize(&work).unwrap()
        );
        assert_eq!(session.command, "/bin/alpha");
        assert_eq!(session.args, vec!["--acp".to_owned()]);

        assert!(state
            .acp_spawn_plan("alpha", Some("/nonexistent/neore"))
            .is_err());
        assert!(state.acp_spawn_plan("nobody", None).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn agents_are_validated_and_removal_takes_the_variables_along() {
        let (state, dir) = state("agents");

        assert!(state
            .acp_update(update(
                r#"{"op":"saveAgent","key":"Bad Key","label":"x","command":"c","args":[]}"#
            ))
            .is_err());
        assert!(state
            .acp_update(update(
                r#"{"op":"saveAgent","key":"ok","label":"x","command":"  ","args":[]}"#
            ))
            .is_err());

        save(&state, "alpha");
        set_env(&state, Some("alpha"), "K", "v").unwrap();
        save(&state, "alpha");
        assert_eq!(
            state.acp_view().agents[0].env_names,
            vec!["K".to_owned()],
            "re-saving keeps the variables"
        );

        state
            .acp_update(update(r#"{"op":"removeAgent","key":"alpha"}"#))
            .unwrap();
        assert!(state.acp_view().agents.is_empty());
        assert!(set_env(&state, Some("alpha"), "K", "v").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unapproved_pair_is_refused_before_anything_is_planned() {
        let (state, dir) = state("consent");
        let (one, two) = (dir.join("one"), dir.join("two"));

        fs::create_dir_all(&one).unwrap();
        fs::create_dir_all(&two).unwrap();
        save(&state, "alpha");
        save(&state, "beta");

        let ask = |agent: &str, folder: &Path| {
            state.acp_spawn_plan(agent, Some(folder.to_str().unwrap()))
        };

        assert!(ask("alpha", &one).unwrap_err().contains("not approved"));

        grant(&state, "alpha", &one);

        assert!(ask("alpha", &one).is_ok());
        // Another folder, and another agent in the approved folder, are different pairs.
        assert!(ask("alpha", &two).is_err());
        assert!(ask("beta", &one).is_err());
        // A path that does not exist is refused too.
        assert!(ask("alpha", &dir.join("missing")).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_approval_is_stored_and_shows_no_path_in_its_id() {
        let (state, dir) = state("persist");
        let work = dir.join("project");

        fs::create_dir_all(&work).unwrap();
        save(&state, "alpha");

        let view = grant(&state, "alpha", &work);
        let consent = view.consents[0].clone();

        assert_eq!(consent.folder_label, "project");
        assert_eq!(consent.folder_id.len(), 16);
        assert!(!consent.folder_id.contains("project"));
        // Granting twice is one approval.
        assert_eq!(grant(&state, "alpha", &work).consents.len(), 1);

        let restarted = DeviceState::new(&dir, Box::new(|_| {}));

        assert!(restarted
            .acp_spawn_plan("alpha", Some(work.to_str().unwrap()))
            .is_ok());

        restarted
            .acp_update(AcpUpdate::Revoke {
                agent_key: "alpha".into(),
                folder_id: consent.folder_id,
            })
            .unwrap();
        assert!(restarted
            .acp_spawn_plan("alpha", Some(work.to_str().unwrap()))
            .is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_changed_program_or_a_removed_agent_loses_its_approvals() {
        let (state, dir) = state("drop");
        let work = dir.join("work");

        fs::create_dir_all(&work).unwrap();
        save(&state, "alpha");
        grant(&state, "alpha", &work);

        // The same program under a new name keeps them.
        state
            .acp_update(update(r#"{"op":"saveAgent","key":"alpha","label":"Renamed","command":"/bin/alpha","args":["--acp"]}"#))
            .unwrap();
        assert_eq!(state.acp_view().consents.len(), 1);

        for changed in [
            r#"{"op":"saveAgent","key":"alpha","label":"A","command":"/bin/other","args":["--acp"]}"#,
            r#"{"op":"saveAgent","key":"alpha","label":"A","command":"/bin/alpha","args":[]}"#,
        ] {
            state.acp_update(update(changed)).unwrap();
            assert!(state.acp_view().consents.is_empty(), "{changed}");
            grant(&state, "alpha", &work);
        }

        state
            .acp_update(update(r#"{"op":"removeAgent","key":"alpha"}"#))
            .unwrap();
        assert!(state.acp_view().consents.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn approvals_need_a_registered_agent_and_a_folder_that_may_be_shared() {
        let (state, dir) = state("grant");

        let unregistered = state.acp_update(AcpUpdate::Grant {
            agent_key: "nobody".into(),
            folder: dir.to_string_lossy().into_owned(),
        });

        assert!(unregistered.is_err());

        save(&state, "alpha");

        for folder in ["/", "/nonexistent/neore"] {
            assert!(
                state
                    .acp_update(AcpUpdate::Grant {
                        agent_key: "alpha".into(),
                        folder: folder.into(),
                    })
                    .is_err(),
                "{folder}"
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_decline_reaches_the_agent_and_the_audit_log_has_no_command() {
        use crate::acp_permission::{OfferedOption, PermissionRequest};

        let (state, dir) = state("audit");
        let state = std::sync::Arc::new(state);
        let request = PermissionRequest {
            agent_label: "Agent".into(),
            command: Some("curl --data sentinel-token x".into()),
            details: "{}".into(),
            details_complete: true,
            folder: "/work".into(),
            options: vec![
                OfferedOption {
                    kind: "allow_once".into(),
                    name: "Yes".into(),
                    option_id: "y".into(),
                },
                OfferedOption {
                    kind: "allow_always".into(),
                    name: "Always".into(),
                    option_id: "a".into(),
                },
                OfferedOption {
                    kind: "reject_once".into(),
                    name: "No".into(),
                    option_id: "n".into(),
                },
            ],
            session_id: "s1".into(),
            target: Some("/work/x".into()),
            tool: "Run curl".into(),
            tool_kind: "execute".into(),
        };
        let asking = state.clone();
        let waiting = std::thread::spawn(move || asking.acp_permission_ask(request));

        let id = loop {
            if let Some(pending) = state.acp_permissions().first() {
                break pending.id;
            }

            std::thread::sleep(std::time::Duration::from_millis(5));
        };

        assert!(state.acp_permission_answer(id, "a").is_err());
        state.acp_permission_decline(id).unwrap();
        assert_eq!(
            waiting.join().unwrap(),
            Outcome::Selected {
                option_id: "n".into()
            }
        );

        let audit = fs::read_to_string(dir.join("device-audit.jsonl")).unwrap();

        assert!(audit.contains("acp: Run curl") && audit.contains("deny"));
        assert!(!audit.contains("sentinel-token"));

        let _ = fs::remove_dir_all(&dir);
    }
}
