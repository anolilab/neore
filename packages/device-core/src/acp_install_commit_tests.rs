//! The install tree under change: a commit's rename and record, removal and prune, the trash. These use the
//! archive installer, the one caller of `commit_install` so far.

use super::*;
use serde_json::json;
use std::time::Duration;

const KEY: &str = "fixture";

/// A scratch folder that is removed when it goes out of scope, whether the test passed or not.
pub(crate) struct Scratch(pub(crate) PathBuf);

impl std::ops::Deref for Scratch {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The state over a fresh folder under the system temp folder.
fn state(name: &str) -> (DeviceState, Scratch) {
    crate::store::test_keychain::install();

    let dir = std::env::temp_dir().join(format!("neore-acp-commit-{name}-{}", std::process::id()));

    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    (DeviceState::new(&dir, Box::new(|_| {})), Scratch(dir))
}

/// A raw download of `bytes` named `agent`, staged and ready to install under `key` at `version`.
fn request(state: &DeviceState, bytes: &[u8], key: &str, version: &str) -> InstallRequest {
    let stage = state.acp_install_stage().unwrap();
    let archive = Path::new(&stage).join("download");

    fs::write(&archive, bytes).unwrap();

    InstallRequest {
        archive: archive.to_string_lossy().into_owned(),
        args: vec!["acp".into()],
        cmd: "agent".into(),
        env: BTreeMap::new(),
        format: ArchiveFormat::Raw,
        key: key.into(),
        label: "Fixture".into(),
        publisher: "Example Inc.".into(),
        sha256: to_hex(&Sha256::digest(bytes)),
        source: "https://example.com/agent".into(),
        version: version.into(),
    }
}

fn installed(dir: &Path, key: &str, version: &str) -> PathBuf {
    dir.join("acp-agents").join(key).join(version)
}

fn remove_agent(state: &DeviceState) {
    state
        .acp_update(serde_json::from_value(json!({ "op": "removeAgent", "key": KEY })).unwrap())
        .unwrap();
}

/// Whether `condition` becomes true within a few seconds: the deletions under test run on threads.
fn eventually(condition: impl Fn() -> bool) -> bool {
    (0..100).any(|_| {
        let done = condition();

        if !done {
            std::thread::sleep(Duration::from_millis(50));
        }

        done
    })
}

fn trash_is_empty(dir: &Path) -> bool {
    fs::read_dir(dir.join("acp-agents/.trash")).map_or(0, Iterator::count) == 0
}

#[test]
fn installs_of_one_version_that_overlap_leave_one_working_install() {
    let (state, dir) = state("overlap");
    let requests: Vec<_> = (0..4)
        .map(|_| request(&state, b"agent", KEY, "1.0.0"))
        .collect();

    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = requests
            .into_iter()
            .map(|request| scope.spawn(|| state.acp_install(request)))
            .collect();

        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    assert!(results.iter().all(Result::is_ok), "{results:?}");
    assert_eq!(state.acp_view().agents.len(), 1, "one agent is recorded");
    assert!(installed(&dir, KEY, "1.0.0").join("agent").is_file());
}

#[test]
fn a_removal_and_a_reinstall_that_overlap_leave_files_that_match_the_record() {
    let (state, dir) = state("remove-race");

    state
        .acp_install(request(&state, b"agent", KEY, "1.0.0"))
        .unwrap();

    for _ in 0..6 {
        let again = request(&state, b"agent", KEY, "1.0.0");

        std::thread::scope(|scope| {
            scope.spawn(|| state.acp_install(again).unwrap());
            scope.spawn(|| remove_agent(&state));
        });

        let recorded = !state.acp_view().agents.is_empty();

        assert_eq!(
            installed(&dir, KEY, "1.0.0").exists(),
            recorded,
            "the files exist exactly when the agent is recorded"
        );

        if !recorded {
            state
                .acp_install(request(&state, b"agent", KEY, "1.0.0"))
                .unwrap();
        }
    }
}

#[test]
fn pruning_never_deletes_the_version_a_concurrent_install_pinned() {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    let (state, dir) = state("prune-race");
    let key = "prune-hook";

    state
        .acp_install(request(&state, b"first", key, "1.0.0"))
        .unwrap();

    let second = request(&state, b"second", key, "2.0.0");

    // Hold the second install between its rename (2.0.0 is on disk, the record still says 1.0.0) and its
    // settings write, and run a prune in that window. A prune that reads the record there deletes 2.0.0.
    let (renamed_tx, renamed_rx) = mpsc::channel::<()>();
    let (pruning_tx, pruning_rx) = mpsc::channel::<()>();
    let pruning_rx = Mutex::new(pruning_rx);

    tests_hook::set(
        key,
        Arc::new(move || {
            let _ = renamed_tx.send(());
            // Returns as soon as the prune thread has started; the pause lets an unprotected prune finish.
            let _ = pruning_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(300));
        }),
    );

    std::thread::scope(|scope| {
        scope.spawn(|| state.acp_install(second).unwrap());
        let state = &state;

        scope.spawn(move || {
            renamed_rx.recv_timeout(Duration::from_secs(30)).unwrap();
            pruning_tx.send(()).unwrap();
            state.acp_install_prune(key);
        });
    });
    tests_hook::clear();
    state.acp_install_prune(key);

    let view = state.acp_view();
    let pinned = &view.agents[0].install.as_ref().unwrap().version;

    assert_eq!(pinned, "2.0.0", "the later install is the record");
    assert!(
        installed(&dir, key, pinned).exists(),
        "the pinned version is still on disk"
    );
}

#[test]
fn removing_an_agent_frees_its_folder_at_once_and_clears_the_files_in_the_background() {
    let (state, dir) = state("remove-async");

    state
        .acp_install(request(&state, b"agent", KEY, "1.0.0"))
        .unwrap();
    remove_agent(&state);

    // The name is free the moment the call returns, so a reinstall does not meet the files being deleted.
    assert!(!dir.join("acp-agents/fixture").exists());
    assert!(
        dir.join("acp-agents/.trash").is_dir(),
        "it went through the trash, not a delete that waits"
    );
    state
        .acp_install(request(&state, b"agent", KEY, "1.0.0"))
        .unwrap();
    assert!(
        eventually(|| trash_is_empty(&dir)),
        "the removed files are deleted in the background"
    );
}

#[test]
fn starting_an_install_leaves_clearing_old_trash_to_a_thread() {
    let (state, dir) = state("trash-sweep");
    let trash = dir.join("acp-agents/.trash");
    let foreign = trash.join("99999999-0");
    let own = trash.join(format!("{}-7", run_id()));
    // A crashed run whose pid this process now has: same pid, another run.
    let reused_pid = trash.join(format!("{}.1-0", std::process::id()));

    fs::create_dir_all(foreign.join("unpacked")).unwrap();
    fs::create_dir_all(&own).unwrap();
    fs::create_dir_all(reused_pid.join("unpacked")).unwrap();
    state.acp_install_stage().unwrap();

    assert!(
        eventually(|| !foreign.exists() && !reused_pid.exists()),
        "an earlier run's trash is deleted in the background, a reused pid included"
    );
    assert!(
        own.exists(),
        "this process's own trash is left to its own thread"
    );
}

#[cfg(unix)]
#[test]
fn a_trash_folder_that_is_a_link_is_not_swept() {
    let (state, dir) = state("trash-link");
    let outside = dir.join("outside");
    let precious = outside.join("99999999.1-0");

    fs::create_dir_all(&precious).unwrap();
    fs::write(precious.join("keep"), "x").unwrap();
    fs::create_dir_all(dir.join("acp-agents")).unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("acp-agents/.trash")).unwrap();
    state.acp_install_stage().unwrap();

    // The sweep is a thread; give it ample time to have done damage if it were going to.
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        precious.join("keep").exists(),
        "nothing behind the link is removed"
    );
}

#[cfg(unix)]
#[test]
fn removing_an_agent_also_removes_a_dangling_link_at_its_install_path() {
    let (state, dir) = state("dangling");

    state
        .acp_install(request(&state, b"agent", KEY, "1.0.0"))
        .unwrap();

    // The installed folder is replaced by a link to nothing.
    let at = dir.join("acp-agents/fixture");

    fs::remove_dir_all(&at).unwrap();
    std::os::unix::fs::symlink(dir.join("not-there"), &at).unwrap();
    remove_agent(&state);

    assert!(fs::symlink_metadata(&at).is_err(), "the link is gone");
    state
        .acp_install(request(&state, b"agent", KEY, "1.0.0"))
        .unwrap();
}

#[cfg(unix)]
#[test]
fn pruning_removes_a_stray_file_and_a_link_without_following_it() {
    let (state, dir) = state("prune-file");
    let outside = dir.join("outside");

    state
        .acp_install(request(&state, b"agent", KEY, "1.0.0"))
        .unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep"), "x").unwrap();

    let key_dir = dir.join("acp-agents/fixture");

    fs::write(key_dir.join("stray.txt"), "x").unwrap();
    std::os::unix::fs::symlink(&outside, key_dir.join("link")).unwrap();
    state.acp_install_prune(KEY);

    assert!(
        fs::symlink_metadata(key_dir.join("stray.txt")).is_err(),
        "the file is removed"
    );
    assert!(
        fs::symlink_metadata(key_dir.join("link")).is_err(),
        "the link is removed"
    );
    assert!(
        outside.join("keep").exists(),
        "what the link pointed at is not"
    );
    assert!(
        installed(&dir, KEY, "1.0.0").exists(),
        "the pinned version stays"
    );
}

#[test]
fn a_failed_install_leaves_its_staging_folder_to_a_background_delete() {
    let (state, dir) = state("stage-async");
    let mut request = request(&state, b"agent", KEY, "1.0.0");
    let stage = Path::new(&request.archive).parent().unwrap().to_path_buf();

    request.sha256 = "0".repeat(64);

    assert!(state.acp_install(request).is_err());
    assert!(
        !stage.exists(),
        "the staging folder is out of the staging area at once"
    );
    assert!(
        dir.join("acp-agents/.trash").is_dir(),
        "it went through the trash, not a delete that waits"
    );
    assert!(
        eventually(|| trash_is_empty(&dir)),
        "and its files are deleted in the background"
    );
}

#[test]
fn a_registry_entry_with_too_many_or_too_large_variables_is_refused() {
    let (state, dir) = state("env-cap");
    let mut many = request(&state, b"agent", KEY, "1.0.0");

    many.env = (0..=crate::acp::MAX_ENV_VARS)
        .map(|i| (format!("VAR_{i}"), "x".into()))
        .collect();
    assert!(state
        .acp_install(many)
        .unwrap_err()
        .contains("more than 50 environment variables"));

    let mut large = request(&state, b"agent", KEY, "1.0.0");

    large.env = (0..5)
        .map(|i| (format!("VAR_{i}"), "x".repeat(8 * 1024)))
        .collect();
    assert!(state
        .acp_install(large)
        .unwrap_err()
        .contains("environment variables that are too long"));
    assert!(!installed(&dir, KEY, "1.0.0").exists());
}

#[test]
fn removing_an_agent_moves_its_files_into_the_trash_before_they_are_deleted() {
    let (state, dir) = state("remove-trash");

    state
        .acp_install(request(&state, b"agent", KEY, "1.0.0"))
        .unwrap();
    // The install's own staging folder is being deleted; wait for that, so only the removal is in the trash.
    assert!(eventually(|| trash_is_empty(&dir)));

    let held = tests_hook::hold_deletes(&dir);

    remove_agent(&state);

    let trash = dir.join("acp-agents/.trash");
    let moved: Vec<_> = fs::read_dir(&trash)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .collect();

    assert_eq!(moved.len(), 1, "{moved:?}");
    assert!(moved[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(&format!("{}-", run_id())));
    assert!(
        moved[0].join("1.0.0/agent").is_file(),
        "the program is in the trash, not deleted yet"
    );
    assert!(!dir.join("acp-agents/fixture").exists());

    drop(held);
    assert!(eventually(|| trash_is_empty(&dir)));
}

#[test]
fn a_new_state_clears_the_trash_an_earlier_run_left() {
    crate::store::test_keychain::install();

    let dir = Scratch(
        std::env::temp_dir().join(format!("neore-acp-commit-startup-{}", std::process::id())),
    );
    let left = dir.join("acp-agents/.trash/99999999.1-0");

    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(left.join("unpacked")).unwrap();
    fs::write(left.join("unpacked/agent"), "x").unwrap();

    let _state = DeviceState::new(&dir, Box::new(|_| {}));

    assert!(
        eventually(|| !left.exists()),
        "an earlier run's trash is cleared when the state starts"
    );
}
