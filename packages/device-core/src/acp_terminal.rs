//! A coding agent's terminals (ACP `terminal/create`), run on this computer in the `shell_run` sandbox.
//!
//! The main process asks the person first (a once-only permission request through `acp_permission.rs`, never batched)
//! and then starts the command here. Rust decides the rest, whoever asks: the agent must be approved for the folder,
//! the working folder must be inside it, the command runs in the OS sandbox with the shared folders as the only
//! writable place and the network tier `shell_run` has, and nothing runs where there is no sandbox (the "Require
//! sandbox" setting is not consulted: a terminal is never unsandboxed). The terminal is the caller's to read, kill and
//! release (`shell::Terminal`).
//!
//! A terminal runs for at most `SHELL_MAX_TIMEOUT` (ten minutes, the limit `shell_run` has), then its process group is
//! killed. The exit reports `SIGKILL` as a kill does, so a timeout is not told apart from one. A longer or configurable
//! limit is a product decision that has not been made.

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
        let agent_env = settings
            .acp_agents
            .iter()
            .filter(|agent| agent.key == request.agent_key)
            .flat_map(|agent| agent.env.0.values());
        let known: Vec<&str> = request
            .env
            .iter()
            .map(|(_, value)| value)
            .chain(settings.acp_env.0.values())
            .chain(agent_env)
            .map(String::as_str)
            .collect();
        let shown = redact_command(line, &known);

        self.audit(json!({
            "at": now_ms(), "decision": "once", "detail": format!("{shown}\n(in {})", cwd.display()),
            "status": "started", "tool": "acp_terminal",
        }));

        Ok(terminal)
    }
}

const REDACTED: &str = "[redacted]";
/// A known value shorter than this is not searched for: it would strike ordinary characters out of the command.
const MIN_KNOWN_SECRET_BYTES: usize = 4;
const SECRET_FLAGS: [&str; 6] = [
    "--token",
    "--password",
    "--api-key",
    "--secret",
    "-u",
    "--user",
];
const SECRET_NAME_PARTS: [&str; 5] = ["TOKEN", "SECRET", "PASSWORD", "KEY", "CREDENTIAL"];
const AUTH_SCHEMES: [&str; 4] = ["bearer", "basic", "token", "digest"];

/// The command line as the audit log keeps it: every known secret value, and the value of each credential-shaped
/// argument (an `Authorization:` header, a `Bearer` token, a `--token`-like flag, a `*TOKEN*=`-like assignment), is
/// replaced with `[redacted]`. A quoted value spanning several words has each of its words replaced.
fn redact_command(line: &str, known: &[&str]) -> String {
    let mut known: Vec<&str> = known
        .iter()
        .copied()
        .filter(|value| value.len() >= MIN_KNOWN_SECRET_BYTES)
        .collect();

    known.sort_by_key(|value| std::cmp::Reverse(value.len()));

    let mut text = line.to_owned();

    for value in known {
        text = text.replace(value, REDACTED);
    }

    let mut out = String::with_capacity(text.len());
    let mut redact_next = false;
    let mut open_quote: Option<char> = None;
    let mut rest = text.as_str();

    while !rest.is_empty() {
        let word_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let (word, after) = rest.split_at(word_end);
        let space_end = after
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(after.len());
        let (space, next) = after.split_at(space_end);

        rest = next;

        if word.is_empty() {
            out.push_str(space);
            continue;
        }

        if let Some(quote) = open_quote {
            if word.ends_with(quote) {
                open_quote = None;
            }

            out.push_str(&redacted(word));
            out.push_str(space);
            continue;
        }

        let core = unquoted(word);
        let lower = core.to_ascii_lowercase();

        if redact_next {
            if AUTH_SCHEMES.contains(&lower.as_str()) {
                out.push_str(word);
            } else {
                redact_next = false;
                open_quote = opens_quote(word);
                out.push_str(&redacted(word));
            }

            out.push_str(space);
            continue;
        }

        if lower == "bearer"
            || lower.ends_with("authorization:")
            || SECRET_FLAGS.contains(&lower.as_str())
        {
            redact_next = true;
            out.push_str(word);
        } else if let Some(split) = value_start(word, &lower) {
            let (head, value) = word.split_at(split);

            if AUTH_SCHEMES.contains(&unquoted(value).to_ascii_lowercase().as_str()) {
                redact_next = true;
                out.push_str(word);
            } else {
                open_quote = opens_quote(value);
                out.push_str(head);
                out.push_str(&redacted(value));
            }
        } else {
            out.push_str(word);
        }

        out.push_str(space);
    }

    out
}

/// Where the secret value starts inside one word: after `authorization:`, after `--token=` and the like, or after
/// `NAME=` when the name looks like a credential's.
fn value_start(word: &str, lower: &str) -> Option<usize> {
    let lead = word.len() - word.trim_start_matches(['"', '\'']).len();
    let value_at =
        |prefix_len: usize| (lead + prefix_len < word.len()).then_some(lead + prefix_len);

    if let Some(at) = lower.find("authorization:") {
        return value_at(at + "authorization:".len());
    }

    for flag in SECRET_FLAGS {
        if lower.starts_with(flag) && lower[flag.len()..].starts_with('=') {
            return value_at(flag.len() + 1);
        }
    }

    let core = unquoted(word);
    let eq = core.find('=')?;
    let name = &core[..eq];
    let upper = name.to_ascii_uppercase();

    (!name.is_empty()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && SECRET_NAME_PARTS.iter().any(|part| upper.contains(part)))
    .then_some(())
    .and_then(|()| value_at(eq + 1))
}

fn unquoted(word: &str) -> &str {
    word.trim_matches(['"', '\''])
}

/// The quote a value opens and does not close within its word.
fn opens_quote(value: &str) -> Option<char> {
    let quote = value.chars().next().filter(|c| matches!(c, '"' | '\''))?;

    (value.matches(quote).count() % 2 == 1).then_some(quote)
}

/// `word` with everything but its surrounding quotes replaced.
fn redacted(word: &str) -> String {
    let lead = word.len() - word.trim_start_matches(['"', '\'']).len();
    let trail = word.len() - word.trim_end_matches(['"', '\'']).len();

    if lead + trail >= word.len() {
        return word.to_owned();
    }

    format!("{}{REDACTED}{}", &word[..lead], &word[word.len() - trail..])
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
            .acp_update(AcpUpdate::SaveAgent {
                args: Vec::new(),
                command: "/bin/agent".into(),
                key: "agent".into(),
                label: "Agent".into(),
            })
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

        // The reason must be the refusal itself, not a sandbox or start error: a start that accepted the variable could
        // still fail later on a machine without a sandbox, and only the message tells that apart.
        assert_eq!(
            refusal(&state, &reserved),
            "NEORE_DEVICE_SECRET is reserved by Neore"
        );
        assert_eq!(
            refusal(&state, &request(&project, "   ")),
            "the command is empty or too long"
        );
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
    fn redacts_credentials_from_the_audit_text() {
        assert_eq!(
            redact_command(
                "curl -H 'Authorization: Bearer abc.def' https://x.test",
                &[]
            ),
            "curl -H 'Authorization: Bearer [redacted]' https://x.test"
        );
        assert_eq!(
            redact_command("curl -H 'authorization:Bearer abc' x", &[]),
            "curl -H 'authorization:Bearer [redacted]' x"
        );
        assert_eq!(
            redact_command("tool --token s3cr3t --verbose", &[]),
            "tool --token [redacted] --verbose"
        );
        assert_eq!(
            redact_command("tool --password=\"two words\" --api-key=k", &[]),
            "tool --password=\"[redacted] [redacted]\" --api-key=[redacted]"
        );
        assert_eq!(
            redact_command("tool -u somevalue https://example.com", &[]),
            "tool -u [redacted] https://example.com"
        );
        assert_eq!(
            redact_command("git --user=alice:pw status", &[]),
            "git --user=[redacted] status"
        );
        assert_eq!(
            redact_command("GH_TOKEN=ghp_123 MY_api_key=x DEBUG=1 gh pr list", &[]),
            "GH_TOKEN=[redacted] MY_api_key=[redacted] DEBUG=1 gh pr list"
        );
        assert_eq!(
            redact_command("echo hunter22 && psql -p 5432", &["hunter22", "5"]),
            "echo [redacted] && psql -p 5432"
        );
    }

    #[test]
    fn leaves_an_ordinary_command_unchanged() {
        for line in [
            "cargo test -p device-core",
            "git log --oneline -5 && echo \"a  b\"",
            "TOKEN= true",
        ] {
            assert_eq!(redact_command(line, &[]), line);
        }
    }

    #[test]
    fn runs_the_command_as_given_and_audits_it_redacted() {
        if !matches!(sandbox::support(), sandbox::Support::Available(_)) {
            eprintln!("skipping: no sandbox here");
            return;
        }

        let (state, project, _, _, scratch) = setup("redacts");
        let line = "TOKEN=sentinel-one; echo \"$TOKEN Bearer sentinel-two\"";
        let terminal = state
            .acp_terminal_start(&request(&project, line))
            .unwrap_or_else(|error| panic!("the terminal did not start: {error}"));
        let exit = terminal.wait(Duration::from_secs(20)).expect("ended");
        let output = terminal.output().output;

        assert_eq!(exit.exit_code, Some(0), "{output}");
        assert!(
            output.contains("sentinel-one Bearer sentinel-two"),
            "{output}"
        );

        let audit = fs::read_to_string(scratch.0.join("data/device-audit.jsonl")).unwrap();

        assert!(
            audit.contains("acp_terminal") && audit.contains("[redacted]"),
            "{audit}"
        );
        assert!(!audit.contains("sentinel-"), "{audit}");
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
