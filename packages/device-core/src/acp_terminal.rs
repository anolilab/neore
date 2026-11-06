//! A coding agent's terminals (ACP `terminal/create`), run on this computer in the `shell_run` sandbox.
//!
//! The main process asks the person first (a once-only permission request through `acp_permission.rs`, never batched)
//! and then starts the command here. Rust decides the rest, whoever asks: the agent must be approved for the folder,
//! the working folder must be inside it, the command runs in the OS sandbox with the shared folders as the only
//! writable place and the network tier `shell_run` has, and nothing runs where there is no sandbox (the "Require
//! sandbox" setting is not consulted: a terminal is never unsandboxed). The terminal is the caller's to read, kill and
//! release (`shell::Terminal`).

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::json;

use crate::actions::{shareable_roots, SHELL_MAX_TIMEOUT};
use crate::agent_env::validate_env_var;
use crate::engine::{now_ms, validate_roots, DeviceState};
use crate::sandbox;
use crate::shell::Terminal;

/// The most output a terminal keeps (its tail), whatever the agent asked for.
pub const MAX_TERMINAL_OUTPUT_BYTES: usize = 64 * 1024;
/// The longest command line a terminal takes, as `shell_run` does.
const MAX_LINE_BYTES: usize = 8000;
/// The most variables an agent may set for one terminal.
const MAX_ENV: usize = 64;

/// What the main process asks for, after the person allowed it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRequest {
    pub agent_key: String,
    /// The working folder the agent asked for; the session's folder when absent.
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// The session's folder: the one the agent was approved for.
    pub folder: String,
    /// The command line exactly as the person was shown it.
    pub line: String,
    #[serde(default)]
    pub output_byte_limit: Option<u64>,
}

impl DeviceState {
    /// Whether a terminal could start in `folder` here: the folder is shared with this computer's tools, and the sandbox
    /// can run a command there with the settings' network tier. It is what `acp_terminal_start` checks before it spawns,
    /// without the agent's approval (a session opens only for an approved agent, and a start checks that again). The
    /// desktop offers an agent the `terminal` capability only when this is true.
    pub fn acp_terminal_available(&self, folder: &str) -> bool {
        let settings = self.settings();
        let Ok(folders) = validate_roots(&[folder.to_owned()]) else {
            return false;
        };
        let Some(folder) = folders.into_iter().next().map(PathBuf::from) else {
            return false;
        };

        if !shareable_roots(&settings.roots)
            .iter()
            .any(|root| folder.starts_with(root))
        {
            return false;
        }

        sandbox::policy_for_call(
            &sandbox::support(),
            false,
            settings.shell_network_tier(),
            std::slice::from_ref(&folder),
            sandbox::home().as_deref(),
        )
        .is_ok_and(|policy| policy.is_some())
    }

    /// Plans and starts one terminal. Refused, with nothing started, for an agent not approved for the folder, a working
    /// folder outside it, a variable the agent may not set, or a computer with no sandbox.
    pub fn acp_terminal_start(&self, request: &TerminalRequest) -> Result<Terminal, String> {
        let settings = self.settings();
        let folder = validate_roots(std::slice::from_ref(&request.folder))?
            .pop()
            .ok_or("choose a folder")?;

        if !settings
            .acp_consents
            .iter()
            .any(|consent| consent.agent_key == request.agent_key && consent.folder_path == folder)
        {
            return Err("that agent is not approved for this folder".into());
        }

        let folder = PathBuf::from(folder);
        let cwd = match request.cwd.as_deref() {
            None | Some("") => folder.clone(),
            Some(cwd) => std::fs::canonicalize(cwd)
                .map_err(|_| "the working folder does not exist".to_owned())?,
        };

        if !cwd.starts_with(&folder) || !cwd.is_dir() {
            return Err("the working folder must be inside the agent's folder".into());
        }

        let line = request.line.trim();

        if line.is_empty() || line.len() > MAX_LINE_BYTES {
            return Err("the command is empty or too long".into());
        }

        if request.env.len() > MAX_ENV {
            return Err("too many variables".into());
        }

        for (name, value) in &request.env {
            validate_env_var(name, value)?;
        }

        let roots = shareable_roots(&settings.roots);

        // The command's folder must be one it can write in: a folder the person shares with this computer's tools.
        if !roots.iter().any(|root| cwd.starts_with(root)) {
            return Err(
                "the agent's folder is not one of the shared folders, so a terminal cannot run there"
                    .into(),
            );
        }

        let support = sandbox::support();
        // The terminal may write only in the folder the person approved for this agent, not in every shared folder: a sibling
        // under the same shared root is not the agent's. The shared roots above decided only whether the folder is eligible.
        let agent_roots = vec![folder.clone()];
        // `allow_unsandboxed` is false whatever the setting says: where there is no sandbox this refuses.
        let policy = sandbox::policy_for_call(
            &support,
            false,
            settings.shell_network_tier(),
            &agent_roots,
            sandbox::home().as_deref(),
        )?
        .ok_or("a terminal runs only in the sandbox, and there is none here")?;
        let cap = request
            .output_byte_limit
            .map_or(MAX_TERMINAL_OUTPUT_BYTES, |limit| {
                usize::try_from(limit).unwrap_or(usize::MAX)
            })
            .clamp(1, MAX_TERMINAL_OUTPUT_BYTES);
        let terminal = Terminal::start(line, &cwd, &policy, &request.env, cap, SHELL_MAX_TIMEOUT)?;

        self.audit(json!({
            "at": now_ms(), "decision": "once", "detail": format!("{line}\n(in {})", cwd.display()),
            "status": "started", "tool": "acp_terminal",
        }));

        Ok(terminal)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::time::Duration;

    use super::*;
    use crate::acp::AcpUpdate;
    use crate::engine::SettingsUpdate;

    /// A device with one registered agent, a shared folder holding the agent's approved folder, and a folder next to it.
    /// Removes a test's folder tree when the test ends, whether it passed or not.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn setup(name: &str) -> (DeviceState, PathBuf, PathBuf, PathBuf, Scratch) {
        let dir =
            std::env::temp_dir().join(format!("neore-acp-term-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let shared = dir.join("shared");
        let project = shared.join("project");
        let other = dir.join("other");

        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&other).unwrap();

        let shared = fs::canonicalize(shared).unwrap();
        let project = fs::canonicalize(project).unwrap();
        let other = fs::canonicalize(other).unwrap();
        let state = DeviceState::new(&dir.join("data"), Box::new(|_| {}));

        state
            .acp_update(
                serde_json::from_str(
                    r#"{"op":"saveAgent","key":"agent","label":"Agent","command":"/bin/agent","args":[]}"#,
                )
                .unwrap(),
            )
            .unwrap();

        for folder in [&project, &other] {
            state
                .acp_update(AcpUpdate::Grant {
                    agent_key: "agent".into(),
                    folder: folder.to_string_lossy().into_owned(),
                })
                .unwrap();
        }

        let roots: SettingsUpdate =
            serde_json::from_value(json!({ "roots": [shared.to_string_lossy()] })).unwrap();

        state.settings_update(roots).unwrap();

        (state, project, other, shared, Scratch(dir))
    }

    fn request(folder: &Path, line: &str) -> TerminalRequest {
        TerminalRequest {
            agent_key: "agent".into(),
            cwd: None,
            env: Vec::new(),
            folder: folder.to_string_lossy().into_owned(),
            line: line.into(),
            output_byte_limit: None,
        }
    }

    fn refusal(state: &DeviceState, request: &TerminalRequest) -> String {
        match state.acp_terminal_start(request) {
            Ok(_) => panic!("the terminal started"),
            Err(error) => error,
        }
    }

    #[test]
    fn refuses_an_agent_not_approved_for_the_folder_and_a_working_folder_outside_it() {
        let (state, project, other, shared, _scratch) = setup("refusals");
        let stranger = TerminalRequest {
            agent_key: "someone-else".into(),
            ..request(&project, "echo hi")
        };

        assert!(refusal(&state, &stranger).contains("not approved"));

        let outside = TerminalRequest {
            cwd: Some(shared.to_string_lossy().into_owned()),
            ..request(&project, "echo hi")
        };

        assert!(refusal(&state, &outside).contains("inside the agent's folder"));

        // Approved, but not one of the shared folders: the sandbox would not let it write there.
        assert!(refusal(&state, &request(&other, "echo hi")).contains("shared folders"));
    }

    #[test]
    fn refuses_a_variable_the_agent_may_not_set_and_an_empty_command() {
        let (state, project, _, _, _scratch) = setup("variables");
        let reserved = TerminalRequest {
            env: vec![("NEORE_DEVICE_SECRET".into(), "x".into())],
            ..request(&project, "echo hi")
        };

        assert!(state.acp_terminal_start(&reserved).is_err());
        assert!(state.acp_terminal_start(&request(&project, "   ")).is_err());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn cannot_write_in_a_sibling_under_the_same_shared_folder() {
        if !matches!(sandbox::support(), sandbox::Support::Available(_)) {
            eprintln!("skipping: no sandbox here");
            return;
        }

        let (state, project, _, shared, _scratch) = setup("sibling");
        // A folder the person shares, next to the agent's approved one, and not approved for the agent.
        let sibling = shared.join("sibling");

        fs::create_dir_all(&sibling).unwrap();
        let sibling = fs::canonicalize(sibling).unwrap();
        let line = format!("echo leaked > '{}/leak.txt'", sibling.display());
        let terminal = state
            .acp_terminal_start(&request(&project, &line))
            .unwrap_or_else(|error| panic!("the terminal did not start: {error}"));
        let exit = terminal.wait(Duration::from_secs(20)).expect("ended");

        assert_ne!(exit.exit_code, Some(0), "{}", terminal.output().output);
        assert!(!sibling.join("leak.txt").exists());
    }

    #[test]
    fn offers_a_terminal_exactly_where_a_start_could_succeed() {
        let (state, project, _, _, _scratch) = setup("offers");
        let available = state.acp_terminal_available(project.to_str().unwrap());
        let started = state.acp_terminal_start(&request(&project, "true"));

        assert_eq!(available, started.is_ok(), "{:?}", started.err());
    }

    #[test]
    fn offers_no_terminal_for_a_folder_no_one_shares() {
        let (state, _, other, _, _scratch) = setup("unshared");

        assert!(!state.acp_terminal_available(other.to_str().unwrap()));
    }

    #[test]
    fn runs_an_allowed_command_in_the_sandbox_of_the_agent_folder() {
        if !matches!(sandbox::support(), sandbox::Support::Available(_)) {
            eprintln!("skipping: no sandbox here");
            return;
        }

        let (state, project, _, _, _scratch) = setup("runs");
        // Only an unavailable sandbox skips the test (above). Once it is available, any refusal to start is a regression.
        let terminal = state
            .acp_terminal_start(&request(&project, "pwd; echo made > made.txt"))
            .unwrap_or_else(|error| panic!("the terminal did not start: {error}"));
        let exit = terminal.wait(Duration::from_secs(20)).expect("ended");

        assert_eq!(exit.exit_code, Some(0), "{}", terminal.output().output);
        assert!(terminal.output().output.contains("project"));
        assert!(project.join("made.txt").exists());
    }
}
