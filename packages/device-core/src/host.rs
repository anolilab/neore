//! `neore-host`: the headless executor behind the desktop. It reads framed requests on stdin, runs the
//! file and shell actions the desktop already verified and approved, and answers on stdout (`frame.rs`).
//!
//! It trusts exactly that pipe. It never sees a signed call, a prompt, a pairing or a keychain, and it
//! binds no socket. What it enforces is what only the machine it runs on can: the shared folders each
//! request names (with the home guard checked against its own `$HOME`) and the sandbox this machine
//! supports. A `shell_run` that needs a sandbox this machine lacks is refused before anything spawns.
//!
//! The first frame it sends is the handshake, with the sandbox support the desktop's approval prompt
//! needs. Then one response per request, in completion order, matched by `id`.

use std::io::{self, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::actions::{
    self, cap_utf8, plan_builtin, shareable_roots, Outcome, ShellSettings, MAX_OUTPUT_BYTES,
    MAX_ROOTS,
};
use crate::frame::{read_frame, write_frame};
use crate::launch;
use crate::sandbox::{self, Support};

/// 2: the `reap` request.
pub const PROTOCOL_VERSION: u32 = 2;
/// Requests being served at once; a further one is refused, not queued behind a ten-minute command.
const MAX_IN_FLIGHT: usize = 8;

/// What the host sends: the handshake, one response per request, and events (none yet).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outgoing {
    Hello {
        platform: &'static str,
        protocol: u32,
        sandbox: SandboxReport,
        version: &'static str,
    },
    Response {
        id: u64,
        ok: bool,
        /// The action's outcome (`run`) or the reap report when `ok`. A failed action is still `ok`: its status
        /// says so.
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        /// Why the request itself could not be served, when not `ok`.
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Event {
        data: Value,
        name: String,
    },
}

/// Whether `shell_run` can be sandboxed on this machine, and by what or why not. `available` is what a
/// default request (sandbox required, network blocked) gets, so a machine with Landlock but no seccomp
/// filter reports why it would refuse.
#[derive(Serialize)]
pub struct SandboxReport {
    pub available: bool,
    pub detail: String,
}

impl SandboxReport {
    pub fn probe() -> Self {
        let support = sandbox::support();

        match (
            &support,
            sandbox::policy_for_call(&support, false, sandbox::NetworkTier::Off, &[], None),
        ) {
            (Support::Available(detail), Ok(_)) => SandboxReport {
                available: true,
                detail: detail.clone(),
            },
            (Support::Available(_), Err(reason)) => SandboxReport {
                available: false,
                detail: reason,
            },
            (Support::Unavailable(detail), _) => SandboxReport {
                available: false,
                detail: detail.clone(),
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Incoming {
    Request {
        id: u64,
        op: String,
        #[serde(default)]
        params: Value,
    },
}

/// One action to plan and run. Everything the host enforces comes from here; it keeps no configuration.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunParams {
    /// "Require sandbox for shell commands" turned OFF, stored inverted like the desktop's setting: a
    /// request that leaves it out requires a sandbox.
    #[serde(default)]
    pub allow_unsandboxed_shell: bool,
    /// "Allow network for shell commands" turned ON. Left out, the network is blocked where it can be.
    #[serde(default)]
    pub allow_shell_network: bool,
    pub input: Value,
    /// Milliseconds before the call expires.
    pub remaining_ms: u64,
    /// The shared folders for this call.
    pub roots: Vec<String>,
    pub tool: String,
}

/// Plans and runs one action on this machine. The desktop's engine does the same through
/// [`actions::plan_builtin`] and [`actions::run`], after its own checks.
pub fn run_request(params: RunParams) -> Outcome {
    run_request_from(params, Instant::now())
}

/// [`run_request`] for a request that arrived at `received`: the time spent waiting for a worker counts
/// against `remaining_ms`.
fn run_request_from(params: RunParams, received: Instant) -> Outcome {
    if params.roots.len() > MAX_ROOTS {
        return Outcome::failed(format!("at most {MAX_ROOTS} folders"));
    }

    let remaining = Duration::from_millis(params.remaining_ms).saturating_sub(received.elapsed());

    if remaining.is_zero() {
        return Outcome::failed("approved after the request expired");
    }

    // Without a home directory the home guard cannot be checked and a macOS sandbox would not hide it.
    if actions::canonical_home().is_none() {
        return Outcome::failed(
            "this machine's home directory is unknown, so the shared folders cannot be checked",
        );
    }

    let roots = shareable_roots(&params.roots);
    let shell = ShellSettings {
        allow_unsandboxed: params.allow_unsandboxed_shell,
        network: if params.allow_shell_network {
            sandbox::NetworkTier::On
        } else {
            sandbox::NetworkTier::Off
        },
    };

    match plan_builtin(&params.tool, &params.input, &roots, shell) {
        None => Outcome::failed(format!("{} is not a tool of this device", params.tool)),
        Some(Err(error)) => Outcome::failed(error),
        Some(Ok(action)) => capped(actions::run(action, &roots, remaining, None)),
    }
}

/// The caps the desktop's engine puts on every result, so the same call reads the same either way.
fn capped(mut outcome: Outcome) -> Outcome {
    if let Some(output) = outcome.output.take() {
        let (output, cut) = cap_utf8(&output, MAX_OUTPUT_BYTES);

        outcome.truncated |= cut;
        outcome.output = Some(output);
    }

    outcome.error = outcome
        .error
        .filter(|error| !error.is_empty())
        .map(|error| cap_utf8(&error, 1000).0);

    outcome
}

fn send<W: Write>(writer: &Mutex<W>, frame: &Outgoing) -> io::Result<()> {
    let bytes = serde_json::to_vec(frame).map_err(io::Error::other)?;

    write_frame(&mut *writer.lock().unwrap(), &bytes)
}

fn refuse(id: u64, error: impl Into<String>) -> Outgoing {
    Outgoing::Response {
        id,
        ok: false,
        result: None,
        error: Some(error.into()),
    }
}

/// The `reap` request: the launches to stop, by id.
#[derive(Deserialize)]
struct ReapParams {
    launches: Vec<String>,
}

fn serve_reap(params: Value, id: u64, own: Option<&str>) -> Outgoing {
    let Ok(params) = serde_json::from_value::<ReapParams>(params) else {
        return refuse(id, "invalid reap params");
    };
    let Some(dir) = launch::run_dir() else {
        return refuse(id, "this machine's home directory is unknown");
    };

    Outgoing::Response {
        id,
        ok: true,
        result: serde_json::to_value(launch::reap(&dir, &params.launches, own)).ok(),
        error: None,
    }
}

fn serve_request(
    op: &str,
    params: Value,
    id: u64,
    received: Instant,
    own: Option<&str>,
) -> Outgoing {
    if op == "reap" {
        return serve_reap(params, id, own);
    }

    if op != "run" {
        return refuse(id, format!("unknown op {op}"));
    }

    let Ok(params) = serde_json::from_value::<RunParams>(params) else {
        return refuse(id, "invalid run params");
    };

    match catch_unwind(AssertUnwindSafe(|| run_request_from(params, received))) {
        Ok(outcome) => Outgoing::Response {
            id,
            ok: true,
            result: serde_json::to_value(outcome).ok(),
            error: None,
        },
        Err(_) => refuse(id, "the host failed while running the action"),
    }
}

/// Decrements the in-flight count when a request ends, however it ends.
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Sends the handshake, then serves requests until `reader` ends. Each request runs on its own thread, so a
/// long command does not hold up a file read. `Ok` is the stream ending between frames; an error is a
/// broken stream or a request that is not a request, and the caller ends the connection on it. Either way
/// it returns only once the requests still running have finished: each run's own timeout is what stops a
/// command, so a host that went away first would leave the shell unsupervised.
pub fn serve<R, W>(reader: R, writer: W) -> io::Result<()>
where
    R: Read,
    W: Write + Send + 'static,
{
    serve_launch(reader, writer, None)
}

/// [`serve`] as the launch `own` (its id), which a `reap` request never stops.
pub fn serve_launch<R, W>(mut reader: R, writer: W, own: Option<&str>) -> io::Result<()>
where
    R: Read,
    W: Write + Send + 'static,
{
    let writer = Arc::new(Mutex::new(writer));
    let in_flight = Arc::new(AtomicUsize::new(0));
    let reply_failed = Arc::new(AtomicBool::new(false));
    let mut running = Vec::new();

    let served = serve_requests(
        &mut reader,
        &writer,
        &in_flight,
        &reply_failed,
        &mut running,
        own,
    );

    for request in running {
        let _ = request.join();
    }

    served
}

fn serve_requests<R, W>(
    reader: &mut R,
    writer: &Arc<Mutex<W>>,
    in_flight: &Arc<AtomicUsize>,
    reply_failed: &Arc<AtomicBool>,
    running: &mut Vec<thread::JoinHandle<()>>,
    own: Option<&str>,
) -> io::Result<()>
where
    R: Read,
    W: Write + Send + 'static,
{
    send(
        writer,
        &Outgoing::Hello {
            platform: actions::platform(),
            protocol: PROTOCOL_VERSION,
            sandbox: SandboxReport::probe(),
            version: env!("CARGO_PKG_VERSION"),
        },
    )?;

    while let Some(bytes) = read_frame(reader)? {
        let received = Instant::now();

        // A reply that could not be written means nobody reads the answers: stop running what is asked.
        if reply_failed.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "a reply could not be written",
            ));
        }

        let Incoming::Request { id, op, params } = serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

        if in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
            in_flight.fetch_sub(1, Ordering::SeqCst);
            send(writer, &refuse(id, "too many requests in flight"))?;

            continue;
        }

        let slot = Slot(Arc::clone(in_flight));
        let writer = Arc::clone(writer);
        let reply_failed = Arc::clone(reply_failed);
        let own = own.map(str::to_owned);

        running.retain(|request| !request.is_finished());
        running.push(thread::spawn(move || {
            let _slot = slot;

            // The reader sees the flag on its next frame, or its own EOF if the desktop is gone.
            if send(
                &writer,
                &serve_request(&op, params, id, received, own.as_deref()),
            )
            .is_err()
            {
                reply_failed.store(true, Ordering::SeqCst);
            }
        }));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_result_is_capped_like_the_desktops() {
        let mut outcome = Outcome::completed("é".repeat(MAX_OUTPUT_BYTES));

        outcome.error = Some("x".repeat(2000));

        let outcome = capped(outcome);

        assert!(outcome.truncated);
        assert!(outcome.output.unwrap().len() <= MAX_OUTPUT_BYTES);
        assert_eq!(outcome.error.unwrap().len(), 1000);
    }

    #[test]
    fn a_request_that_waited_past_its_budget_is_not_run() {
        let params = RunParams {
            allow_unsandboxed_shell: false,
            allow_shell_network: false,
            input: serde_json::json!({}),
            remaining_ms: 1,
            roots: Vec::new(),
            tool: "fs_list".to_owned(),
        };
        let received = Instant::now() - Duration::from_secs(1);
        let outcome = run_request_from(params, received);

        assert_eq!(outcome.status, "failed");
        assert_eq!(
            outcome.error.as_deref(),
            Some("approved after the request expired")
        );
    }
}
