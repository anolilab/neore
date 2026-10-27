//! N-API addon around `device-core`, for the Electron shell (`apps/desktop`).
//!
//! The surface is what the shell needs and nothing more: pairing, the signed
//! manifest, executing one relayed call, the local approval and settings
//! commands, and the audit tail. Envelope signing and verification are not
//! exported; they happen inside `execute`, `pair` and `manifest`.
//!
//! Structured values cross as JSON strings (the Rust serde types are the one
//! definition of the wire shape). Blocking work (a prompt can wait five
//! minutes, a shell command runs for up to ten) runs on tokio's blocking pool,
//! not libuv's four threads, and every promise settles: a panic or join error
//! rejects it.

use std::sync::Arc;

use device_core::acp::AcpUpdate;
use device_core::engine::SettingsUpdate;
use device_core::envelope::Signed;
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

#[napi]
pub struct DeviceCore {
    state: Arc<DeviceState>,
}

#[napi]
impl DeviceCore {
    /// `dataDir` holds `device.json` and the audit log. `onEvent` receives a JSON
    /// string per engine event: `{"type":"prompt","prompt":…}`,
    /// `{"type":"progress",…}` or `{"type":"changed"}`. It is called from engine
    /// threads and must not block.
    #[napi(constructor)]
    pub fn new(data_dir: String, on_event: Function<String, ()>) -> Result<Self> {
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

        Ok(DeviceCore {
            state: Arc::new(state),
        })
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

    /// The signed tool manifest (`{ payload, signature }`, JSON).
    #[napi]
    pub fn manifest<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, String>> {
        let state = Arc::clone(&self.state);

        blocking(env, move || {
            let signed = state.manifest()?;

            serde_json::to_string(&signed).map_err(|error| error.to_string())
        })
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
