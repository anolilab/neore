//! N-API addon around `device-core`, for the Electron shell (`apps/desktop`).
//!
//! The surface is what the shell needs and nothing more: pairing, the servers
//! reached over SSH, the signed manifest, executing one relayed call, the local
//! approval and settings commands, and the audit tail. Envelope signing and verification are not
//! exported; they happen inside `execute`, `pair` and `manifest`.
//!
//! Structured values cross as JSON strings (the Rust serde types are the one
//! definition of the wire shape). Blocking work (a prompt can wait five
//! minutes, a shell command runs for up to ten) runs on tokio's blocking pool,
//! not libuv's four threads, and every promise settles: a panic or join error
//! rejects it.

use std::sync::Arc;

use device_core::acp::AcpUpdate;
use device_core::acp_install::InstallRequest;
use device_core::acp_permission::PermissionRequest;
use device_core::engine::{HostSpec, SettingsUpdate};
use device_core::envelope::Signed;
use device_core::install::{Bundle, Root};
use device_core::{DeviceState, Event};
use napi::bindgen_prelude::{
    spawn_blocking, Env, Error, Function, PromiseRaw, Result, ToNapiValue,
};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;

/// The highest integer a JS number holds exactly; prompt ids stay far below it.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn to_json<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|error| Error::from_reason(error.to_string()))
}

/// Runs `task` on the blocking pool and settles the promise with its result.
fn blocking<'env, T, F>(env: &'env Env, task: F) -> Result<PromiseRaw<'env, T>>
where
    T: 'static + Send + ToNapiValue,
    F: FnOnce() -> std::result::Result<T, String> + Send + 'static,
{
    env.spawn_future(async move {
        spawn_blocking(task)
            .await
            .map_err(|error| Error::from_reason(format!("device task failed: {error}")))?
            .map_err(Error::from_reason)
    })
}

/// A request id from JS: an exact positive integer.
fn request_id(id: f64) -> Result<u64> {
    if id.fract() == 0.0 && (1.0..=MAX_SAFE_INTEGER).contains(&id) {
        Ok(id as u64)
    } else {
        Err(Error::from_reason("invalid request id"))
    }
}

#[napi]
pub struct DeviceCore {
    state: Arc<DeviceState>,
}

#[napi]
impl DeviceCore {
    /// `dataDir` holds `device.json` and the audit log. `onEvent` receives a JSON
    /// string per engine event: `{"type":"prompt","prompt":…}`,
    /// `{"type":"progress",…}` or `{"type":"changed"}`. It is called from engine
    /// threads and must not block. `hostBundle` is the folder with the `neore-host` binaries this build ships and
    /// their checksums; without it a server's host software cannot be installed from here.
    #[napi(constructor)]
    pub fn new(
        data_dir: String,
        on_event: Function<String, ()>,
        host_bundle: Option<String>,
    ) -> Result<Self> {
        // Weak: the sink never keeps the Node process alive by itself.
        let sink = on_event
            .build_threadsafe_function::<String>()
            .callee_handled::<false>()
            .weak::<true>()
            .build_callback(|context| Ok(context.value))?;
        let state = DeviceState::new(
            std::path::Path::new(&data_dir),
            Box::new(move |event: Event| {
                if let Ok(json) = serde_json::to_string(&event) {
                    let _ = sink.call(json, ThreadsafeFunctionCallMode::NonBlocking);
                }
            }),
        );
        // A bundle that cannot be read is kept as the reason an install is refused, not as a failure to start.
        let state = match host_bundle {
            Some(folder) => {
                state.with_host_bundle(Bundle::load(std::path::Path::new(&folder)), Root::Home)
            }
            None => state,
        };

        let state = Arc::new(state);

        // Reconnects a server the user connected when its link drops, and reaps what a lost session left running.
        state.supervise();

        Ok(DeviceCore { state })
    }

    /// `{ accountLabel, deviceId, platform }` (JSON).
    #[napi]
    pub fn status(&self) -> Result<String> {
        to_json(&self.state.status())
    }

    /// Stores the pairing once the user confirms it in the approval window.
    /// Resolves `false` when declined or unanswered.
    #[napi]
    pub fn pair<'env>(
        &self,
        env: &'env Env,
        device_id: String,
        secret: String,
        account_label: String,
    ) -> Result<PromiseRaw<'env, bool>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || state.pair(&device_id, &secret, &account_label))
    }

    /// The signed tool manifest (`{ payload, signature }`, JSON): this computer's, or the named server's, which
    /// is signed with that server's own secret.
    #[napi]
    pub fn manifest<'env>(
        &self,
        env: &'env Env,
        device_id: Option<String>,
    ) -> Result<PromiseRaw<'env, String>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let signed = state.manifest_for(device_id.as_deref())?;

            serde_json::to_string(&signed).map_err(|error| error.to_string())
        })
    }

    /// Signs one turn post for the backend's ingest route (hex HMAC under the `turn` domain). Refuses a payload
    /// that is not a turn post for this paired computer, so it cannot sign anything else.
    #[napi]
    pub fn sign_turn(&self, payload: String) -> Result<String> {
        self.state.sign_turn(&payload).map_err(Error::from_reason)
    }

    /// Verifies, asks about (through `onEvent`), runs and signs one relayed call.
    /// Resolves the signed result (`{ payload, signature }`, JSON).
    #[napi]
    pub fn execute<'env>(
        &self,
        env: &'env Env,
        envelope: String,
        signature: String,
    ) -> Result<PromiseRaw<'env, String>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let signed = state.execute(&Signed {
                payload: envelope,
                signature,
            })?;

            serde_json::to_string(&signed).map_err(|error| error.to_string())
        })
    }

    /// Connects a server that is not paired yet, asking the person at the local window to trust its key and for a
    /// key passphrase. Resolves what the server reported (`{ platform, sandboxAvailable, … }`, JSON).
    #[napi]
    pub fn host_probe<'env>(
        &self,
        env: &'env Env,
        spec: String,
    ) -> Result<PromiseRaw<'env, String>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let spec: HostSpec = serde_json::from_str(&spec).map_err(|_| "invalid server")?;
            let probe = state.host_probe(&spec)?;

            serde_json::to_string(&probe).map_err(|error| error.to_string())
        })
    }

    /// Stores the probed server as a device of its own, with the secret the backend minted for it, once the user
    /// confirms it in the local window. Resolves `false` when declined.
    #[napi]
    pub fn host_pair<'env>(
        &self,
        env: &'env Env,
        spec: String,
        device_id: String,
        secret: String,
    ) -> Result<PromiseRaw<'env, bool>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let spec: HostSpec = serde_json::from_str(&spec).map_err(|_| "invalid server")?;

            state.host_pair(&spec, &device_id, &secret)
        })
    }

    /// Connects a paired server, or tries again once reconnecting gave up; from then on a lost link is retried in the background. Resolves what the server reported (JSON).
    #[napi]
    pub fn host_connect<'env>(
        &self,
        env: &'env Env,
        device_id: String,
    ) -> Result<PromiseRaw<'env, String>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let probe = state.host_connect(&device_id)?;

            serde_json::to_string(&probe).map_err(|error| error.to_string())
        })
    }

    /// The `ssh` arguments of an interactive shell on a paired server (a JSON array), once it is connected and its
    /// key is trusted. The desktop runs `ssh` with them on a pseudo-terminal.
    #[napi]
    pub fn host_terminal<'env>(
        &self,
        env: &'env Env,
        device_id: String,
    ) -> Result<PromiseRaw<'env, String>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let args = state.host_terminal(&device_id)?;

            serde_json::to_string(&args).map_err(|error| error.to_string())
        })
    }

    /// The same arguments for a new shell on a connection that is still up. Never connects; rejects when it is not.
    #[napi]
    pub fn host_terminal_attach<'env>(
        &self,
        env: &'env Env,
        device_id: String,
    ) -> Result<PromiseRaw<'env, String>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let args = state.host_terminal_attach(&device_id)?;

            serde_json::to_string(&args).map_err(|error| error.to_string())
        })
    }

    /// Installs the pinned `neore-host` on a paired server and removes its other versions; refused while a session
    /// is open to it. Resolves `{ alreadyCurrent, version }` (JSON).
    #[napi]
    pub fn host_upgrade<'env>(
        &self,
        env: &'env Env,
        device_id: String,
    ) -> Result<PromiseRaw<'env, String>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let report = state.host_upgrade(&device_id)?;

            serde_json::to_string(&report).map_err(|error| error.to_string())
        })
    }

    #[napi]
    pub fn host_disconnect(&self, device_id: String) {
        self.state.host_disconnect(&device_id);
    }

    /// Forgets a server on this computer: its secret, folders and connection.
    #[napi]
    pub fn host_remove(&self, device_id: String) -> Result<()> {
        self.state
            .host_remove(&device_id)
            .map_err(Error::from_reason)
    }

    /// Drops a server's pinned host key so the next connection asks again.
    #[napi]
    pub fn host_forget_key(&self, device_id: String) -> Result<()> {
        self.state
            .host_forget_key(&device_id)
            .map_err(Error::from_reason)
    }

    /// The prompt the approval window should show (JSON), or `null`.
    #[napi]
    pub fn prompt_current(&self) -> Result<Option<String>> {
        match self.state.prompt_current() {
            Some(prompt) => to_json(&prompt).map(Some),
            None => Ok(None),
        }
    }

    /// Answers one prompt: `deny`, `once` or `always`.
    #[napi]
    pub fn prompt_answer(&self, id: f64, answer: String) -> Result<()> {
        // JS numbers are doubles: accept only exact positive integers.
        if !(id.fract() == 0.0 && (1.0..=MAX_SAFE_INTEGER).contains(&id)) {
            return Err(Error::from_reason("invalid prompt id"));
        }

        self.state
            .prompt_answer(id as u64, &answer)
            .map_err(Error::from_reason)
    }

    /// Answers a passphrase prompt with what the user typed. Not a plain answer: the text goes to ssh and nowhere
    /// else, and is never part of a prompt, an event or a log.
    #[napi]
    pub fn prompt_secret(&self, id: f64, secret: String) -> Result<()> {
        if !(id.fract() == 0.0 && (1.0..=MAX_SAFE_INTEGER).contains(&id)) {
            return Err(Error::from_reason("invalid prompt id"));
        }

        self.state
            .prompt_secret(id as u64, secret)
            .map_err(Error::from_reason)
    }

    /// Denies every prompt still waiting. Call when the approval window closes.
    #[napi]
    pub fn deny_prompts(&self) {
        self.state.deny_prompts();
    }

    /// The shared folders, rules, servers and sandbox setting (JSON).
    #[napi]
    pub fn settings_get(&self) -> Result<String> {
        to_json(&self.state.settings_view())
    }

    /// Applies a `SettingsUpdate` (JSON). Validation is in Rust.
    #[napi]
    pub fn settings_update(&self, update: String) -> Result<String> {
        let update: SettingsUpdate = serde_json::from_str(&update)
            .map_err(|_| Error::from_reason("invalid settings update"))?;
        let view = self
            .state
            .settings_update(update)
            .map_err(Error::from_reason)?;

        to_json(&view)
    }

    /// The registered coding agents and the names of their environment variables, never the values (JSON).
    #[napi]
    pub fn acp_view(&self) -> Result<String> {
        to_json(&self.state.acp_view())
    }

    /// Applies an `AcpUpdate` (JSON): save or remove an agent, set or remove a variable. Validation is in Rust.
    #[napi]
    pub fn acp_update(&self, update: String) -> Result<String> {
        // The update can carry a variable's value; a parse error must not quote it.
        let update: AcpUpdate = serde_json::from_str(&update)
            .map_err(|_| Error::from_reason("invalid agent update"))?;
        let view = self.state.acp_update(update).map_err(Error::from_reason)?;

        to_json(&view)
    }

    /// A fresh folder for one registry download (its path). Only a file inside it can be installed.
    #[napi]
    pub fn acp_install_stage(&self) -> Result<String> {
        self.state.acp_install_stage().map_err(Error::from_reason)
    }

    /// Verifies a downloaded registry archive against its published SHA-256, unpacks it, and registers the agent
    /// with its pinned version (`InstallRequest`, JSON). Not reachable through `acp_update`. Validation is in Rust.
    #[napi]
    pub fn acp_install(&self, request: String) -> Result<String> {
        // The request can carry variable values; a parse error must not quote them.
        let request: InstallRequest = serde_json::from_str(&request)
            .map_err(|_| Error::from_reason("invalid install request"))?;
        let view = self
            .state
            .acp_install(request)
            .map_err(Error::from_reason)?;

        to_json(&view)
    }

    /// Deletes the installed versions of an agent other than the pinned one. Run it after closing the sessions
    /// the install took the approval from.
    #[napi]
    pub fn acp_install_prune(&self, agent_key: String) {
        self.state.acp_install_prune(&agent_key);
    }

    /// What to spawn for an agent (JSON): command, arguments, folder and environment. `folder` absent is a
    /// version probe. The environment holds secrets: it goes to the main process and nowhere else.
    #[napi]
    pub fn acp_spawn_plan(&self, agent_key: String, folder: Option<String>) -> Result<String> {
        let plan = self
            .state
            .acp_spawn_plan(&agent_key, folder.as_deref())
            .map_err(Error::from_reason)?;

        to_json(&plan)
    }

    /// Registers a permission request from a coding agent and resolves with the outcome the agent receives
    /// (JSON `{"outcome":"selected","optionId":…}` or `{"outcome":"cancelled"}`) once the user has answered it
    /// in the device window, the session was cancelled, or the request timed out.
    #[napi]
    pub fn acp_permission_ask<'env>(
        &self,
        env: &'env Env,
        request: String,
    ) -> Result<PromiseRaw<'env, String>> {
        let request: PermissionRequest = serde_json::from_str(&request)
            .map_err(|_| Error::from_reason("invalid permission request"))?;
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            serde_json::to_string(&state.acp_permission_ask(request))
                .map_err(|error| error.to_string())
        })
    }

    /// The coding-agent requests waiting for the device window (JSON). No "always" option is listed.
    #[napi]
    pub fn acp_permissions(&self) -> Result<String> {
        to_json(&self.state.acp_permissions())
    }

    /// Answers one request with the agent's own option id. Only "allow once" and "reject once" are accepted.
    #[napi]
    pub fn acp_permission_answer(&self, id: f64, option_id: String) -> Result<()> {
        self.state
            .acp_permission_answer(request_id(id)?, &option_id)
            .map_err(Error::from_reason)
    }

    /// Says no to one request.
    #[napi]
    pub fn acp_permission_decline(&self, id: f64) -> Result<()> {
        self.state
            .acp_permission_decline(request_id(id)?)
            .map_err(Error::from_reason)
    }

    /// Allows exactly the named requests, each once. Resolves how many it answered.
    #[napi]
    pub fn acp_permission_answer_batch(&self, ids: Vec<f64>) -> Result<u32> {
        let ids = ids
            .into_iter()
            .map(request_id)
            .collect::<Result<Vec<u64>>>()?;

        self.state
            .acp_permission_answer_batch(&ids)
            .map(|answered| answered as u32)
            .map_err(Error::from_reason)
    }

    /// Answers every waiting request of one session cancelled. Call when the session is cancelled or ends.
    #[napi]
    pub fn acp_permission_cancel_session(&self, session_id: String) {
        self.state.acp_permission_cancel_session(&session_id);
    }

    /// Checks one relayed coding-agent command (`acp_start`, `acp_send`, `acp_cancel`, `acp_permission_answer`)
    /// without acting on it or spending its nonce (JSON `{ callId, expiresAt, command, refusal }`). The main process
    /// writes its receipt, acts on `command`, then asks for the result with `acp_sign`.
    #[napi]
    pub fn acp_prepare(&self, envelope: String, signature: String) -> Result<String> {
        let prepared = self
            .state
            .acp_prepare(&Signed {
                payload: envelope,
                signature,
            })
            .map_err(Error::from_reason)?;

        to_json(&prepared)
    }

    /// The signed result of a coding-agent command: `accepted`, or the reason it was not carried out
    /// (`{ payload, signature }`, JSON).
    #[napi]
    pub fn acp_sign(&self, envelope: String, signature: String, outcome: String) -> Result<String> {
        let signed = self
            .state
            .acp_sign(
                &Signed {
                    payload: envelope,
                    signature,
                },
                &outcome,
            )
            .map_err(Error::from_reason)?;

        to_json(&signed)
    }

    /// Answers the coding-agent request the backend named, under the device window's rules. Throws
    /// `already_answered` when it is no longer waiting.
    #[napi]
    pub fn acp_permission_answer_remote(
        &self,
        session_id: String,
        request_id: String,
        option_id: String,
    ) -> Result<()> {
        self.state
            .acp_permission_answer_remote(&session_id, &request_id, &option_id)
            .map_err(Error::from_reason)
    }

    /// The most recent audit lines, newest first (each a JSON object).
    #[napi]
    pub fn audit_tail(&self) -> Vec<String> {
        self.state.audit_tail()
    }

    /// Stops local MCP servers idle for ten minutes. Call about once a minute. Resolves when the sweep is done, and
    /// runs on the blocking pool: a server that is mid-call holds its lock, and the main thread must not wait for it.
    #[napi]
    pub fn reap_idle_servers<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, bool>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            state.reap_idle_servers();

            Ok(true)
        })
    }

    /// Stops every local MCP server. Call on quit.
    #[napi]
    pub fn stop(&self) {
        self.state.stop_servers();
    }
}
