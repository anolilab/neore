use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::acp::EnvVars;

const PACKAGE: &str = "fixture-agent";
const PROGRAM: &str = "console.log('hello');\n";

/// The state over a fresh folder under the system temp folder.
fn state(name: &str) -> (DeviceState, PathBuf) {
    crate::store::test_keychain::install();

    let dir = std::env::temp_dir().join(format!("neore-acp-npm-{name}-{}", std::process::id()));

    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    (DeviceState::new(&dir, Box::new(|_| {})), dir)
}

/// A stand-in `node`: a file at an absolute path, which is all the start-up check looks at.
fn fake_node(dir: &Path) -> PathBuf {
    let node = dir.join("node");

    fs::write(&node, "#!/bin/sh\n").unwrap();

    node
}

fn installed(dir: &Path) -> PathBuf {
    dir.join("acp-agents/fixture/1.0.0")
}

fn script(dir: &Path) -> PathBuf {
    installed(dir)
        .join("node_modules")
        .join(PACKAGE)
        .join("cli.js")
}

/// What an npm install leaves behind: the files under `acp-agents/fixture/1.0.0` and an agent recorded to run
/// `node <program>`, pinned with the hash of that folder. Returns the agent as recorded.
fn seed_install(state: &DeviceState, dir: &Path, node: &Path) -> AcpAgent {
    let program = script(dir);

    fs::create_dir_all(program.parent().unwrap()).unwrap();
    fs::write(&program, PROGRAM).unwrap();

    let agent = AcpAgent {
        args: vec![program.to_string_lossy().into_owned(), "--acp".into()],
        command: node.to_string_lossy().into_owned(),
        env: EnvVars(BTreeMap::new()),
        install: Some(AcpInstall {
            index_integrity: Some("sha512-index".into()),
            publisher: "Example Inc.".into(),
            sha256: "0".repeat(64),
            source: "https://registry.npmjs.org/fixture-agent/-/fixture-agent-1.0.0.tgz".into(),
            tree_sha256: Some(tree_hash(&installed(dir)).unwrap()),
            version: "1.0.0".into(),
        }),
        key: "fixture".into(),
        label: "Fixture".into(),
    };
    let recorded = agent.clone();

    state
        .change_settings(|settings| {
            settings.acp_agents.push(agent);

            Ok(())
        })
        .unwrap();

    recorded
}

fn save_agent(
    state: &DeviceState,
    command: &str,
    args: Vec<String>,
) -> Result<crate::acp::AcpView, String> {
    state.acp_update(
        serde_json::from_value(json!({
            "op": "saveAgent", "key": "fixture", "label": "Fixture", "command": command, "args": args,
        }))
        .unwrap(),
    )
}

#[test]
fn a_changed_added_or_removed_file_refuses_the_start_and_says_so() {
    let (state, dir) = state("recheck");
    let node = fake_node(&dir);

    seed_install(&state, &dir, &node);

    let program = script(&dir);
    let untouched = state.acp_spawn_plan("fixture", None).unwrap();

    assert_eq!(Path::new(&untouched.command), node);

    fs::write(&program, "console.log('changed');\n").unwrap();
    let changed = state.acp_spawn_plan("fixture", None).unwrap_err();
    assert!(
        changed.contains("no longer matches the files recorded"),
        "{changed}"
    );

    fs::write(&program, PROGRAM).unwrap();
    assert!(
        state.acp_spawn_plan("fixture", None).is_ok(),
        "restoring the bytes restores the start"
    );

    let extra = program.with_file_name("extra.js");

    fs::write(&extra, "x").unwrap();
    assert!(state.acp_spawn_plan("fixture", None).is_err());
    fs::remove_file(&extra).unwrap();

    fs::remove_file(&program).unwrap();
    assert!(state.acp_spawn_plan("fixture", None).is_err());
}

#[test]
fn an_executable_bit_changes_the_hash() {
    use std::os::unix::fs::PermissionsExt;

    let (state, dir) = state("exec-bit");
    let node = fake_node(&dir);

    seed_install(&state, &dir, &node);
    fs::set_permissions(script(&dir), fs::Permissions::from_mode(0o755)).unwrap();

    assert!(state.acp_spawn_plan("fixture", None).is_err());
}

#[test]
fn a_missing_install_folder_refuses_the_start() {
    let (state, dir) = state("missing");
    let node = fake_node(&dir);

    seed_install(&state, &dir, &node);
    fs::remove_dir_all(installed(&dir)).unwrap();

    assert!(state.acp_spawn_plan("fixture", None).is_err());
}

#[test]
fn an_agent_without_a_recorded_tree_is_not_checked() {
    let (state, dir) = state("binary");
    let node = fake_node(&dir);

    seed_install(&state, &dir, &node);
    state
        .change_settings(|settings| {
            settings.acp_agents[0].install.as_mut().unwrap().tree_sha256 = None;

            Ok(())
        })
        .unwrap();
    fs::write(script(&dir), "changed").unwrap();

    assert!(state.acp_spawn_plan("fixture", None).is_ok());
}

#[test]
fn a_node_that_is_gone_stops_the_start_with_a_message_that_names_it() {
    let (state, dir) = state("node-gone");
    let node = fake_node(&dir);

    seed_install(&state, &dir, &node);
    assert!(state.acp_spawn_plan("fixture", None).is_ok());
    fs::remove_file(&node).unwrap();

    let error = state.acp_spawn_plan("fixture", None).unwrap_err();

    assert!(
        error.contains("which is gone") && error.contains("Reinstall"),
        "{error}"
    );
}

#[test]
fn a_node_modules_folder_planted_next_to_the_install_refuses_the_start() {
    let (state, dir) = state("planted");
    let node = fake_node(&dir);

    seed_install(&state, &dir, &node);
    assert!(state.acp_spawn_plan("fixture", None).is_ok());

    for planted in [
        dir.join("acp-agents/fixture/node_modules"),
        dir.join("acp-agents/node_modules"),
        dir.join("node_modules"),
    ] {
        fs::create_dir_all(&planted).unwrap();

        let error = state.acp_spawn_plan("fixture", None).unwrap_err();

        assert!(
            error.contains("node_modules folder next to its install"),
            "{error}"
        );
        fs::remove_dir_all(&planted).unwrap();
        assert!(
            state.acp_spawn_plan("fixture", None).is_ok(),
            "removing it allows the start"
        );
    }
}

#[test]
fn a_link_out_of_the_package_is_refused_and_one_inside_is_hashed() {
    let (_, dir) = state("links");
    let root = dir.join("tree");
    let outside = dir.join("outside.js");

    fs::create_dir_all(root.join("bin")).unwrap();
    fs::write(root.join("cli.js"), "x").unwrap();
    fs::write(&outside, "y").unwrap();
    std::os::unix::fs::symlink("../cli.js", root.join("bin/cli")).unwrap();
    assert!(tree_hash(&root).is_ok());

    for (name, target) in [
        ("up", "../../outside.js"),
        ("absolute", outside.to_str().unwrap()),
    ] {
        std::os::unix::fs::symlink(target, root.join(name)).unwrap();
        assert!(
            tree_hash(&root)
                .unwrap_err()
                .contains("outside the package"),
            "{name}"
        );
        fs::remove_file(root.join(name)).unwrap();
    }

    // A relative target that stays inside by its names but passes through a link that climbs back to the root:
    // `a/b/up` is the root itself, so `a/b/up/..` is outside it. Only resolving on disk catches this.
    fs::create_dir_all(root.join("a/b")).unwrap();
    std::os::unix::fs::symlink("../..", root.join("a/b/up")).unwrap();
    assert!(tree_hash(&root).is_ok(), "the first link stays inside");
    std::os::unix::fs::symlink("a/b/up/..", root.join("hop")).unwrap();
    assert!(
        tree_hash(&root)
            .unwrap_err()
            .contains("outside the package"),
        "hop"
    );
}

#[test]
fn names_that_differ_only_in_bytes_no_text_keeps_hash_differently() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let (_, dir) = state("raw-names");
    let first = dir.join("first");
    let second = dir.join("second");

    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();

    // APFS refuses a name that is not valid UTF-8; there the case cannot arise and the test has nothing to say.
    if fs::write(first.join(OsStr::from_bytes(b"a\xff")), "x").is_err() {
        return;
    }

    fs::write(second.join(OsStr::from_bytes(b"a\xfe")), "x").unwrap();
    assert_ne!(tree_hash(&first).unwrap(), tree_hash(&second).unwrap());
}

#[test]
fn editing_the_arguments_after_the_program_keeps_the_pin_and_the_check() {
    let (state, dir) = state("edit-args");
    let node = fake_node(&dir);
    let agent = seed_install(&state, &dir, &node);
    let command = agent.command.clone();
    let program = agent.args[0].clone();

    // A trailing argument changes: still the pinned program, still hashed at every start.
    let edited = save_agent(&state, &command, vec![program.clone(), "--other".into()]).unwrap();

    assert!(edited.agents[0].install.is_some());
    assert!(Path::new(&program).is_file());
    assert!(state.acp_spawn_plan("fixture", None).is_ok());
    fs::write(&program, "changed").unwrap();
    assert!(state.acp_spawn_plan("fixture", None).is_err());
    fs::write(&program, PROGRAM).unwrap();

    // The program itself is replaced: no longer the install, and its files go with it, as for a binary.
    let moved = save_agent(&state, &command, vec!["/elsewhere/agent.js".into()]).unwrap();

    assert!(moved.agents[0].install.is_none());
    assert!(!installed(&dir).exists());
}

#[test]
fn another_interpreter_is_not_the_installed_one_and_drops_the_pin() {
    let (state, dir) = state("other-interpreter");
    let node = fake_node(&dir);
    let agent = seed_install(&state, &dir, &node);
    let view = save_agent(&state, "/bin/sh", vec![agent.args[0].clone()]).unwrap();

    assert!(view.agents[0].install.is_none(), "the pin is dropped");
    assert!(
        installed(&dir).exists(),
        "the files stay, the program is still inside them"
    );

    // The same program under the same interpreter keeps it.
    let (state, dir) = self::state("same-interpreter");
    let node = fake_node(&dir);
    let agent = seed_install(&state, &dir, &node);
    let view = save_agent(&state, &agent.command, agent.args.clone()).unwrap();

    assert!(view.agents[0].install.is_some());
}

#[test]
fn a_node_variable_added_or_changed_drops_the_pin_and_an_unrelated_one_does_not() {
    for (scope, name) in [(Some("fixture"), "NODE_PATH"), (None, "NODE_PATH")] {
        let (state, dir) = state(&format!("env-{name}"));
        let node = fake_node(&dir);

        seed_install(&state, &dir, &node);

        let set = |name: &str, value: &str| {
            state.acp_update(
                serde_json::from_value(json!({
                    "op": "setEnv", "agentKey": scope, "name": name, "value": value,
                }))
                .unwrap(),
            )
        };

        set("FIXTURE_TOKEN", "x").unwrap();
        assert!(
            state.acp_view().agents[0].install.is_some(),
            "an unrelated variable keeps the pin"
        );

        // `NODE_OPTIONS` is reserved by Neore and refused outright; the pin is not touched by the refusal.
        assert!(set("NODE_OPTIONS", "--require /tmp/evil.js").is_err());
        assert!(state.acp_view().agents[0].install.is_some());

        set(name, "/tmp/modules").unwrap();
        assert!(
            state.acp_view().agents[0].install.is_none(),
            "{name} drops the pin"
        );
    }
}

#[test]
fn a_hash_that_cannot_be_computed_is_refused_with_its_own_reason() {
    let (state, dir) = state("unhashable");
    let node = fake_node(&dir);

    seed_install(&state, &dir, &node);
    std::os::unix::fs::symlink("/etc/hosts", script(&dir).with_file_name("out")).unwrap();

    let error = state.acp_spawn_plan("fixture", None).unwrap_err();

    assert!(error.contains("could not be checked"), "{error}");
    assert!(error.contains("outside the package"), "{error}");
    assert!(!error.contains("a file was changed"), "{error}");
}

#[test]
fn removing_an_agent_whose_pin_was_cleared_still_deletes_its_folder() {
    let (state, dir) = state("remove-unpinned");
    let node = fake_node(&dir);
    let agent = seed_install(&state, &dir, &node);

    // A different program first, with a path into the folder kept in a later argument: the pin goes, the files stay.
    let edited = save_agent(
        &state,
        "/bin/sh",
        vec!["/elsewhere/agent.js".into(), agent.args[0].clone()],
    )
    .unwrap();

    assert!(edited.agents[0].install.is_none(), "the pin is cleared");
    assert!(installed(&dir).exists(), "the files stay");

    state
        .acp_update(
            serde_json::from_value(json!({ "op": "removeAgent", "key": "fixture" })).unwrap(),
        )
        .unwrap();
    assert!(
        !dir.join("acp-agents/fixture").exists(),
        "removal deletes them"
    );
}

#[test]
fn a_folder_with_too_many_names_is_refused_before_any_of_them_is_looked_at() {
    let (_, dir) = state("many-names");
    let root = dir.join("tree");

    fs::create_dir_all(&root).unwrap();
    // Sorts first and would fail on its own if it were looked at: the count must come before that.
    std::os::unix::fs::symlink("/etc/hosts", root.join("a-out")).unwrap();

    for name in ["b", "c", "d", "e"] {
        fs::write(root.join(name), "x").unwrap();
    }

    let error = walk(&root, &root, &mut Sha256::new(), &mut 0, 4).unwrap_err();

    assert!(error.contains("too many entries"), "{error}");
    assert!(walk(&root, &root, &mut Sha256::new(), &mut 0, 5)
        .unwrap_err()
        .contains("outside the package"));
}

#[test]
fn removing_a_node_variable_drops_the_pin_too() {
    for scope in [Some("fixture"), None] {
        let (state, dir) = state(&format!("env-remove-{}", scope.is_some()));
        let node = fake_node(&dir);

        seed_install(&state, &dir, &node);

        let update = |op: serde_json::Value| {
            state
                .acp_update(serde_json::from_value(op).unwrap())
                .unwrap()
        };

        update(json!({ "op": "setEnv", "agentKey": scope, "name": "FIXTURE_TOKEN", "value": "x" }));
        update(
            json!({ "op": "setEnv", "agentKey": scope, "name": "NODE_PATH", "value": "/tmp/m" }),
        );

        // Setting it dropped the pin; install a fresh one to see what removing does on its own.
        state
            .change_settings(|settings| {
                settings.acp_agents[0].install = Some(AcpInstall {
                    index_integrity: Some("sha512-index".into()),
                    publisher: "Example Inc.".into(),
                    sha256: "0".repeat(64),
                    source: "https://registry.npmjs.org/x".into(),
                    tree_sha256: Some(tree_hash(&installed(&dir)).unwrap()),
                    version: "1.0.0".into(),
                });

                Ok(())
            })
            .unwrap();

        update(json!({ "op": "removeEnv", "agentKey": scope, "name": "FIXTURE_TOKEN" }));
        assert!(
            state.acp_view().agents[0].install.is_some(),
            "an unrelated variable keeps the pin"
        );

        update(json!({ "op": "removeEnv", "agentKey": scope, "name": "NODE_PATH" }));
        assert!(
            state.acp_view().agents[0].install.is_none(),
            "removing NODE_PATH drops the pin"
        );
    }
}
