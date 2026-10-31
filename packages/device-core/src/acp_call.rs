//! Commands the backend sends to a coding agent on this computer: `acp_start`, `acp_send`, `acp_cancel` and
//! `acp_permission_answer` (plans/acp-agent-host.md §4.1).
//!
//! They are signed device calls like any other, but they are not device tools: nothing runs here. Rust checks the
//! signature, the device and the expiry, decides whether the command may be carried out at all (a start needs an
//! (agent, folder) pair the user approved in the local window), and hands it to the main process, which does the
//! work. The result it signs says only `accepted` or `refused: <reason>`; turn output never travels in it.
//!
//! The steps are separate so the main process can write its receipt in between, which a single `execute` could not:
//!
//! 1. [`DeviceState::acp_prepare`]: verify, check the command, return it. Nothing is recorded.
//! 2. The main process writes a receipt for the call id, then acts on the command.
//! 3. [`DeviceState::acp_sign`]: sign `accepted` or the refusal.
//!
//! **No nonce is spent here.** A claimed call that is not completed in time goes back to the queue under the same
//! envelope, so a nonce spent at step 1 would refuse the redelivery and the command would never run. Replay is
//! stopped by the receipt log instead: keyed by the signed call id, written before the command is acted on and kept
//! until the envelope expires, it makes a second delivery an acknowledgement, not a second run.

use serde::Serialize;
use serde_json::{json, Value};

use crate::engine::{now_ms, usable_pairing, DeviceState, Outcome};
use crate::envelope::{self, CallEnvelope, Domain, Signed};
use crate::store::Host;

/// Ids the backend mints (session, turn, thread, request) and the agent's own option ids.
const ID_MAX: usize = 128;
/// The longest prompt one command carries. The backend caps a call's whole input at 32 KiB; this is the same
/// limit on the prompt alone, in characters, with room to spare for the rest of the input.
const TEXT_MAX: usize = 32 * 1024;
/// `acp_start` offers at most this many pairs in the manifest.
pub const MAX_OFFERS: usize = 50;

const TOOLS: [&str; 4] = [
    "acp_cancel",
    "acp_permission_answer",
    "acp_send",
    "acp_start",
];

/// Whether a call's tool name is a coding-agent command rather than a device tool.
pub fn is_acp_tool(tool: &str) -> bool {
    tool.starts_with("acp_")
}

/// What the main process does once the call has its receipt. Everything in it was signed by the backend, except
/// `folder_path`, which comes from the user's own approval and never leaves this computer.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum AcpCommand {
    Cancel {
        /// Keep the prompts queued behind the turn (a worker's stop, whose later messages are other runs). Absent or
        /// anything but `true` drops them, as a person's Stop does.
        keep_queue: bool,
        session_id: String,
        turn_id: String,
    },
    PermissionAnswer {
        option_id: String,
        request_id: String,
        session_id: String,
    },
    Send {
        session_id: String,
        text: String,
        turn_id: String,
    },
    Start {
        agent_key: String,
        agent_label: String,
        folder_id: String,
        folder_label: String,
        folder_path: String,
        session_id: String,
        thread_id: String,
    },
}

/// The outcome of step 1. Exactly one of `command` and `refusal` is set.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPrepared {
    pub call_id: String,
    pub command: Option<AcpCommand>,
    /// The device the call was made for: this computer's, or one of its servers'. Whoever acts on the command needs it
    /// to know where the agent runs.
    pub device_id: String,
    pub expires_at: u64,
    pub refusal: Option<String>,
    /// The server's name when the command is for a server.
    pub server: Option<String>,
}

/// Whose secret verifies and signs a call: this computer's pairing, or a server's own.
struct Signer {
    device_id: String,
    host: Option<Host>,
    secret: String,
}

fn id_of(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| (1..=ID_MAX).contains(&value.len()))
        .map(str::to_owned)
}

/// A refusal reason is a short phrase for the thread to show; it carries nothing the command held.
fn refusal(reason: &str) -> Result<AcpCommand, String> {
    Err(reason.to_owned())
}

impl DeviceState {
    /// The device a call names, if it is one of this computer's servers: only picks the secret to verify with, and
    /// nothing in the payload is trusted until that secret has verified it.
    fn signer_for(&self, signed: &Signed) -> Result<Signer, String> {
        if let Some(host) = self.server_named_by(&signed.payload) {
            if host.secret.is_empty() {
                return Err(
                    "the server's secret is unavailable: the keychain could not be read".into(),
                );
            }

            return Ok(Signer {
                device_id: host.device_id.clone(),
                secret: host.secret.clone(),
                host: Some(host),
            });
        }

        let pairing = usable_pairing(&self.settings())?;

        Ok(Signer {
            device_id: pairing.device_id,
            host: None,
            secret: pairing.secret,
        })
    }

    fn verified_acp_call(&self, signed: &Signed) -> Result<(CallEnvelope, Signer), String> {
        let signer = self.signer_for(signed)?;
        let call =
            envelope::verify_call_unrecorded(&signer.secret, &signer.device_id, signed, now_ms())?;

        if !TOOLS.contains(&call.tool.as_str()) {
            return Err("that is not a coding-agent command".into());
        }

        Ok((call, signer))
    }

    /// Step 1: checks the call and the command in it. A command Rust will not allow comes back as `refusal`, to be
    /// signed by step 3; a call that is not valid at all (signature, device, expiry) is an `Err` and gets no result.
    pub fn acp_prepare(&self, signed: &Signed) -> Result<AcpPrepared, String> {
        let (call, signer) = self.verified_acp_call(signed)?;
        let (command, refusal) = match self.acp_command(&call, signer.host.as_ref()) {
            Ok(command) => (Some(command), None),
            Err(reason) => (None, Some(reason)),
        };

        Ok(AcpPrepared {
            call_id: call.call_id,
            command,
            device_id: signer.device_id,
            expires_at: call.expires_at,
            refusal,
            server: signer.host.map(|host| host.name),
        })
    }

    /// Step 3: the signed result of a call. `outcome` is `accepted` or the reason the command was not carried out.
    /// The call is verified again, so this signs a result only for a command the backend really sent.
    pub fn acp_sign(&self, signed: &Signed, outcome: &str) -> Result<Signed, String> {
        let (call, signer) = self.verified_acp_call(signed)?;
        let accepted = outcome == "accepted";
        let reason: String = outcome.chars().take(200).collect();
        let result = if accepted {
            Outcome::done("accepted")
        } else {
            Outcome::failed("denied", format!("refused: {reason}"))
        };

        let mut audit = json!({
            "at": now_ms(), "callId": call.call_id, "decision": result.decision,
            "detail": if accepted { String::new() } else { reason },
            "status": result.status, "thread": call.thread_title, "tool": call.tool,
        });

        if let Some(host) = &signer.host {
            audit["host"] = json!(host.name);
        }

        self.audit(audit);

        let mut payload = json!({
            "v": 1, "kind": "result", "callId": call.call_id, "deviceId": signer.device_id,
            "status": result.status, "decision": result.decision, "truncated": false,
        });

        if let Some(output) = result.output {
            payload["output"] = json!(output);
        }

        if let Some(error) = result.error {
            payload["error"] = json!(error);
        }

        Ok(envelope::sign_value(
            &signer.secret,
            Domain::Result,
            &payload,
        ))
    }

    fn acp_command(&self, call: &CallEnvelope, host: Option<&Host>) -> Result<AcpCommand, String> {
        let input = &call.input;

        match call.tool.as_str() {
            "acp_cancel" => match (id_of(input, "sessionId"), id_of(input, "turnId")) {
                (Some(session_id), Some(turn_id)) => Ok(AcpCommand::Cancel {
                    keep_queue: input.get("keepQueue").and_then(Value::as_bool) == Some(true),
                    session_id,
                    turn_id,
                }),
                _ => refusal("a cancel names a session and a turn"),
            },
            "acp_permission_answer" => {
                match (
                    id_of(input, "sessionId"),
                    id_of(input, "requestId"),
                    id_of(input, "optionId"),
                ) {
                    (Some(session_id), Some(request_id), Some(option_id)) => {
                        Ok(AcpCommand::PermissionAnswer {
                            option_id,
                            request_id,
                            session_id,
                        })
                    }
                    _ => refusal("an answer names a session, a request and an option"),
                }
            }
            "acp_send" => {
                let text = input.get("text").and_then(Value::as_str).unwrap_or("");

                match (id_of(input, "sessionId"), id_of(input, "turnId")) {
                    (Some(session_id), Some(turn_id))
                        if !text.trim().is_empty() && text.chars().count() <= TEXT_MAX =>
                    {
                        Ok(AcpCommand::Send {
                            session_id,
                            text: text.to_owned(),
                            turn_id,
                        })
                    }
                    _ => refusal("a send names a session and a turn and carries a prompt"),
                }
            }
            _ => self.acp_start_command(input, host),
        }
    }

    /// The consent check. The pair must be one the user approved in the local window, by the ids the offers
    /// named; the folder path comes from that approval, never from the call.
    fn acp_start_command(&self, input: &Value, host: Option<&Host>) -> Result<AcpCommand, String> {
        let (Some(session_id), Some(thread_id), Some(agent_key), Some(folder_id)) = (
            id_of(input, "sessionId"),
            id_of(input, "threadId"),
            id_of(input, "agentKey"),
            id_of(input, "folderId"),
        ) else {
            return refusal("a start names a session, a thread, an agent and a folder");
        };
        let settings = self.settings();
        // A server's pairs are its own: an approval for this computer says nothing about a server, or the other way round.
        let (agents, consents) = match host {
            Some(host) => (&host.acp_agents, &host.acp_consents),
            None => (&settings.acp_agents, &settings.acp_consents),
        };
        let agent = agents.iter().find(|agent| agent.key == agent_key);
        let consent = consents
            .iter()
            .find(|consent| consent.agent_key == agent_key && consent.folder_id == folder_id);

        match (agent, consent) {
            (Some(agent), Some(consent)) => Ok(AcpCommand::Start {
                agent_key,
                // The label names the server, so the approval prompts and the thread say where the agent runs.
                agent_label: host.map_or_else(
                    || agent.label.clone(),
                    |host| format!("{} on {}", agent.label, host.name),
                ),
                folder_id,
                folder_label: consent.folder_label.clone(),
                folder_path: consent.folder_path.clone(),
                session_id,
                thread_id,
            }),
            _ => refusal("not approved on this computer"),
        }
    }

    /// Answers the coding-agent request the backend names, under the window's rules. `already_answered` when the
    /// request is gone: answered in the window first, or cancelled, or timed out.
    pub fn acp_permission_answer_remote(
        &self,
        session_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), String> {
        let answer = self
            .acp_permissions
            .answer_remote(session_id, request_id, option_id)?;

        // The tool and its target only: the command may carry a secret.
        self.audit(json!({
            "at": now_ms(), "decision": answer.decision, "detail": answer.target.clone().unwrap_or_default(),
            "status": "answered from the web", "thread": answer.agent_label, "tool": format!("acp: {}", answer.tool),
        }));
        self.emit(crate::engine::Event::AcpPermissionsChanged);

        Ok(())
    }

    /// The (agent, folder) pairs the manifest offers to the web and the phone: labels and opaque ids, no path.
    pub fn acp_offers(&self) -> Vec<Value> {
        let settings = self.settings();

        settings
            .acp_consents
            .iter()
            .filter_map(|consent| {
                let agent = settings
                    .acp_agents
                    .iter()
                    .find(|agent| agent.key == consent.agent_key)?;

                Some(json!({
                    "agentKey": consent.agent_key, "agentLabel": agent.label,
                    "folderId": consent.folder_id, "folderLabel": consent.folder_label,
                }))
            })
            .take(MAX_OFFERS)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::acp::{AcpAgent, AcpConsent, EnvVars};
    use crate::engine::Event;
    use crate::store::{self, Pairing, Settings};

    fn secret() -> String {
        "0123456789abcdef".repeat(4)
    }

    type Events = Arc<Mutex<Vec<Event>>>;

    fn state(name: &str) -> (DeviceState, PathBuf, Events) {
        crate::store::test_keychain::install();
        let dir =
            std::env::temp_dir().join(format!("neore-acp-call-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        store::save(
            &dir.join("device.json"),
            &Settings {
                acp_agents: vec![AcpAgent {
                    args: Vec::new(),
                    command: "/bin/agent".into(),
                    env: EnvVars::default(),
                    install: None,
                    key: "claude".into(),
                    label: "Claude Code".into(),
                }],
                acp_consents: vec![AcpConsent {
                    agent_key: "claude".into(),
                    folder_id: "f1".into(),
                    folder_label: "neore".into(),
                    folder_path: "/home/me/neore".into(),
                }],
                pairing: Some(Pairing {
                    account_label: "me".into(),
                    device_id: "dev1".into(),
                    secret: secret(),
                }),
                ..Default::default()
            },
        )
        .unwrap();

        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);

        (
            DeviceState::new(
                &dir,
                Box::new(move |event| seen.lock().unwrap().push(event)),
            ),
            dir,
            events,
        )
    }

    fn call(tool: &str, input: Value) -> Signed {
        envelope::sign_value(
            &secret(),
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": "c1", "deviceId": "dev1", "tool": tool,
                "input": input, "threadId": "t1", "threadTitle": "T", "taintedBy": [],
                "issuedAt": 1, "expiresAt": now_ms() + 60_000, "nonce": "n1"
            }),
        )
    }

    fn start_input(agent: &str, folder: &str) -> Value {
        json!({ "sessionId": "s1", "threadId": "t1", "agentKey": agent, "folderId": folder })
    }

    fn result_of(signed: &Signed) -> Value {
        serde_json::from_str(&signed.payload).unwrap()
    }

    #[test]
    fn a_valid_signature_for_an_unapproved_pair_is_refused() {
        let (state, dir, _) = state("unapproved");

        for input in [
            start_input("claude", "someone-elses-folder"),
            start_input("other-agent", "f1"),
        ] {
            let signed = call("acp_start", input);
            let prepared = state.acp_prepare(&signed).unwrap();

            assert!(prepared.command.is_none());
            assert_eq!(
                prepared.refusal.as_deref(),
                Some("not approved on this computer")
            );

            let result = result_of(
                &state
                    .acp_sign(&signed, prepared.refusal.as_deref().unwrap())
                    .unwrap(),
            );

            assert_eq!(result["status"], "failed");
            assert_eq!(result["error"], "refused: not approved on this computer");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_approved_pair_yields_a_start_with_the_path_from_the_approval() {
        let (state, dir, _) = state("approved");
        let prepared = state
            .acp_prepare(&call("acp_start", start_input("claude", "f1")))
            .unwrap();

        assert_eq!(
            prepared.command,
            Some(AcpCommand::Start {
                agent_key: "claude".into(),
                agent_label: "Claude Code".into(),
                folder_id: "f1".into(),
                folder_label: "neore".into(),
                folder_path: "/home/me/neore".into(),
                session_id: "s1".into(),
                thread_id: "t1".into(),
            })
        );
        assert_eq!(prepared.call_id, "c1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_start_cannot_carry_its_own_path() {
        let (state, dir, _) = state("no-path");
        let mut input = start_input("claude", "f1");

        input["folderPath"] = json!("/etc");

        let prepared = state.acp_prepare(&call("acp_start", input)).unwrap();

        assert!(matches!(
            prepared.command,
            Some(AcpCommand::Start { ref folder_path, .. }) if folder_path == "/home/me/neore"
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_redelivered_call_prepares_again_because_no_nonce_is_spent() {
        let (state, dir, _) = state("redelivery");
        let signed = call(
            "acp_send",
            json!({ "sessionId": "s1", "turnId": "u1", "text": "hi" }),
        );

        assert!(state.acp_prepare(&signed).unwrap().command.is_some());
        assert!(state.acp_prepare(&signed).unwrap().command.is_some());
        assert_eq!(
            result_of(&state.acp_sign(&signed, "accepted").unwrap())["status"],
            "completed"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commands_name_what_they_act_on_or_are_refused() {
        let (state, dir, _) = state("malformed");

        for (tool, input) in [
            ("acp_cancel", json!({ "sessionId": "s1" })),
            (
                "acp_send",
                json!({ "sessionId": "s1", "turnId": "u1", "text": "  " }),
            ),
            ("acp_send", json!({ "sessionId": "s1", "turnId": "u1" })),
            (
                "acp_permission_answer",
                json!({ "sessionId": "s1", "requestId": "r1" }),
            ),
            ("acp_start", json!({ "sessionId": "s1" })),
        ] {
            let prepared = state.acp_prepare(&call(tool, input)).unwrap();

            assert!(prepared.command.is_none(), "{tool}");
            assert!(prepared.refusal.is_some(), "{tool}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cancel_keeps_the_queue_only_when_it_says_so() {
        let (state, dir, _) = state("keep-queue");

        for (input, keep) in [
            (json!({ "sessionId": "s1", "turnId": "u1" }), false),
            (
                json!({ "sessionId": "s1", "turnId": "u1", "keepQueue": false }),
                false,
            ),
            (
                json!({ "sessionId": "s1", "turnId": "u1", "keepQueue": "yes" }),
                false,
            ),
            (
                json!({ "sessionId": "s1", "turnId": "u1", "keepQueue": true }),
                true,
            ),
        ] {
            let prepared = state.acp_prepare(&call("acp_cancel", input)).unwrap();

            assert_eq!(
                prepared.command,
                Some(AcpCommand::Cancel {
                    keep_queue: keep,
                    session_id: "s1".into(),
                    turn_id: "u1".into()
                })
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_device_tool_or_a_call_for_another_device_is_not_a_command() {
        let (state, dir, _) = state("not-a-command");

        assert!(state.acp_prepare(&call("fs_read", json!({}))).is_err());

        let other = envelope::sign_value(
            &secret(),
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": "c1", "deviceId": "dev2", "tool": "acp_cancel",
                "input": { "sessionId": "s1", "turnId": "u1" }, "threadId": "t1", "threadTitle": "T",
                "taintedBy": [], "issuedAt": 1, "expiresAt": now_ms() + 60_000, "nonce": "n1"
            }),
        );

        assert!(state.acp_prepare(&other).is_err());
        assert!(state.acp_sign(&other, "accepted").is_err());
        // The generic path refuses them too, so a command cannot be run as a tool.
        assert!(state
            .execute(&call(
                "acp_cancel",
                json!({ "sessionId": "s1", "turnId": "u1" })
            ))
            .is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsigned_or_expired_command_is_refused() {
        let (state, dir, _) = state("expired");
        let mut forged = call("acp_cancel", json!({ "sessionId": "s1", "turnId": "u1" }));

        forged.signature = "0".repeat(64);
        assert!(state.acp_prepare(&forged).is_err());

        let expired = envelope::sign_value(
            &secret(),
            Domain::Call,
            &json!({
                "v": 1, "kind": "call", "callId": "c1", "deviceId": "dev1", "tool": "acp_cancel",
                "input": { "sessionId": "s1", "turnId": "u1" }, "threadId": "t1", "threadTitle": "T",
                "taintedBy": [], "issuedAt": 1, "expiresAt": 2, "nonce": "n1"
            }),
        );

        assert!(state.acp_prepare(&expired).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_manifest_offers_labels_and_ids_never_a_path() {
        let (state, dir, _) = state("offers");
        let offers = state.acp_offers();

        assert_eq!(
            offers,
            vec![json!({
                "agentKey": "claude", "agentLabel": "Claude Code", "folderId": "f1", "folderLabel": "neore"
            })]
        );
        assert!(!serde_json::to_string(&offers).unwrap().contains("/home/me"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_remote_answer_closes_the_local_prompt_and_a_second_one_is_already_answered() {
        use crate::acp_permission::{OfferedOption, PermissionRequest, ALREADY_ANSWERED};

        let (state, dir, events) = state("remote-answer");
        let state = Arc::new(state);
        let waiting = Arc::clone(&state);
        let handle = std::thread::spawn(move || {
            waiting.acp_permission_ask(PermissionRequest {
                agent_label: "Claude Code".into(),
                command: None,
                details: "{}".into(),
                details_complete: true,
                folder: "neore".into(),
                options: vec![OfferedOption {
                    kind: "allow_once".into(),
                    name: "Yes".into(),
                    option_id: "y".into(),
                }],
                request_id: "r1".into(),
                session_id: "s1".into(),
                target: None,
                tool: "Run tests".into(),
                tool_kind: "execute".into(),
            })
        });

        // The prompt is showing.
        while state.acp_permissions().is_empty() {
            std::thread::yield_now();
        }

        state.acp_permission_answer_remote("s1", "r1", "y").unwrap();

        assert!(state.acp_permissions().is_empty());
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::AcpPermissionsChanged)));
        assert_eq!(
            handle.join().unwrap(),
            crate::acp_permission::Outcome::Selected {
                option_id: "y".into()
            }
        );
        assert_eq!(
            state
                .acp_permission_answer_remote("s1", "r1", "y")
                .unwrap_err(),
            ALREADY_ANSWERED
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
