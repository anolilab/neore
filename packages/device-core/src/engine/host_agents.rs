//! Coding agents (ACP) on a server this computer speaks for (plans/ssh-environments.md §7, S7).
//!
//! The approvals are the same kind the computer's own agents have and are given in the same local window, but they
//! belong to the server: the agent's command is a path ON the server, and the folder is one of the folders shared
//! for it. The desktop's main process speaks the protocol with the agent (the whole session stack is the one the
//! computer's own agents use); `neore-host` on the server only owns the process, and the bytes between them travel
//! over the connection the server's calls already use. Nothing here starts anything on the server that the person did
//! not approve for that agent and that folder, and nothing is started on a server this computer is not connected to.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use super::{now_ms, DeviceState, Event, SharedSink};
use crate::acp::{
    changes_program, folder_id, folder_label, validate_agent, validate_env_var, AcpAgent,
    AcpAgentView, AcpConsent, AcpUpdate, SpawnPlan, MAX_AGENTS, MAX_CONSENTS, MAX_ENV_VARS,
};
use crate::ssh::{base64_encode_unpadded, AgentExit, AgentSink, RunningAgents};
use crate::store::Host;

/// A server's folder for an agent: an absolute path on the server inside one of the folders shared for it. Checked
/// by text here, because this computer cannot canonicalise a path on another machine; the host resolves it on its own
/// filesystem and refuses what leaves the shared folders when it starts the agent.
fn approved_folder(folder: &str, roots: &[String]) -> Result<String, String> {
    let trimmed = if folder.len() > 1 {
        folder.trim_end_matches('/')
    } else {
        folder
    };
    let path = Path::new(trimmed);

    if !trimmed.starts_with('/')
        || trimmed.len() > 1000
        || trimmed.contains(['\0', '\n', '\r'])
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(format!(
            "{folder}: use an absolute folder path on the server"
        ));
    }

    if !roots.iter().any(|root| path.starts_with(Path::new(root))) {
        return Err(format!(
            "{folder}: not inside a folder shared with this server. Share it first"
        ));
    }

    Ok(trimmed.to_owned())
}

/// The (agent, folder) pairs a server offers: labels and opaque ids, no path.
pub(crate) fn host_offers(host: &Host) -> Vec<Value> {
    host.acp_consents
        .iter()
        .filter_map(|consent| {
            let agent = host
                .acp_agents
                .iter()
                .find(|agent| agent.key == consent.agent_key)?;

            Some(json!({
                "agentKey": consent.agent_key, "agentLabel": agent.label,
                "folderId": consent.folder_id, "folderLabel": consent.folder_label,
            }))
        })
        .take(crate::acp_call::MAX_OFFERS)
        .collect()
}

/// What the local window lists of a server's agents: the same shape as the computer's own.
pub(crate) fn host_agent_views(host: &Host) -> Vec<AcpAgentView> {
    host.acp_agents
        .iter()
        .map(|agent| AcpAgentView {
            args: agent.args.clone(),
            command: agent.command.clone(),
            env_names: agent.env.names(),
            install: None,
            key: agent.key.clone(),
            label: agent.label.clone(),
        })
        .collect()
}

/// The agent's own variables belong to one program; a variable that changes which code a program runs makes the
/// approvals of that agent stale.
fn apply_update(host: &mut Host, update: AcpUpdate) -> Result<(), String> {
    match update {
        AcpUpdate::SaveAgent {
            args,
            command,
            key,
            label,
        } => {
            let agent = AcpAgent {
                args,
                command,
                env: host
                    .acp_agents
                    .iter()
                    .find(|existing| existing.key == key)
                    .map(|existing| existing.env.clone())
                    .unwrap_or_default(),
                install: None,
                key,
                label,
            };

            validate_agent(&agent)?;

            match host
                .acp_agents
                .iter()
                .position(|existing| existing.key == agent.key)
            {
                Some(index) => {
                    // A different program is not the one the person approved these folders for.
                    if host.acp_agents[index].command != agent.command
                        || host.acp_agents[index].args != agent.args
                    {
                        host.acp_consents.retain(|c| c.agent_key != agent.key);
                    }

                    host.acp_agents[index] = agent;
                }
                None if host.acp_agents.len() >= MAX_AGENTS => {
                    return Err(format!("at most {MAX_AGENTS} agents"));
                }
                None => host.acp_agents.push(agent),
            }
        }
        AcpUpdate::RemoveAgent { key } => {
            host.acp_agents.retain(|agent| agent.key != key);
            host.acp_consents.retain(|c| c.agent_key != key);
        }
        AcpUpdate::Grant { agent_key, folder } => {
            if !host.acp_agents.iter().any(|agent| agent.key == agent_key) {
                return Err("that agent is not registered for this server".into());
            }

            let path = approved_folder(&folder, &host.roots)?;
            let folder_id = folder_id(&path);

            if host.acp_consents.len() >= MAX_CONSENTS {
                return Err(format!("at most {MAX_CONSENTS} approvals"));
            }

            if !host
                .acp_consents
                .iter()
                .any(|c| c.agent_key == agent_key && c.folder_id == folder_id)
            {
                host.acp_consents.push(AcpConsent {
                    agent_key,
                    folder_id,
                    folder_label: folder_label(&path),
                    folder_path: path,
                });
            }
        }
        AcpUpdate::Revoke {
            agent_key,
            folder_id,
        } => {
            host.acp_consents
                .retain(|c| !(c.agent_key == agent_key && c.folder_id == folder_id));
        }
        AcpUpdate::SetEnv {
            agent_key: Some(agent_key),
            name,
            value,
        } => {
            validate_env_var(&name, &value)?;

            let agent = host
                .acp_agents
                .iter_mut()
                .find(|agent| agent.key == agent_key)
                .ok_or("that agent is not registered for this server")?;

            if !agent.env.0.contains_key(&name) && agent.env.0.len() >= MAX_ENV_VARS {
                return Err(format!("at most {MAX_ENV_VARS} variables"));
            }

            let moved = changes_program(&name) && agent.env.0.get(&name) != Some(&value);

            agent.env.0.insert(name, value);

            if moved {
                host.acp_consents.retain(|c| c.agent_key != agent_key);
            }
        }
        AcpUpdate::RemoveEnv {
            agent_key: Some(agent_key),
            name,
        } => {
            let agent = host
                .acp_agents
                .iter_mut()
                .find(|agent| agent.key == agent_key)
                .ok_or("that agent is not registered for this server")?;

            if agent.env.0.remove(&name).is_some() && changes_program(&name) {
                host.acp_consents.retain(|c| c.agent_key != agent_key);
            }
        }
        AcpUpdate::SetEnv { .. } | AcpUpdate::RemoveEnv { .. } => {
            return Err(
                "variables for every agent are set in this computer's own coding-agent section"
                    .into(),
            );
        }
    }

    Ok(())
}

/// Relays a running agent's output and end to the main process as engine events.
struct AgentRelay {
    agents: RunningAgents,
    handle: u64,
    sink: SharedSink,
}

impl AgentSink for AgentRelay {
    fn output(&self, stderr: bool, bytes: &[u8]) {
        (self.sink)(Event::HostAgent {
            data: base64_encode_unpadded(bytes),
            handle: self.handle,
            stream: if stderr { "stderr" } else { "stdout" },
        });
    }

    fn ended(&self, result: Result<AgentExit, String>) {
        self.agents.lock().unwrap().remove(&self.handle);

        let event = match result {
            Ok(exit) => Event::HostAgentEnded {
                code: exit.code,
                error: None,
                handle: self.handle,
                signal: exit.signal,
            },
            Err(error) => Event::HostAgentEnded {
                code: None,
                error: Some(error),
                handle: self.handle,
                signal: None,
            },
        };

        (self.sink)(event);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAcpResult {
    pub agents: Vec<AcpAgentView>,
    pub consents: Vec<AcpConsent>,
}

impl DeviceState {
    /// The server a signed payload names, if it is one of this computer's.
    pub(crate) fn server_named_by(&self, payload: &str) -> Option<Host> {
        super::hosts::host_named_by(&self.settings(), payload)
    }

    fn paired_server(&self, device_id: &str) -> Result<Host, String> {
        self.settings()
            .hosts
            .into_iter()
            .find(|host| host.device_id == device_id)
            .ok_or_else(|| "that server is not paired with this computer".to_owned())
    }

    /// Registers, changes or removes a coding agent of a server, or approves it for one of the server's shared folders.
    /// Local window only, like the computer's own.
    pub fn host_acp_update(
        &self,
        device_id: &str,
        update: AcpUpdate,
    ) -> Result<HostAcpResult, String> {
        let host = self.change_settings(|settings| {
            let host = settings
                .hosts
                .iter_mut()
                .find(|host| host.device_id == device_id)
                .ok_or("that server is not paired with this computer")?;

            apply_update(host, update)?;

            Ok(host.clone())
        })?;

        // The approved pairs are in the server's manifest: the page sends a fresh one.
        self.emit(Event::Changed);

        Ok(HostAcpResult {
            agents: host_agent_views(&host),
            consents: host.acp_consents,
        })
    }

    /// What to start for `agent_key` on a server, in `folder`: the variables the person set (the computer's global ones,
    /// then the agent's own). The server builds the rest of the environment itself, from its own. The pair must be one
    /// the person approved for this server.
    pub fn acp_host_spawn_plan(
        &self,
        device_id: &str,
        agent_key: &str,
        folder: &str,
    ) -> Result<(SpawnPlan, Host), String> {
        let host = self.paired_server(device_id)?;
        let agent = host
            .acp_agents
            .iter()
            .find(|agent| agent.key == agent_key)
            .ok_or("that agent is not registered for this server")?;

        if !host
            .acp_consents
            .iter()
            .any(|c| c.agent_key == agent_key && c.folder_path == folder)
        {
            return Err(format!(
                "{} is not approved for that folder on {}. Approve it in this window first",
                agent.label, host.name
            ));
        }

        let global = self.settings().acp_env;
        let env = crate::acp::agent_env(BTreeMap::new(), &global, &agent.env)?;
        let secret_names: BTreeSet<String> =
            global.0.keys().chain(agent.env.0.keys()).cloned().collect();
        let plan = SpawnPlan {
            args: agent.args.clone(),
            command: agent.command.clone(),
            cwd: folder.to_owned(),
            env,
            scratch: false,
            secret_names: secret_names.into_iter().collect(),
        };

        Ok((plan, host))
    }

    /// Starts an approved agent on a connected server. Its output and its end arrive as [`Event::HostAgent`] and
    /// [`Event::HostAgentEnded`] under `handle`, which the caller chose and which must be unused. Returns what was
    /// planned, for the caller to scrub the user's variable values from what the agent says.
    pub fn host_agent_start(
        &self,
        device_id: &str,
        handle: u64,
        agent_key: &str,
        folder: &str,
    ) -> Result<SpawnPlan, String> {
        let (plan, host) = self.acp_host_spawn_plan(device_id, agent_key, folder)?;
        let link = self
            .connection(device_id)
            .filter(|link| link.is_alive())
            .ok_or_else(|| format!("this computer is not connected to {}", host.name))?;

        if self.ssh.agents.lock().unwrap().contains_key(&handle) {
            return Err("that handle is in use".into());
        }

        let params = json!({
            "args": plan.args, "command": plan.command, "cwd": plan.cwd,
            "env": plan.env.0, "roots": host.roots,
        });
        let relay = Arc::new(AgentRelay {
            agents: Arc::clone(&self.ssh.agents),
            handle,
            sink: Arc::clone(&self.sink),
        });
        // Registered before the request goes out, so an agent that ends at once finds its entry to remove.
        let request = {
            let mut agents = self.ssh.agents.lock().unwrap();

            agents.insert(handle, (Arc::clone(&link), 0));

            drop(agents);

            link.agent_start(&params, relay)
        };

        match request {
            Ok(request) => {
                if let Some(entry) = self.ssh.agents.lock().unwrap().get_mut(&handle) {
                    entry.1 = request;
                }
            }
            Err(error) => {
                self.ssh.agents.lock().unwrap().remove(&handle);

                return Err(error);
            }
        }

        self.audit(json!({
            "at": now_ms(), "decision": "approved", "detail": format!("{} in {}", agent_key, plan.cwd),
            "host": host.name, "status": "started", "tool": "acp_start",
        }));

        Ok(plan)
    }

    /// Bytes for a running agent's stdin; none close it.
    pub fn host_agent_write(&self, handle: u64, bytes: &[u8]) -> Result<(), String> {
        let (link, request) = self
            .ssh
            .agents
            .lock()
            .unwrap()
            .get(&handle)
            .cloned()
            .ok_or("that agent is not running")?;

        link.agent_write(request, bytes)
    }

    /// Stops an agent's whole process group on its server. Its end arrives as an event.
    pub fn host_agent_stop(&self, handle: u64) {
        let entry = self.ssh.agents.lock().unwrap().get(&handle).cloned();

        if let Some((link, request)) = entry {
            link.agent_stop(request);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    use super::*;
    use crate::acp_call::AcpCommand;
    use crate::engine::now_ms;
    use crate::envelope::{self, Domain, Signed};
    use crate::ssh::{Hello, HostLink, RemoteOutcome, RemoteSandbox};
    use crate::store::{self, test_keychain, Pairing, Settings};

    const DESKTOP_SECRET: &str = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";
    const HOST_SECRET: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";

    #[test]
    fn a_folder_must_sit_inside_a_folder_shared_with_the_server() {
        let roots = vec!["/srv/work".to_owned()];

        assert_eq!(
            approved_folder("/srv/work/app/", &roots).unwrap(),
            "/srv/work/app"
        );
        assert_eq!(approved_folder("/srv/work", &roots).unwrap(), "/srv/work");
        assert!(approved_folder("/srv/other", &roots).is_err());
        assert!(approved_folder("/srv/workshop", &roots).is_err());
        assert!(approved_folder("/srv/work/../etc", &roots).is_err());
        assert!(approved_folder("srv/work", &roots).is_err());
        assert!(approved_folder("/srv/work/a\nb", &roots).is_err());
    }

    /// A connection that records the agents it was asked to start and keeps their sinks.
    struct Link {
        alive: AtomicBool,
        hello: Hello,
        started: Mutex<Vec<Value>>,
        sinks: Mutex<Vec<Arc<dyn AgentSink>>>,
        stopped: Mutex<Vec<u64>>,
        written: Mutex<Vec<(u64, Vec<u8>)>>,
    }

    impl Link {
        fn new() -> Arc<Link> {
            Arc::new(Link {
                alive: AtomicBool::new(true),
                hello: Hello {
                    agents: true,
                    platform: "linux".into(),
                    protocol: 3,
                    sandbox: RemoteSandbox {
                        available: true,
                        detail: "Landlock".into(),
                    },
                    version: "0.1.0".into(),
                },
                started: Mutex::default(),
                sinks: Mutex::default(),
                stopped: Mutex::default(),
                written: Mutex::default(),
            })
        }
    }

    impl HostLink for Link {
        fn close(&self) {
            self.alive.store(false, Ordering::SeqCst);
        }

        fn exit_master(&self) {}

        fn hello(&self) -> &Hello {
            &self.hello
        }

        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }

        fn target(&self) -> Option<&crate::ssh::Target> {
            None
        }

        fn run(&self, _params: &Value, _wait: Duration) -> Result<RemoteOutcome, String> {
            Err("not used".into())
        }

        fn agent_start(&self, params: &Value, sink: Arc<dyn AgentSink>) -> Result<u64, String> {
            self.started.lock().unwrap().push(params.clone());
            self.sinks.lock().unwrap().push(sink);

            Ok(41)
        }

        fn agent_write(&self, handle: u64, bytes: &[u8]) -> Result<(), String> {
            self.written.lock().unwrap().push((handle, bytes.to_vec()));

            Ok(())
        }

        fn agent_stop(&self, handle: u64) {
            self.stopped.lock().unwrap().push(handle);
        }
    }

    fn server(device_id: &str) -> Host {
        Host {
            acp_agents: vec![AcpAgent {
                args: vec!["--acp".into()],
                command: "/opt/agent/bin/agent".into(),
                env: crate::acp::EnvVars::default(),
                install: None,
                key: "claude".into(),
                label: "Claude Code".into(),
            }],
            acp_consents: vec![AcpConsent {
                agent_key: "claude".into(),
                folder_id: folder_id("/srv/app"),
                folder_label: "app".into(),
                folder_path: "/srv/app".into(),
            }],
            address: "build.example.com".into(),
            allow_shell_network: false,
            allow_unsandboxed_shell: false,
            device_id: device_id.into(),
            forward_agent: false,
            identity_file: None,
            name: "build-box".into(),
            port: 22,
            roots: vec!["/srv/app".into()],
            secret: HOST_SECRET.into(),
            user: "deploy".into(),
        }
    }

    type Events = Arc<Mutex<Vec<Event>>>;

    /// A paired desktop and a server of the ids `test-desk` and `test-host`, connected over `link` when given.
    fn engine(test: &str, link: Option<&Arc<Link>>) -> (DeviceState, PathBuf, Events) {
        test_keychain::install();

        let dir =
            std::env::temp_dir().join(format!("neore-host-agents-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                hosts: vec![server(&format!("ha-{test}-host"))],
                pairing: Some(Pairing {
                    account_label: "me".into(),
                    device_id: format!("ha-{test}-desk"),
                    secret: DESKTOP_SECRET.into(),
                }),
                ..Settings::default()
            },
        )
        .unwrap();

        let events: Events = Arc::default();
        let seen = Arc::clone(&events);
        let state = DeviceState::new(
            &dir,
            Box::new(move |event| seen.lock().unwrap().push(event)),
        );

        if let Some(link) = link {
            let link: Arc<dyn HostLink> = Arc::clone(link) as Arc<dyn HostLink>;

            state
                .ssh
                .connections
                .lock()
                .unwrap()
                .insert(format!("ha-{test}-host"), link);
        }

        (state, dir, events)
    }

    fn call(secret: &str, device_id: &str, tool: &str, input: Value) -> Signed {
        envelope::sign_value(
            secret,
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": format!("call-{tool}-{device_id}"), "deviceId": device_id,
                "expiresAt": now_ms() + 60_000, "issuedAt": now_ms(), "nonce": "n",
                "input": input, "taintedBy": [], "threadTitle": "Deploy", "tool": tool,
            }),
        )
    }

    fn start_input(agent: &str, folder: &str) -> Value {
        json!({ "agentKey": agent, "folderId": folder_id(folder), "sessionId": "s1", "threadId": "t1" })
    }

    #[test]
    fn a_start_for_a_server_is_verified_with_its_secret_against_its_own_approvals() {
        let (state, dir, _) = engine("prepare", None);
        let (host, desk) = ("ha-prepare-host", "ha-prepare-desk");
        let prepared = state
            .acp_prepare(&call(
                HOST_SECRET,
                host,
                "acp_start",
                start_input("claude", "/srv/app"),
            ))
            .unwrap();

        assert_eq!(prepared.device_id, host);
        assert_eq!(prepared.server.as_deref(), Some("build-box"));
        assert!(prepared.refusal.is_none(), "{:?}", prepared.refusal);

        let Some(AcpCommand::Start {
            agent_label,
            folder_path,
            ..
        }) = prepared.command
        else {
            panic!("expected a start");
        };

        // The label says where it runs; the folder is the one approved for the server.
        assert_eq!(agent_label, "Claude Code on build-box");
        assert_eq!(folder_path, "/srv/app");

        // The desktop's own secret does not sign for a server, and the server's does not sign for the desktop.
        assert!(state
            .acp_prepare(&call(
                DESKTOP_SECRET,
                host,
                "acp_start",
                start_input("claude", "/srv/app")
            ))
            .is_err());
        assert!(state
            .acp_prepare(&call(
                HOST_SECRET,
                desk,
                "acp_start",
                start_input("claude", "/srv/app")
            ))
            .is_err());

        // An approval for the server is nothing for this computer, and a pair the server lacks is refused.
        let own = state
            .acp_prepare(&call(
                DESKTOP_SECRET,
                desk,
                "acp_start",
                start_input("claude", "/srv/app"),
            ))
            .unwrap();

        assert!(own.command.is_none());
        assert_eq!(
            own.refusal.as_deref(),
            Some("not approved on this computer")
        );

        let unapproved = state
            .acp_prepare(&call(
                HOST_SECRET,
                host,
                "acp_start",
                start_input("claude", "/srv/other"),
            ))
            .unwrap();

        assert!(unapproved.command.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_result_of_a_command_for_a_server_is_signed_with_the_servers_secret() {
        let (state, dir, _) = engine("sign", None);
        let signed = call(
            HOST_SECRET,
            "ha-sign-host",
            "acp_cancel",
            json!({ "sessionId": "s1", "turnId": "u1" }),
        );
        let result = state.acp_sign(&signed, "accepted").unwrap();

        assert!(envelope::verify(
            HOST_SECRET,
            Domain::Result,
            &result.payload,
            &result.signature
        ));
        assert!(!envelope::verify(
            DESKTOP_SECRET,
            Domain::Result,
            &result.payload,
            &result.signature
        ));
        assert!(result.payload.contains("ha-sign-host"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_turn_post_is_signed_with_the_secret_of_the_device_it_names_and_no_other() {
        let (state, dir, _) = engine("turn", None);
        let post = |device: &str| {
            format!(r#"{{"v":1,"kind":"turn","deviceId":"{device}","threadId":"t"}}"#)
        };

        assert_eq!(
            state.sign_turn(&post("ha-turn-host")).unwrap(),
            envelope::sign(HOST_SECRET, Domain::Turn, &post("ha-turn-host"))
        );
        assert_eq!(
            state.sign_turn(&post("ha-turn-desk")).unwrap(),
            envelope::sign(DESKTOP_SECRET, Domain::Turn, &post("ha-turn-desk"))
        );
        assert!(state.sign_turn(&post("someone-else")).is_err());
        assert!(state
            .sign_turn(r#"{"v":1,"kind":"call","deviceId":"ha-turn-host"}"#)
            .is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_servers_manifest_carries_its_own_offers_and_not_the_computers() {
        let (state, dir, _) = engine("manifest", Some(&Link::new()));
        let signed = state.manifest_for(Some("ha-manifest-host")).unwrap();
        let manifest: Value = serde_json::from_str(&signed.payload).unwrap();

        assert!(envelope::verify(
            HOST_SECRET,
            Domain::Manifest,
            &signed.payload,
            &signed.signature
        ));
        assert_eq!(manifest["acpOffers"][0]["agentKey"], "claude");
        assert_eq!(manifest["acpOffers"][0]["agentLabel"], "Claude Code");
        // No path, no command line.
        assert!(!signed.payload.contains("/opt/agent"));
        assert_eq!(manifest["acpOffers"].as_array().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_agent_starts_only_for_an_approved_pair_on_a_connected_server() {
        let link = Link::new();
        let (state, dir, events) = engine("start", Some(&link));
        let host = "ha-start-host";

        // Not approved for that folder, not registered, and not a server of this computer: nothing is sent.
        assert!(state
            .host_agent_start(host, 1, "claude", "/srv/app/other")
            .is_err());
        assert!(state.host_agent_start(host, 1, "nope", "/srv/app").is_err());
        assert!(state
            .host_agent_start("ha-start-stranger", 1, "claude", "/srv/app")
            .is_err());
        assert!(link.started.lock().unwrap().is_empty());

        let plan = state
            .host_agent_start(host, 7, "claude", "/srv/app")
            .unwrap();

        assert_eq!(plan.command, "/opt/agent/bin/agent");

        let started = link.started.lock().unwrap();

        // Only the person's variables travel: the host builds the environment from its own.
        assert_eq!(started[0]["env"], json!({}));
        assert_eq!(started[0]["cwd"], "/srv/app");
        assert_eq!(started[0]["roots"], json!(["/srv/app"]));
        assert_eq!(started[0]["args"], json!(["--acp"]));
        drop(started);

        // Output and the end arrive as events under the caller's handle.
        let sink = Arc::clone(&link.sinks.lock().unwrap()[0]);

        sink.output(false, b"hi");
        sink.output(true, b"oops");
        sink.ended(Ok(AgentExit {
            code: Some(0),
            signal: None,
        }));

        let events = events.lock().unwrap();
        let relayed: Vec<String> = events
            .iter()
            .filter_map(|event| match event {
                Event::HostAgent {
                    data,
                    handle: 7,
                    stream,
                } => Some(format!("{stream}:{data}")),
                _ => None,
            })
            .collect();

        assert_eq!(relayed, ["stdout:aGk", "stderr:b29wcw"]);
        assert!(events.iter().any(|event| matches!(
            event,
            Event::HostAgentEnded {
                handle: 7,
                code: Some(0),
                ..
            }
        )));
        drop(events);

        // It has ended, so it can no longer be written to.
        assert!(state.host_agent_write(7, b"x").is_err());

        // Input and stop reach the connection under the request id it gave.
        state
            .host_agent_start(host, 8, "claude", "/srv/app")
            .unwrap();
        state.host_agent_write(8, b"line\n").unwrap();
        state.host_agent_stop(8);

        assert_eq!(
            link.written.lock().unwrap().as_slice(),
            [(41, b"line\n".to_vec())]
        );
        assert_eq!(link.stopped.lock().unwrap().as_slice(), [41]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_starts_on_a_server_this_computer_is_not_connected_to() {
        let (state, dir, _) = engine("offline", None);
        let error = state
            .host_agent_start("ha-offline-host", 1, "claude", "/srv/app")
            .unwrap_err();

        assert!(error.contains("not connected to build-box"), "{error}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_servers_approvals_are_edited_for_that_server_and_inside_its_shared_folders() {
        let (state, dir, _) = engine("update", None);
        let host = "ha-update-host";
        let grant = |folder: &str| AcpUpdate::Grant {
            agent_key: "claude".into(),
            folder: folder.into(),
        };

        assert!(state.host_acp_update(host, grant("/etc")).is_err());

        let view = state.host_acp_update(host, grant("/srv/app/sub")).unwrap();

        assert_eq!(view.consents.len(), 2);
        // The computer's own lists are untouched.
        assert!(state.settings().acp_consents.is_empty());

        // A different program is not the one the folders were approved for.
        let view = state
            .host_acp_update(
                host,
                AcpUpdate::SaveAgent {
                    args: vec![],
                    command: "/tmp/other".into(),
                    key: "claude".into(),
                    label: "Claude Code".into(),
                },
            )
            .unwrap();

        assert!(view.consents.is_empty());
        // Variables for every agent are set for the computer, not per server.
        assert!(state
            .host_acp_update(
                host,
                AcpUpdate::SetEnv {
                    agent_key: None,
                    name: "A".into(),
                    value: "b".into()
                }
            )
            .is_err());
        assert!(state
            .host_acp_update("ha-update-stranger", grant("/srv/app"))
            .is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
