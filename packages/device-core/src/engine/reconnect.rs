//! Keeping a server connected: noticing a lost link, trying again in the background and reaping what a lost
//! session left running (`lifecycle.rs` holds the policy, `launch.rs` the host's side).
//!
//! A server is kept only once the person connected it, and only until they disconnect it. A background attempt
//! asks nobody anything: no passphrase, no trust prompt. A login that needs one stops the retrying and waits for a
//! Retry, so a locked agent never turns into a prompt every minute.

use std::thread;
use std::time::Instant;

use super::hosts::target_of;
use super::*;
use crate::lifecycle::{self, Keep, Phase, ATTEMPT_PATIENCE, MAX_ATTEMPTS};
use crate::ssh::{HostLink, SshError};

/// How often a lost link is looked for.
const TICK: Duration = Duration::from_secs(1);

/// Why a connection did not happen, and whether another try later can help.
#[derive(Debug)]
pub(super) struct ConnectError {
    pub message: String,
    pub retryable: bool,
}

impl From<SshError> for ConnectError {
    fn from(error: SshError) -> Self {
        ConnectError {
            retryable: error.retryable(),
            message: error.to_string(),
        }
    }
}

impl From<String> for ConnectError {
    fn from(message: String) -> Self {
        ConnectError {
            message,
            retryable: false,
        }
    }
}

impl From<ConnectError> for String {
    fn from(error: ConnectError) -> Self {
        error.message
    }
}

impl From<&str> for ConnectError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

/// Where a server that should be connected is not, for the window.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectView {
    /// The attempt in the window, once one is scheduled or running.
    pub attempt: Option<u32>,
    pub max_attempts: u32,
    /// When the next attempt starts, as milliseconds since the epoch.
    pub next_attempt_at: Option<u64>,
    /// `waiting`, `connecting` or `gaveUp`.
    pub phase: &'static str,
    /// Why it gave up.
    pub reason: Option<String>,
}

/// Who is connecting. The person's attempt may ask questions and starts the keeping; the keeper's runs silent and
/// carries the disconnect count it was scheduled under, so a disconnect that lands after that is noticed.
#[derive(Clone, Copy)]
pub(super) enum Attempt {
    Manual,
    Background { disconnects: u64 },
}

/// A server's attempt slot, released when the attempt ends, however it ends.
pub(super) struct AttemptGuard {
    attempting: Arc<Mutex<HashSet<String>>>,
    device_id: String,
}

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        self.attempting.lock().unwrap().remove(&self.device_id);
    }
}

impl DeviceState {
    /// Starts the thread that notices lost links and reconnects them. It holds the engine weakly and ends with it.
    pub fn supervise(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);

        let _ = thread::Builder::new()
            .name("neore-host-keeper".into())
            .spawn(move || loop {
                thread::sleep(TICK);

                let Some(state) = weak.upgrade() else { return };

                state.reconnect_tick(Instant::now());
            });
    }

    /// One look at every kept server: a link seen dead is cleaned up and an attempt scheduled, and an attempt that
    /// is due starts on a thread of its own. A server whose attempt slot is taken (the person is connecting it) is
    /// left alone, so the cleanup of a dead link never ends a master a fresh attempt is using.
    pub(super) fn reconnect_tick(self: &Arc<Self>, now: Instant) {
        let hosts = self.settings().hosts;
        let mut changed = false;
        let mut dead: Vec<(String, Arc<dyn HostLink>)> = Vec::new();
        let mut start: Vec<(String, AttemptGuard, u64)> = Vec::new();
        let mut held: Vec<AttemptGuard> = Vec::new();

        {
            let mut keeps = self.ssh.keeps.lock().unwrap();

            keeps.retain(|id, _| hosts.iter().any(|host| host.device_id == *id));

            for host in &hosts {
                let Some(keep) = keeps.get_mut(&host.device_id) else {
                    continue;
                };
                let link = self.connection(&host.device_id);

                if link.as_ref().is_some_and(|link| link.is_alive()) {
                    if *keep.phase() != Phase::Connected {
                        keep.up();
                        changed = true;
                    }

                    continue;
                }

                let Some(slot) = self.begin_attempt(&host.device_id) else {
                    continue;
                };

                if keep.lost(now) {
                    changed = true;
                }

                if let Some(link) = link {
                    dead.push((host.device_id.clone(), link));
                }

                // The count is read under the keeps lock, which a disconnect takes right after counting.
                let disconnects = self.ssh.disconnects.load(Ordering::SeqCst);

                if !self.upgrade_running(&target_of(host)) && keep.due(now).is_some() {
                    start.push((host.device_id.clone(), slot, disconnects));
                    changed = true;
                } else {
                    // Held until the dead link is gone, then released.
                    held.push(slot);
                }
            }
        }

        // The old session ends before anything new starts, so a reconnect never has an old and a new session
        // alive together.
        for (id, link) in dead {
            let removed = {
                let mut connections = self.ssh.connections.lock().unwrap();

                if connections.get(&id).is_some_and(|current| {
                    std::ptr::addr_eq(Arc::as_ptr(current), Arc::as_ptr(&link))
                }) {
                    connections.remove(&id)
                } else {
                    None
                }
            };

            if removed.is_some() {
                self.retire_lost(&link);
            }
        }

        drop(held);

        if changed {
            self.emit(Event::Changed);
        }

        for (id, slot, disconnects) in start {
            let state = Arc::clone(self);

            thread::spawn(move || {
                let result = state.connect_host(&id, Attempt::Background { disconnects }, &slot);

                state.attempt_done(&id, result.map(|_| ()));
            });
        }
    }

    fn attempt_done(&self, device_id: &str, result: Result<(), ConnectError>) {
        {
            let mut keeps = self.ssh.keeps.lock().unwrap();

            if let Some(keep) = keeps.get_mut(device_id) {
                match result {
                    Ok(()) => keep.up(),
                    Err(error) => keep.failed(Instant::now(), error.retryable, &error.message),
                }
            }
        }

        self.emit(Event::Changed);
    }

    /// Takes the server's attempt slot, or `None` while another attempt (the person's or the keeper's) has it.
    pub(super) fn begin_attempt(&self, device_id: &str) -> Option<AttemptGuard> {
        self.ssh
            .attempting
            .lock()
            .unwrap()
            .insert(device_id.to_owned())
            .then(|| AttemptGuard {
                attempting: Arc::clone(&self.ssh.attempting),
                device_id: device_id.to_owned(),
            })
    }

    /// The person is connecting by hand. A kept server counts the attempt, or starts over on `retry`; `Err` when
    /// the window has no attempts left for a page to use.
    pub(super) fn keep_manual(&self, device_id: &str, retry: bool) -> Result<(), String> {
        match self.ssh.keeps.lock().unwrap().get_mut(device_id) {
            Some(keep) => keep.manual(retry, Instant::now()),
            None => Ok(()),
        }
    }

    /// A connection by hand failed. A server that was kept waits for the next Retry.
    pub(super) fn keep_failed(&self, device_id: &str, error: &ConnectError) {
        if let Some(keep) = self.ssh.keeps.lock().unwrap().get_mut(device_id) {
            keep.failed(Instant::now(), false, &error.message);
        }
    }

    /// A server is connected over `link`: keep it connected, remember the launch and stop the earlier launches of
    /// this computer that a lost session left running there. Only a connection the person made (`create`) starts
    /// the keeping; `false` means a background attempt found nobody keeping the server any more.
    pub(super) fn note_connected(
        &self,
        device_id: &str,
        link: &Arc<dyn HostLink>,
        create: bool,
    ) -> bool {
        {
            let mut keeps = self.ssh.keeps.lock().unwrap();

            if create {
                keeps
                    .entry(device_id.to_owned())
                    .or_insert_with(Keep::connected);
            }

            match keeps.get_mut(device_id) {
                Some(keep) => keep.up(),
                None => return false,
            }
        }

        let Some(current) = link.launch_id() else {
            return true;
        };
        let stale: Vec<String> = {
            let mut launches = self.ssh.launches.lock().unwrap();
            let known = launches.entry(device_id.to_owned()).or_default();
            let stale = known.iter().filter(|id| *id != current).cloned().collect();

            lifecycle::remember(known, current);

            stale
        };

        if stale.is_empty() {
            return true;
        }

        // A failed request leaves them recorded for the next connection.
        if let Ok(reaped) = link.reap(&stale) {
            if let Some(known) = self.ssh.launches.lock().unwrap().get_mut(device_id) {
                known.retain(|id| !reaped.stopped.contains(id) && !reaped.gone.contains(id));
            }
        }

        true
    }

    /// The person disconnected, removed or unpaired a server: it is no longer kept.
    pub(super) fn keep_forget(&self, device_id: &str) {
        self.ssh.keeps.lock().unwrap().remove(device_id);
    }

    pub(super) fn keep_forget_all(&self) {
        self.ssh.keeps.lock().unwrap().clear();
    }

    /// Where a kept server stands, when it is not simply connected.
    pub(super) fn reconnect_view(&self, device_id: &str) -> Option<ReconnectView> {
        let keeps = self.ssh.keeps.lock().unwrap();
        let keep = keeps.get(device_id)?;
        let now = Instant::now();
        let epoch = now_ms();

        match keep.phase() {
            Phase::Connected => None,
            Phase::Waiting { attempt, at } => Some(ReconnectView {
                attempt: Some(*attempt),
                max_attempts: MAX_ATTEMPTS,
                next_attempt_at: Some(epoch + at.saturating_duration_since(now).as_millis() as u64),
                phase: "waiting",
                reason: None,
            }),
            Phase::Connecting { attempt } => Some(ReconnectView {
                attempt: (*attempt > 0).then_some(*attempt),
                max_attempts: MAX_ATTEMPTS,
                next_attempt_at: None,
                phase: "connecting",
                reason: None,
            }),
            Phase::GaveUp { reason } => Some(ReconnectView {
                attempt: None,
                max_attempts: MAX_ATTEMPTS,
                next_attempt_at: None,
                phase: "gaveUp",
                reason: Some(reason.clone()),
            }),
        }
    }

    /// How long a background attempt may take to get a handshake.
    pub(super) fn attempt_patience(interactive: bool) -> Duration {
        if interactive {
            crate::ssh::CONNECT_PATIENCE
        } else {
            ATTEMPT_PATIENCE
        }
    }
}
