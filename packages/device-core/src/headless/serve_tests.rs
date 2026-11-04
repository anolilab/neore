use std::io::Cursor;

use super::*;
use crate::envelope::{sign_value, Domain};
use crate::headless::vault::tests::temp_dir;

const SECRET: &str = concat!(
    "0123456789abcdef",
    "0123456789abcdef",
    "0123456789abcdef",
    "0123456789abcdef"
);
const OTHER: &str = concat!(
    "fedcba9876543210",
    "fedcba9876543210",
    "fedcba9876543210",
    "fedcba9876543210"
);
const NOW: u64 = 1_800_000_000_000;

fn call(device: &str, nonce: &str, expires_in: i64) -> Value {
    json!({
        "callId": format!("call-{nonce}"),
        "deviceId": device,
        "expiresAt": (NOW as i64 + expires_in) as u64,
        "input": { "path": "a.txt" },
        "kind": "call",
        "nonce": nonce,
        "taintedBy": [],
        "threadTitle": "Build",
        "tool": "fs_read",
        "v": 1
    })
}

fn line(secret: &str, value: &Value) -> String {
    serde_json::to_string(&sign_value(secret, Domain::Call, value)).unwrap()
}

fn service(label: &str) -> Service {
    let dir = temp_dir(label);

    std::fs::create_dir_all(&dir).unwrap();

    Service::new("device-1", SECRET, &dir.join("nonces.json"), NOW).unwrap()
}

fn answers(service: &mut Service, lines: &[String]) -> Vec<Value> {
    let mut out = Vec::new();

    service
        .run(Cursor::new(lines.join("\n") + "\n"), &mut out, || NOW)
        .unwrap();

    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|answer| serde_json::from_str(answer).unwrap())
        .collect()
}

#[test]
fn accepts_a_call_signed_for_this_device() {
    let mut service = service("accept");
    let got = answers(
        &mut service,
        &[line(SECRET, &call("device-1", "n1", 60_000))],
    );

    assert_eq!(
        got,
        vec![json!({ "accepted": true, "callId": "call-n1", "tool": "fs_read" })]
    );
}

#[test]
fn refuses_a_call_signed_with_another_secret() {
    let mut service = service("foreign-secret");
    let got = answers(
        &mut service,
        &[line(OTHER, &call("device-1", "n1", 60_000))],
    );

    assert_eq!(got[0]["accepted"], json!(false));
    assert_eq!(
        got[0]["reason"],
        json!("the request is not signed for this device")
    );
}

#[test]
fn refuses_a_call_the_backend_signed_for_another_device() {
    // Same secret (a mistake or a copy), but the payload names a different device.
    let mut service = service("foreign-device");
    let got = answers(
        &mut service,
        &[line(SECRET, &call("device-2", "n1", 60_000))],
    );

    assert_eq!(got[0]["accepted"], json!(false));
    assert_eq!(
        got[0]["reason"],
        json!("the request is not for this device")
    );
}

#[test]
fn refuses_a_result_or_manifest_replayed_as_a_call() {
    let mut service = service("domain");
    let value = call("device-1", "n1", 60_000);
    let result = serde_json::to_string(&sign_value(SECRET, Domain::Result, &value)).unwrap();
    let manifest = serde_json::to_string(&sign_value(SECRET, Domain::Manifest, &value)).unwrap();
    let got = answers(&mut service, &[result, manifest]);

    assert!(got.iter().all(|answer| answer["accepted"] == json!(false)));
}

#[test]
fn refuses_a_replay_an_expired_call_and_a_tampered_payload() {
    let mut service = service("replay");
    let first = line(SECRET, &call("device-1", "n1", 60_000));
    let expired = line(SECRET, &call("device-1", "n2", -1));
    let mut tampered = serde_json::from_str::<Value>(&first).unwrap();

    tampered["payload"] = json!(tampered["payload"]
        .as_str()
        .unwrap()
        .replace("fs_read", "shell_run"));

    let got = answers(
        &mut service,
        &[first.clone(), first, expired, tampered.to_string()],
    );

    assert_eq!(got[0]["accepted"], json!(true));
    assert_eq!(got[1]["accepted"], json!(false));
    assert_eq!(got[2]["reason"], json!("the request has expired"));
    assert_eq!(
        got[3]["reason"],
        json!("the request is not signed for this device")
    );
}

#[test]
fn a_used_nonce_stays_used_after_a_restart() {
    let dir = temp_dir("restart");

    std::fs::create_dir_all(&dir).unwrap();

    let file = dir.join("nonces.json");
    let accepted = line(SECRET, &call("device-1", "n1", 60_000));
    let mut first = Service::new("device-1", SECRET, &file, NOW).unwrap();

    assert_eq!(
        answers(&mut first, std::slice::from_ref(&accepted))[0]["accepted"],
        json!(true)
    );

    let mut restarted = Service::new("device-1", SECRET, &file, NOW).unwrap();

    assert_eq!(
        answers(&mut restarted, &[accepted])[0]["accepted"],
        json!(false)
    );
}

#[test]
fn a_damaged_nonce_history_stops_the_run_instead_of_forgetting_it() {
    let dir = temp_dir("damaged");

    std::fs::create_dir_all(&dir).unwrap();

    let file = dir.join("nonces.json");

    std::fs::write(&file, "{ not json").unwrap();

    let error = Service::new("device-1", SECRET, &file, NOW)
        .err()
        .expect("a damaged history must not be taken for an empty one");

    assert!(error.contains("is damaged"), "{error}");

    // A directory where the file should be is unreadable, which is not "no history" either.
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();

    assert!(Service::new("device-1", SECRET, &file, NOW).is_err());
    // Absent is a first start.
    assert!(Service::new("device-1", SECRET, &dir.join("none.json"), NOW).is_ok());
}

#[cfg(unix)]
#[test]
fn a_lock_taken_before_any_pairing_leaves_a_folder_the_vault_accepts() {
    use std::os::unix::fs::PermissionsExt;

    use super::super::vault::tests::FakeKeychain;
    use super::super::vault::{NewPairing, Storage, Vault};

    let dir = temp_dir("lock-first").join("nested");
    let lock = RunLock::acquire(&dir).unwrap();

    assert_eq!(
        std::fs::metadata(&dir).unwrap().permissions().mode() & 0o077,
        0
    );

    let keychain = FakeKeychain::default();
    let vault = Vault::new(dir, &keychain);

    assert_eq!(vault.load().unwrap(), None);
    vault
        .save(
            &NewPairing {
                account: "",
                backend: "https://neore.ai",
                device_id: "d",
                name: "n",
                secret: "s",
            },
            Storage::Keychain,
        )
        .unwrap();

    drop(lock);
}

#[test]
fn a_second_run_on_the_same_pairing_is_refused_until_the_first_ends() {
    let dir = temp_dir("lock");
    let first = RunLock::acquire(&dir).unwrap();

    assert!(RunLock::acquire(&dir)
        .err()
        .unwrap()
        .contains("already holds"));

    drop(first);

    assert!(RunLock::acquire(&dir).is_ok());
}

#[test]
fn malformed_and_oversized_lines_are_refused_without_ending_the_run() {
    let mut service = service("malformed");
    let oversized = "x".repeat(MAX_LINE_BYTES as usize + 10);
    let got = answers(
        &mut service,
        &[
            "not json".into(),
            oversized,
            line(SECRET, &call("device-1", "n9", 60_000)),
        ],
    );

    assert_eq!(got.len(), 3);
    assert_eq!(got[0]["reason"], json!("the request is malformed"));
    assert_eq!(got[1]["reason"], json!("the request is too long"));
    assert_eq!(got[2]["accepted"], json!(true));
}
