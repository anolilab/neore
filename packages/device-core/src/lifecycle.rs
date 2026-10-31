//! When a server's connection drops and the user did not end it, how this computer tries again.
//!
//! Pure bookkeeping, with the clock passed in: [`Keep`] says when the next attempt is due and when to stop, and the
//! engine (or a test) does the connecting. Attempts back off exponentially, at most [`MAX_ATTEMPTS`] in
//! [`WINDOW`], and then wait for the person: a Retry button, because a server that is down for an hour should not
//! be dialled all day, and a reconnect storm is what trips a server's connection limits and firewall.
//!
//! A failure that will not fix itself (a changed host key, a refused login, a passphrase nobody typed) skips the
//! backoff and waits for the person at once.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// The wait before the first attempt after a loss. Each failure doubles it.
pub const BASE_DELAY: Duration = Duration::from_secs(2);
pub const MAX_DELAY: Duration = Duration::from_secs(60);
/// At most this many attempts in [`WINDOW`], then a Retry button.
pub const MAX_ATTEMPTS: u32 = 5;
pub const WINDOW: Duration = Duration::from_secs(10 * 60);
/// How long a background attempt may take. The user's own connect can wait for a passphrase for longer.
pub const ATTEMPT_PATIENCE: Duration = Duration::from_secs(45);
/// The launches kept per server for [`remember`].
const MAX_LAUNCHES: usize = 16;

/// The attempts made lately and the failures in a row.
#[derive(Debug, Default)]
pub struct Backoff {
    attempts: VecDeque<Instant>,
    failures: u32,
}

impl Backoff {
    fn prune(&mut self, now: Instant) {
        while self
            .attempts
            .front()
            .is_some_and(|at| now.duration_since(*at) >= WINDOW)
        {
            self.attempts.pop_front();
        }
    }

    /// Counts an attempt that is starting now.
    pub fn attempt(&mut self, now: Instant) {
        self.prune(now);
        self.attempts.push_back(now);
    }

    /// The wait after a failed attempt (or a loss), or `None` when the window has no attempts left.
    pub fn delay(&mut self, now: Instant) -> Option<Duration> {
        self.prune(now);

        if self.attempts.len() as u32 >= MAX_ATTEMPTS {
            return None;
        }

        let wait = BASE_DELAY
            .saturating_mul(1 << self.failures.min(10))
            .min(MAX_DELAY);

        self.failures += 1;

        Some(wait)
    }

    /// The link is up: the next loss starts from the short wait, but the attempts stay counted, so a link that
    /// keeps dropping still reaches the limit.
    pub fn up(&mut self) {
        self.failures = 0;
    }

    /// Whether the window has no attempts left.
    pub fn exhausted(&mut self, now: Instant) -> bool {
        self.prune(now);

        self.attempts.len() as u32 >= MAX_ATTEMPTS
    }

    /// The person asked: forget everything.
    pub fn reset(&mut self) {
        self.attempts.clear();
        self.failures = 0;
    }
}

/// Where a server's connection stands, for a server the user wants connected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Connected,
    /// The next attempt (number `attempt` in the window) starts at `at`.
    Waiting {
        attempt: u32,
        at: Instant,
    },
    Connecting {
        attempt: u32,
    },
    /// Out of attempts, or a failure that needs the person. A Retry leaves this, and so does a page connect, which the attempt window bounds.
    GaveUp {
        reason: String,
    },
}

/// One server the user asked to keep connected.
#[derive(Debug)]
pub struct Keep {
    backoff: Backoff,
    phase: Phase,
}

impl Keep {
    pub fn connected() -> Self {
        Keep {
            backoff: Backoff::default(),
            phase: Phase::Connected,
        }
    }

    pub fn phase(&self) -> &Phase {
        &self.phase
    }

    /// The link was seen alive.
    pub fn up(&mut self) {
        self.backoff.up();
        self.phase = Phase::Connected;
    }

    /// The person is connecting by hand and this attempt is running. `retry` is the Retry of the local window, which
    /// forgets the attempts so far; any other caller (the page) counts as one more attempt and is refused once the
    /// window is full, so a loop in a page cannot dial a server all day.
    pub fn manual(&mut self, retry: bool, now: Instant) -> Result<(), String> {
        if retry {
            self.backoff.reset();
        } else if self.backoff.exhausted(now) {
            return Err(format!(
                "too many attempts to reach this server: retry from the Neore device window (at most {MAX_ATTEMPTS} in {} minutes)",
                WINDOW.as_secs() / 60
            ));
        } else {
            self.backoff.attempt(now);
        }

        self.phase = Phase::Connecting { attempt: 0 };

        Ok(())
    }

    /// The link was seen dead. Only the first sight counts: a server already waiting or connecting is left be.
    pub fn lost(&mut self, now: Instant) -> bool {
        if self.phase != Phase::Connected {
            return false;
        }

        self.schedule(now, "the connection was lost");

        true
    }

    fn schedule(&mut self, now: Instant, reason: &str) {
        self.phase = match self.backoff.delay(now) {
            Some(wait) => Phase::Waiting {
                attempt: self.backoff.attempts.len() as u32 + 1,
                at: now + wait,
            },
            None => Phase::GaveUp {
                reason: reason.to_owned(),
            },
        };
    }

    /// Whether an attempt starts now; if so, which number it is.
    pub fn due(&mut self, now: Instant) -> Option<u32> {
        let Phase::Waiting { attempt, at } = self.phase else {
            return None;
        };

        if now < at {
            return None;
        }

        self.backoff.attempt(now);
        self.phase = Phase::Connecting { attempt };

        Some(attempt)
    }

    /// The attempt that was running failed. A failure that `retryable` is not waits for the person.
    pub fn failed(&mut self, now: Instant, retryable: bool, reason: &str) {
        if !matches!(self.phase, Phase::Connecting { .. }) {
            return;
        }

        if retryable {
            self.schedule(now, reason);

            if let Phase::GaveUp { reason: stored } = &mut self.phase {
                *stored = format!("{reason} (gave up after {MAX_ATTEMPTS} attempts)");
            }
        } else {
            self.phase = Phase::GaveUp {
                reason: reason.to_owned(),
            };
        }
    }
}

/// Notes a launch on this server, newest last, forgetting the oldest beyond a handful.
pub fn remember(launches: &mut Vec<String>, id: &str) {
    if !launches.iter().any(|known| known == id) {
        launches.push(id.to_owned());
    }

    while launches.len() > MAX_LAUNCHES {
        launches.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn the_wait_doubles_from_two_seconds_and_stops_at_the_cap() {
        let (mut backoff, now) = (Backoff::default(), Instant::now());

        assert_eq!(backoff.delay(now), Some(secs(2)));
        assert_eq!(backoff.delay(now), Some(secs(4)));
        assert_eq!(backoff.delay(now), Some(secs(8)));
        assert_eq!(backoff.delay(now), Some(secs(16)));
        assert_eq!(backoff.delay(now), Some(secs(32)));
        assert_eq!(backoff.delay(now), Some(MAX_DELAY));
        assert_eq!(backoff.delay(now), Some(MAX_DELAY));
    }

    #[test]
    fn five_attempts_in_ten_minutes_end_the_trying() {
        let (mut keep, start) = (Keep::connected(), Instant::now());
        let mut now = start;

        keep.lost(now);

        for number in 1..=MAX_ATTEMPTS {
            let Phase::Waiting { attempt, at } = keep.phase().clone() else {
                panic!("attempt {number} was not scheduled: {:?}", keep.phase());
            };

            assert_eq!(attempt, number);
            assert_eq!(keep.due(at - secs(1)), None, "it started early");

            now = at;

            assert_eq!(keep.due(now), Some(number));

            keep.failed(now, true, "no route");
        }

        assert!(
            matches!(keep.phase(), Phase::GaveUp { reason } if reason.contains("no route") && reason.contains("5 attempts")),
            "{:?}",
            keep.phase()
        );
        assert_eq!(
            keep.due(now + secs(3600)),
            None,
            "a given-up server tries again"
        );
        assert!(now.duration_since(start) < WINDOW);
    }

    #[test]
    fn attempts_older_than_the_window_stop_counting() {
        let (mut backoff, start) = (Backoff::default(), Instant::now());

        for _ in 0..MAX_ATTEMPTS {
            backoff.attempt(start);
        }

        assert_eq!(backoff.delay(start + secs(60)), None);
        assert!(backoff.delay(start + WINDOW).is_some());
    }

    #[test]
    fn a_failure_that_will_not_fix_itself_waits_for_the_person_at_once() {
        let (mut keep, now) = (Keep::connected(), Instant::now());

        keep.lost(now);

        let Phase::Waiting { at, .. } = keep.phase().clone() else {
            panic!("not scheduled");
        };

        assert_eq!(keep.due(at), Some(1));

        keep.failed(at, false, "the host key changed");

        assert_eq!(
            keep.phase(),
            &Phase::GaveUp {
                reason: "the host key changed".into()
            }
        );
    }

    #[test]
    fn a_retry_forgets_the_attempts_and_a_loss_is_counted_once() {
        let (mut keep, now) = (Keep::connected(), Instant::now());

        assert!(keep.lost(now));
        assert!(!keep.lost(now), "a second sight of the same loss");

        keep.manual(true, now).unwrap();

        assert_eq!(keep.phase(), &Phase::Connecting { attempt: 0 });

        keep.up();

        assert!(keep.lost(now));

        let Phase::Waiting { attempt, at } = keep.phase().clone() else {
            panic!("not scheduled");
        };

        assert_eq!((attempt, at), (1, now + BASE_DELAY));
    }

    #[test]
    fn only_the_local_windows_retry_forgets_the_attempts() {
        let (mut keep, now) = (Keep::connected(), Instant::now());

        for _ in 0..MAX_ATTEMPTS {
            keep.manual(false, now).unwrap();
            keep.up();
        }

        assert!(keep
            .manual(false, now)
            .unwrap_err()
            .contains("device window"));

        keep.manual(true, now).unwrap();
        keep.up();
        keep.manual(false, now).unwrap();
    }

    #[test]
    fn a_link_that_keeps_dropping_still_reaches_the_limit() {
        let (mut keep, mut now) = (Keep::connected(), Instant::now());

        for _ in 0..MAX_ATTEMPTS {
            assert!(keep.lost(now));

            let Phase::Waiting { at, .. } = keep.phase().clone() else {
                panic!("gave up too early");
            };

            now = at;

            assert!(keep.due(now).is_some());

            // The attempt worked, and the link dropped again a minute later.
            keep.up();

            now += secs(60);
        }

        assert!(keep.lost(now));
        assert!(
            matches!(keep.phase(), Phase::GaveUp { .. }),
            "{:?}",
            keep.phase()
        );
    }

    #[test]
    fn launches_are_remembered_once_and_the_oldest_are_forgotten() {
        let mut launches = Vec::new();

        remember(&mut launches, "a");
        remember(&mut launches, "a");
        assert_eq!(launches, ["a"]);

        for n in 0..MAX_LAUNCHES + 3 {
            remember(&mut launches, &format!("id{n}"));
        }

        assert_eq!(launches.len(), MAX_LAUNCHES);
        assert_eq!(launches.last().unwrap(), &format!("id{}", MAX_LAUNCHES + 2));
    }
}
