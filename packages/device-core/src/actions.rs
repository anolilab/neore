//! What a device does for one call, minus the decision to do it: `fs_list`, `fs_read`, `fs_write`,
//! `shell_run` and local MCP calls, planned from explicit inputs (the shared folders, the shell policy)
//! and run. Nothing here knows about pairing, envelopes, approvals or the keychain.
//!
//! Two callers share it. The desktop engine (`engine.rs`) verifies the signed call and asks the person
//! first. `neore-host` (`host.rs`) receives an action the desktop already approved and trusts exactly that
//! pipe. Both plan against the shared folders and the sandbox of the machine they run on.

use std::fs as stdfs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::fs;
use crate::mcp::{McpManager, McpServerConfig};
use crate::sandbox;
use crate::shell;

/// Output cap for every result; the backend re-caps anyway.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const SHELL_DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
pub const SHELL_MAX_TIMEOUT: Duration = Duration::from_secs(600);
/// Shared folders a device accepts.
pub const MAX_ROOTS: usize = 20;
const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(120);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Caps text at `max` bytes of UTF-8 without splitting a character.
pub fn cap_utf8(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_owned(), false);
    }

    let mut end = max;

    while !text.is_char_boundary(end) {
        end -= 1;
    }

    (text[..end].to_owned(), true)
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// Why a canonical folder may not be shared, if it may not. The sandbox re-allows
/// reads and writes under every root, so a root holding `$HOME` would expose
/// `~/.ssh` and friends. A root INSIDE home is the user's choice.
pub(crate) fn refused_root(path: &Path, home: Option<&Path>) -> Option<&'static str> {
    if path.parent().is_none() {
        return Some("sharing a whole drive is not allowed");
    }

    home.filter(|home| home.starts_with(path))
        .map(|_| "sharing your home folder or one of its parents is not allowed")
}

pub(crate) fn canonical_home() -> Option<PathBuf> {
    sandbox::home().and_then(|home| stdfs::canonicalize(home).ok())
}

/// The shared roots that still exist, canonicalised, and that the home guard allows.
pub fn shareable_roots(roots: &[String]) -> Vec<PathBuf> {
    let home = canonical_home();

    fs::canonical_roots(roots)
        .into_iter()
        .filter(|root| refused_root(root, home.as_deref()).is_none())
        .collect()
}

/// What `shell_run` takes from the owner's settings besides the folders. The default is the safe one: a
/// sandbox is required and the network is off.
#[derive(Clone, Copy, Debug, Default)]
pub struct ShellSettings {
    /// The owner turned OFF "Require sandbox for shell commands".
    pub allow_unsandboxed: bool,
    /// The owner turned ON "Allow network for shell commands".
    pub allow_network: bool,
}

/// One call, planned and checked before the user is asked, so the prompt shows
/// exactly what will run (resolved paths, the command, the folder).
#[derive(PartialEq)]
pub enum Action {
    List(PathBuf),
    Read(PathBuf),
    Write {
        content: String,
        overwrite: bool,
        path: PathBuf,
    },
    Shell {
        command: String,
        cwd: PathBuf,
        /// `None` = unsandboxed, which the user allowed.
        sandbox: Option<sandbox::Policy>,
        /// The prompt's line about the sandbox.
        sandbox_note: String,
        timeout: Duration,
    },
    Mcp {
        arguments: Value,
        read_only: bool,
        server: McpServerConfig,
        tool: String,
    },
}

impl Action {
    pub fn read_only(&self) -> bool {
        match self {
            Action::List(_) | Action::Read(_) => true,
            Action::Write { .. } | Action::Shell { .. } => false,
            Action::Mcp { read_only, .. } => *read_only,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Action::List(_) | Action::Read(_) | Action::Write { .. } => "fs",
            Action::Shell { .. } => "shell",
            Action::Mcp { .. } => "mcp",
        }
    }

    pub fn detail(&self) -> String {
        match self {
            Action::List(path) => format!("List the folder {}", path.display()),
            Action::Read(path) => format!("Read the file {}", path.display()),
            Action::Write {
                content,
                overwrite,
                path,
            } => format!(
                "{} {} ({} bytes):\n{}",
                if *overwrite { "Overwrite" } else { "Create" },
                path.display(),
                content.len(),
                cap_utf8(content, 2000).0
            ),
            Action::Shell {
                command,
                cwd,
                sandbox_note,
                timeout,
                ..
            } => {
                format!(
                    "{sandbox_note}\n\nRun in {} (stops after {} s):\n{command}",
                    cwd.display(),
                    timeout.as_secs()
                )
            }
            Action::Mcp {
                arguments,
                server,
                tool,
                ..
            } => {
                format!(
                    "Call {tool} on the local MCP server \"{}\" ({} {})",
                    server.name,
                    server.command,
                    server.args.join(" ")
                ) + &format!(
                    "\n{}",
                    serde_json::to_string_pretty(arguments).unwrap_or_default()
                )
            }
        }
    }
}

fn string_arg<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// Plans one of the four built-in tools against `roots` (already [`shareable_roots`]). `None` when `tool` is
/// not a built-in one: the engine then looks for an MCP tool of that name, a host has no other.
pub fn plan_builtin(
    tool: &str,
    input: &Value,
    roots: &[PathBuf],
    shell: ShellSettings,
) -> Option<Result<Action, String>> {
    Some(match tool {
        "fs_list" => {
            fs::resolve_existing(string_arg(input, "path").unwrap_or(""), roots).map(Action::List)
        }
        "fs_read" => string_arg(input, "path")
            .ok_or_else(|| "path is required".to_owned())
            .and_then(|path| fs::resolve_existing(path, roots))
            .map(Action::Read),
        "fs_write" => plan_write(input, roots),
        "shell_run" => plan_shell(input, roots, shell),
        _ => return None,
    })
}

fn plan_write(input: &Value, roots: &[PathBuf]) -> Result<Action, String> {
    Ok(Action::Write {
        content: string_arg(input, "content")
            .ok_or("content is required")?
            .to_owned(),
        overwrite: input
            .get("overwrite")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        path: fs::resolve_for_write(string_arg(input, "path").ok_or("path is required")?, roots)?,
    })
}

fn plan_shell(input: &Value, roots: &[PathBuf], shell: ShellSettings) -> Result<Action, String> {
    let command = string_arg(input, "command")
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .ok_or("command is required")?;

    if command.len() > 8000 {
        return Err("the command is too long".into());
    }

    let cwd = fs::resolve_existing(string_arg(input, "cwd").unwrap_or(""), roots)?;

    if !cwd.is_dir() {
        return Err("cwd is not a folder".into());
    }

    let timeout = input
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .map(Duration::from_secs)
        .unwrap_or(SHELL_DEFAULT_TIMEOUT)
        .min(SHELL_MAX_TIMEOUT);

    let support = sandbox::support();
    let policy = sandbox::policy_for_call(
        &support,
        shell.allow_unsandboxed,
        shell.allow_network,
        roots,
        sandbox::home().as_deref(),
    )?;

    Ok(Action::Shell {
        command: command.to_owned(),
        cwd,
        sandbox_note: sandbox::describe(&support, policy.as_ref()),
        sandbox: policy,
        timeout,
    })
}

/// What running an action produced, before anyone decides how to report it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub status: &'static str,
    /// The tool itself cut its output (the shell's pipe cap).
    pub truncated: bool,
}

impl Outcome {
    pub fn failed(error: impl Into<String>) -> Self {
        Outcome {
            error: Some(error.into()),
            exit_code: None,
            output: None,
            status: "failed",
            truncated: false,
        }
    }

    pub fn completed(output: String) -> Self {
        Outcome {
            error: None,
            exit_code: None,
            output: Some(output),
            status: "completed",
            truncated: false,
        }
    }
}

/// Runs a planned action. `roots` are the [`shareable_roots`] the action was planned against, `remaining`
/// the time left before the call expires. An MCP action needs `mcp`; a host passes `None` and has none.
pub fn run(
    action: Action,
    roots: &[PathBuf],
    remaining: Duration,
    mcp: Option<&McpManager>,
) -> Outcome {
    match action {
        Action::List(path) => match fs::list(roots, &path) {
            Ok(listing) => {
                Outcome::completed(serde_json::to_string_pretty(&listing).unwrap_or_default())
            }
            Err(error) => Outcome::failed(error),
        },
        Action::Read(path) => {
            fs::read(roots, &path).map_or_else(Outcome::failed, Outcome::completed)
        }
        Action::Write {
            content,
            overwrite,
            path,
        } => fs::write(roots, &path, &content, overwrite)
            .map_or_else(Outcome::failed, Outcome::completed),
        Action::Shell {
            command,
            cwd,
            sandbox,
            timeout,
            ..
        } => match shell::run(
            &command,
            &cwd,
            timeout.min(remaining),
            MAX_OUTPUT_BYTES,
            sandbox.as_ref(),
        ) {
            Ok(result) if result.timed_out => Outcome {
                output: Some(result.output),
                truncated: result.truncated,
                ..Outcome::failed(format!(
                    "stopped after {} s",
                    timeout.min(remaining).as_secs()
                ))
            },
            Ok(result) => Outcome {
                exit_code: result.exit_code,
                truncated: result.truncated,
                ..Outcome::completed(result.output)
            },
            Err(error) => Outcome::failed(error),
        },
        Action::Mcp {
            arguments,
            server,
            tool,
            ..
        } => {
            let Some(mcp) = mcp else {
                return Outcome::failed("MCP servers are not available here");
            };

            match mcp.with(&server, |process| {
                process.call_tool(&tool, arguments.clone(), MCP_CALL_TIMEOUT.min(remaining))
            }) {
                Ok((text, false)) => Outcome::completed(text),
                Ok((text, true)) => Outcome {
                    output: Some(text),
                    ..Outcome::failed("the tool reported an error")
                },
                Err(error) => Outcome::failed(error),
            }
        }
    }
}
