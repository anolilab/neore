use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

use super::super::vault::tests::{temp_dir, FakeKeychain};
use super::*;

const SECRET: &str = concat!(
    "fedcba9876543210",
    "fedcba9876543210",
    "fedcba9876543210",
    "fedcba9876543210"
);

/// Plays a backend: the code answer first, then one scripted answer per poll.
struct FakeBackend {
    code: Reply,
    polls: RefCell<VecDeque<Result<Reply, String>>>,
    requests: RefCell<Vec<(String, Value)>>,
}

impl FakeBackend {
    fn new(polls: Vec<Result<Reply, String>>) -> Self {
        FakeBackend {
            code: reply(
                200,
                json!({
                    "device_code": "dc-1",
                    "expires_in": 1800,
                    "interval": 5,
                    "user_code": "ABCD2345",
                    "verification_uri": "https://neore.ai/auth/device",
                    "verification_uri_complete": "https://neore.ai/auth/device?user_code=ABCD2345",
                }),
            ),
            polls: RefCell::new(polls.into()),
            requests: RefCell::default(),
        }
    }
}

impl Http for FakeBackend {
    fn post_json(&self, url: &str, body: &Value) -> Result<Reply, String> {
        self.requests
            .borrow_mut()
            .push((url.to_owned(), body.clone()));

        if url.ends_with(CODE_PATH) {
            return Ok(self.code.clone());
        }

        self.polls
            .borrow_mut()
            .pop_front()
            .expect("polled more often than scripted")
    }
}

fn reply(status: u16, body: Value) -> Reply {
    Reply { status, body }
}

fn pending() -> Result<Reply, String> {
    Ok(reply(400, json!({ "error": "authorization_pending" })))
}

fn approved() -> Result<Reply, String> {
    Ok(reply(
        200,
        json!({ "account": "o***@example.com", "device_id": "device-9", "name": "build-box", "secret": SECRET, "token_type": "device_secret" }),
    ))
}

/// A clock that only moves when the flow sleeps.
#[derive(Default)]
struct FakeTimer {
    now: Cell<u64>,
    slept: RefCell<Vec<Duration>>,
}

impl Timer for FakeTimer {
    fn now_ms(&self) -> u64 {
        self.now.get()
    }

    fn sleep(&self, duration: Duration) {
        self.now.set(self.now.get() + duration.as_millis() as u64);
        self.slept.borrow_mut().push(duration);
    }
}

fn run(
    backend: &FakeBackend,
    keychain: &FakeKeychain,
    label: &str,
) -> (Result<Paired, PairError>, String, FakeTimer) {
    let timer = FakeTimer::default();
    let vault = Vault::new(temp_dir(label), keychain);
    let mut out = Vec::new();
    let outcome = pair(
        backend,
        &timer,
        &vault,
        "https://neore.ai/",
        &Identity {
            hostname: "build-box",
            platform: "linux",
        },
        &mut out,
    );

    (outcome, String::from_utf8(out).unwrap(), timer)
}

#[test]
fn shows_the_code_and_the_storage_then_stores_what_the_approved_poll_returns() {
    let backend = FakeBackend::new(vec![pending(), pending(), approved()]);
    let keychain = FakeKeychain::default();
    let (outcome, shown, timer) = run(&backend, &keychain, "happy");
    let paired = outcome.unwrap();

    assert_eq!(paired.device_id, "device-9");
    assert_eq!(paired.storage, Storage::Keychain);
    assert_eq!(paired.account, "o***@example.com");
    assert_eq!(
        keychain
            .entries
            .borrow()
            .get("https://neore.ai|device-9")
            .map(String::as_str),
        Some(SECRET)
    );

    // What the person is told, before and after approval.
    assert!(shown.contains("ABCD-2345"), "{shown}");
    assert!(shown.contains("https://neore.ai/auth/device"));
    assert!(shown.contains("operating system keychain"));
    assert!(!shown.contains(SECRET));

    // The code request announces where the secret will live; each poll names the code and the client.
    let requests = backend.requests.borrow();

    assert_eq!(requests[0].0, "https://neore.ai/api/auth/device/code");
    assert_eq!(
        requests[0].1,
        json!({ "client_id": "neore-host", "hostname": "build-box", "platform": "linux", "storage": "keychain" })
    );
    assert_eq!(requests[1].0, "https://neore.ai/api/auth/device/host");
    assert_eq!(
        requests[1].1,
        json!({ "client_id": "neore-host", "device_code": "dc-1" })
    );
    assert_eq!(timer.slept.borrow().len(), 3);
}

#[cfg(unix)]
#[test]
fn announces_the_file_when_the_keychain_cannot_be_used() {
    let backend = FakeBackend::new(vec![approved()]);
    let keychain = FakeKeychain {
        broken: true,
        ..FakeKeychain::default()
    };
    let (outcome, shown, _) = run(&backend, &keychain, "file");
    let paired = outcome.unwrap();

    assert_eq!(paired.storage, Storage::File);
    assert_eq!(backend.requests.borrow()[0].1["storage"], json!("file"));
    assert!(shown.contains("a file only you can read"));
}

#[test]
fn slow_down_widens_the_interval_for_every_later_poll() {
    let backend = FakeBackend::new(vec![
        Ok(reply(400, json!({ "error": "slow_down" }))),
        pending(),
        approved(),
    ]);
    let (outcome, _, timer) = run(&backend, &FakeKeychain::default(), "slow");

    assert!(outcome.is_ok());
    assert_eq!(
        *timer.slept.borrow(),
        vec![
            Duration::from_secs(5),
            Duration::from_secs(10),
            Duration::from_secs(10)
        ]
    );
}

#[test]
fn a_denied_code_stores_nothing() {
    let backend = FakeBackend::new(vec![Ok(reply(400, json!({ "error": "access_denied" })))]);
    let keychain = FakeKeychain::default();
    let (outcome, _, _) = run(&backend, &keychain, "denied");

    assert_eq!(outcome, Err(PairError::Denied));
    assert!(keychain.entries.borrow().is_empty());
}

#[test]
fn an_account_refusal_is_reported_with_its_reason() {
    let backend = FakeBackend::new(vec![Ok(reply(
        403,
        json!({ "error": "access_denied", "error_description": "At most 10 devices can be paired. Remove one first." }),
    ))]);
    let (outcome, _, _) = run(&backend, &FakeKeychain::default(), "full");

    assert_eq!(
        outcome,
        Err(PairError::Refused(
            "At most 10 devices can be paired. Remove one first.".into()
        ))
    );
}

#[test]
fn expiry_and_a_used_code_end_the_flow() {
    let expired = FakeBackend::new(vec![Ok(reply(400, json!({ "error": "expired_token" })))]);
    let used = FakeBackend::new(vec![Ok(reply(400, json!({ "error": "invalid_grant" })))]);

    assert_eq!(
        run(&expired, &FakeKeychain::default(), "expired").0,
        Err(PairError::Expired)
    );
    assert_eq!(
        run(&used, &FakeKeychain::default(), "used").0,
        Err(PairError::Invalid)
    );
}

#[test]
fn gives_up_when_the_code_lapses_without_an_answer() {
    // 1800 s at a 5 s interval is 360 polls; none ever approves.
    let backend = FakeBackend::new((0..400).map(|_| pending()).collect());
    let (outcome, _, _) = run(&backend, &FakeKeychain::default(), "lapse");

    assert_eq!(outcome, Err(PairError::Expired));
}

#[test]
fn a_few_transport_failures_are_ridden_out_but_not_forever() {
    let flaky = FakeBackend::new(vec![
        Err("timed out".into()),
        Ok(reply(429, Value::Null)),
        approved(),
    ]);

    assert!(run(&flaky, &FakeKeychain::default(), "flaky").0.is_ok());

    let dead = FakeBackend::new(
        (0..10)
            .map(|_| Err("connection refused".to_owned()))
            .collect(),
    );

    assert_eq!(
        run(&dead, &FakeKeychain::default(), "dead").0,
        Err(PairError::Unreachable("connection refused".into()))
    );
}

#[test]
fn a_used_code_after_a_lost_answer_says_the_machine_may_be_registered() {
    let backend = FakeBackend::new(vec![
        Err("timed out".into()),
        Ok(reply(400, json!({ "error": "invalid_grant" }))),
    ]);
    let (outcome, _, _) = run(&backend, &FakeKeychain::default(), "lost-answer");

    assert_eq!(outcome, Err(PairError::PossiblyRegistered));
    assert!(PairError::PossiblyRegistered
        .to_string()
        .contains("Settings, Devices"));
}

#[test]
fn every_kind_of_failure_has_its_own_exit_code_and_only_unreachable_is_a_retry() {
    let codes = [
        PairError::Denied.exit_code(),
        PairError::Expired.exit_code(),
        PairError::Invalid.exit_code(),
        PairError::Refused(String::new()).exit_code(),
        PairError::Unreachable(String::new()).exit_code(),
        PairError::PossiblyRegistered.exit_code(),
    ];

    assert_eq!(codes, [3, 4, 5, 6, 7, 8]);
    assert_eq!(
        PairError::NotStored {
            device_id: String::new(),
            reason: String::new()
        }
        .exit_code(),
        8
    );
    // 2 is the command line, 1 the unclassified rest.
    assert_eq!(PairError::Output(String::new()).exit_code(), 1);
}

#[test]
fn a_backend_that_keeps_failing_is_polled_a_bounded_number_of_times_each_after_its_wait() {
    for failure in [
        Ok(reply(500, Value::Null)),
        Ok(reply(429, Value::Null)),
        Err("reset".to_owned()),
    ] {
        let backend = FakeBackend::new((0..50).map(|_| failure.clone()).collect());
        let (outcome, _, timer) = run(&backend, &FakeKeychain::default(), "flood");
        let polls = backend.requests.borrow().len() - 1;

        assert!(matches!(outcome, Err(PairError::Unreachable(_))));
        assert_eq!(polls, (MAX_CONSECUTIVE_FAILURES + 1) as usize);
        assert_eq!(timer.slept.borrow().len(), polls);
    }

    // An answer that is neither pending nor a known error ends the pairing at once, with no further poll.
    let backend = FakeBackend::new(vec![
        Ok(reply(400, json!({ "error": "something_new" }))),
        pending(),
    ]);

    assert!(matches!(
        run(&backend, &FakeKeychain::default(), "unknown").0,
        Err(PairError::Refused(_))
    ));
    assert_eq!(backend.requests.borrow().len(), 2);
}

#[test]
fn an_absurd_interval_from_the_backend_is_bounded_not_a_panic() {
    let mut backend = FakeBackend::new(vec![
        Ok(reply(400, json!({ "error": "slow_down" }))),
        Ok(reply(400, json!({ "error": "slow_down" }))),
        approved(),
    ]);

    backend.code = reply(
        200,
        json!({
            "device_code": "dc-1",
            "expires_in": u64::MAX,
            "interval": u64::MAX,
            "user_code": "ABCD2345",
            "verification_uri": "https://neore.ai/auth/device",
        }),
    );

    let (outcome, _, timer) = run(&backend, &FakeKeychain::default(), "absurd");

    assert!(outcome.is_ok(), "{outcome:?}");
    assert!(timer
        .slept
        .borrow()
        .iter()
        .all(|wait| *wait <= MAX_INTERVAL));
}

#[test]
fn never_sleeps_past_the_codes_life() {
    // Every poll says slow_down, so the interval keeps growing; the code lives 1800 s.
    let backend = FakeBackend::new(
        (0..400)
            .map(|_| Ok(reply(400, json!({ "error": "slow_down" }))))
            .collect(),
    );
    let (outcome, _, timer) = run(&backend, &FakeKeychain::default(), "bound");
    let total: Duration = timer.slept.borrow().iter().sum();

    assert_eq!(outcome, Err(PairError::Expired));
    assert_eq!(total, Duration::from_secs(1800));
}

#[test]
fn does_not_wait_for_approval_when_the_code_cannot_be_shown() {
    struct Closed;

    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("broken pipe"))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let backend = FakeBackend::new(vec![approved()]);
    let timer = FakeTimer::default();
    let keychain = FakeKeychain::default();
    let vault = Vault::new(temp_dir("closed"), &keychain);
    let outcome = pair(
        &backend,
        &timer,
        &vault,
        "https://neore.ai",
        &Identity {
            hostname: "x",
            platform: "linux",
        },
        &mut Closed,
    );

    assert!(matches!(outcome, Err(PairError::Output(_))));
    assert!(timer.slept.borrow().is_empty());
    assert!(backend
        .requests
        .borrow()
        .iter()
        .all(|(url, _)| url.ends_with(CODE_PATH)));
    assert!(keychain.entries.borrow().is_empty());
}

#[test]
fn refuses_an_insecure_backend_before_sending_anything() {
    for address in [
        "http://neore.example",
        "http://localhost:8788",
        "http://127.0.0.1:8788",
    ] {
        let backend = FakeBackend::new(vec![]);
        let timer = FakeTimer::default();
        let keychain = FakeKeychain::default();
        let vault = Vault::new(temp_dir("insecure"), &keychain);
        let outcome = pair(
            &backend,
            &timer,
            &vault,
            address,
            &Identity {
                hostname: "x",
                platform: "linux",
            },
            &mut Vec::new(),
        );

        assert!(matches!(outcome, Err(PairError::Refused(_))), "{address}");
        assert!(backend.requests.borrow().is_empty(), "{address}");
    }
}

#[test]
fn an_answer_that_is_not_a_device_is_not_stored() {
    for body in [
        json!({ "device_id": "d", "secret": "short" }),
        json!({ "device_id": "d", "secret": SECRET.to_uppercase() }),
        json!({ "secret": SECRET }),
        json!({ "device_id": "", "secret": SECRET }),
    ] {
        let backend = FakeBackend::new(vec![Ok(reply(200, body))]);
        let keychain = FakeKeychain::default();
        let (outcome, _, _) = run(&backend, &keychain, "bad-device");

        assert!(matches!(outcome, Err(PairError::Refused(_))));
        assert!(keychain.entries.borrow().is_empty());
    }
}

#[cfg(unix)]
#[test]
fn an_unstorable_secret_names_the_device_to_remove() {
    // The vault dir is a file, so neither the keychain (broken) nor the fallback can hold the secret.
    let blocker = temp_dir("blocker");
    std::fs::write(&blocker, "x").unwrap();

    let backend = FakeBackend::new(vec![approved()]);
    let keychain = FakeKeychain {
        broken: true,
        ..FakeKeychain::default()
    };
    let vault = Vault::new(blocker.join("inside"), &keychain);
    let outcome = pair(
        &backend,
        &FakeTimer::default(),
        &vault,
        "https://neore.ai",
        &Identity {
            hostname: "x",
            platform: "linux",
        },
        &mut Vec::new(),
    );
    let message = outcome.unwrap_err().to_string();

    assert!(message.contains("device-9"), "{message}");
    assert!(message.contains("Remove that device"));
    assert!(!message.contains(SECRET));
}
