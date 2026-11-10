use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

use crate::acp::EnvVars;
use crate::acp_install::commit_tests::Scratch;
use crate::acp_install::sweep_trash;

const PACKAGE: &str = "fixture-agent";
const PROGRAM: &str = "console.log('hello');\n";

/// The state over a fresh folder under the system temp folder.
fn state(name: &str) -> (DeviceState, Scratch) {
    crate::store::test_keychain::install();

    let dir = std::env::temp_dir().join(format!("neore-acp-npm-{name}-{}", std::process::id()));

    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    (DeviceState::new(&dir, Box::new(|_| {})), Scratch(dir))
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

/// A package tarball as the index serves it: everything under `package/`.
fn tarball(manifest: &Value, extra: &[(&str, &str)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let manifest = manifest.to_string();
    let mut files = vec![
        ("package.json", manifest.as_str()),
        ("cli.js", "console.log('hello');\n"),
    ];

    files.extend_from_slice(extra);

    for (path, text) in files {
        let mut header = tar::Header::new_gnu();

        header.set_size(text.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, format!("package/{path}"), text.as_bytes())
            .unwrap();
    }

    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());

    gz.write_all(&builder.into_inner().unwrap()).unwrap();
    gz.finish().unwrap()
}

fn manifest() -> Value {
    json!({ "name": PACKAGE, "version": "1.0.0", "bin": { PACKAGE: "cli.js" } })
}

fn integrity(bytes: &[u8]) -> String {
    format!("sha512-{}", base64(&Sha512::digest(bytes)))
}

/// A stand-in `node` and an `npm` that records its arguments and unpacks the tarball like a real one would,
/// so the flow is tested without a network or a Node installation.
fn fake_tools(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let node = dir.join("node");
    let npm = dir.join("npm");
    let log = dir.join("npm-args.log");

    // Stands in for node: records how it was started, then runs its first argument as a script.
    fs::write(
        &node,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexec /bin/sh \"$@\"\n",
            dir.join("node-argv.log").display()
        ),
    )
    .unwrap();
    fs::write(
        &npm,
        format!(
            "#!/usr/bin/env node\necho \"$@\" > '{}'\nfor last; do :; done\nprefix=''\nwhile [ $# -gt 0 ]; do [ \"$1\" = --prefix ] && prefix=\"$2\"; shift; done\nmkdir -p \"$prefix/node_modules/{PACKAGE}\"\ntar xzf \"$last\" -C \"$prefix/node_modules/{PACKAGE}\" --strip-components=1\n",
            log.display()
        ),
    )
    .unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        for path in [&node, &npm] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    (node, npm, log)
}

fn request(
    state: &DeviceState,
    node: &Path,
    npm: &Path,
    bytes: &[u8],
    integrity: String,
) -> NpmInstallRequest {
    let stage = state.acp_install_stage().unwrap();
    let archive = Path::new(&stage).join("download");

    fs::write(&archive, bytes).unwrap();

    NpmInstallRequest {
        archive: archive.to_string_lossy().into_owned(),
        args: vec!["--acp".into()],
        env: BTreeMap::new(),
        integrity,
        key: "fixture".into(),
        label: "Fixture".into(),
        node: node.to_string_lossy().into_owned(),
        npm_identity: tool_identity(npm).unwrap(),
        node_identity: tool_identity(node).unwrap(),
        npm: npm.to_string_lossy().into_owned(),
        package: PACKAGE.into(),
        publisher: "Example Inc.".into(),
        source: "https://registry.npmjs.org/fixture-agent/-/fixture-agent-1.0.0.tgz".into(),
        version: "1.0.0".into(),
    }
}

fn request_for(state: &DeviceState, node: &Path, npm: &Path, version: &str) -> NpmInstallRequest {
    let bytes = tarball(
        &json!({ "name": PACKAGE, "version": version, "bin": { PACKAGE: "cli.js" } }),
        &[],
    );
    let mut request = request(state, node, npm, &bytes, integrity(&bytes));

    request.version = version.into();

    request
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
        error.contains("which is gone")
            && error.contains("Reinstall")
            && error.contains("removes the install checks"),
        "{error}"
    );
    assert!(
        state
            .audit_tail()
            .join("\n")
            .contains("the interpreter it was installed to run with is gone"),
        "the refusal is audited"
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

#[test]
fn a_link_that_resolves_to_nothing_is_refused_however_it_is_built() {
    let (_, dir) = state("dangling");
    let root = dir.join("tree");

    fs::create_dir_all(root.join("lib")).unwrap();
    fs::write(root.join("cli.js"), "x").unwrap();
    assert!(tree_hash(&root).is_ok());

    // Out of the tree, to somewhere that does not exist yet.
    std::os::unix::fs::symlink("../../later.js", root.join("lib/out")).unwrap();
    assert!(tree_hash(&root).is_err(), "dangling and outside");
    fs::remove_file(root.join("lib/out")).unwrap();

    // Inside by its names, but through a link in the tree that climbs out of it.
    std::os::unix::fs::symlink("..", root.join("lib/up")).unwrap();
    std::os::unix::fs::symlink("lib/up/../later.js", root.join("through")).unwrap();
    assert!(
        tree_hash(&root).is_err(),
        "dangling through an in-tree link"
    );
    fs::remove_file(root.join("through")).unwrap();

    // Inside and missing is just as unverifiable.
    std::os::unix::fs::symlink("missing.js", root.join("gone")).unwrap();
    assert!(tree_hash(&root).is_err(), "dangling inside");
}

#[test]
fn the_scratch_folder_is_removed_when_the_test_is_done() {
    let (state, dir) = state("scratch");
    let path = dir.to_path_buf();

    assert!(path.exists());
    drop(state);
    drop(dir);
    assert!(!path.exists());
}

#[test]
fn the_integrity_is_the_sri_of_the_bytes() {
    // Known vector: sha512("") in SRI form.
    assert_eq!(
        integrity(b""),
        "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="
    );
    assert!(valid_integrity(&integrity(b"x")));
    assert!(!valid_integrity("sha1-abc"));
    assert!(!valid_integrity(
        &integrity(b"x").replace("sha512-", "sha256-")
    ));
}

#[test]
fn a_hash_that_is_not_the_downloads_is_refused_and_nothing_runs_or_stays() {
    let (state, dir) = state("mismatch");
    let (node, npm, log) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let wrong = integrity(b"some other tarball");
    let error = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, wrong))
        .unwrap_err();

    assert!(
        error.contains("does not match the hash the package index gave"),
        "{error}"
    );
    assert!(
        !log.exists(),
        "npm must not run on a download that fails the hash"
    );
    assert!(!installed(&dir).exists());
    assert!(state.acp_view().agents.is_empty());
    assert_eq!(
        fs::read_dir(dir.join("acp-agents/.staging"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn a_verified_download_is_installed_without_scripts_and_pinned_with_its_hashes() {
    let (state, dir) = state("pin");
    let (node, npm, log) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let want = integrity(&bytes);
    let view = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, want.clone()))
        .unwrap();
    let agent = &view.agents[0];
    let pin = agent.install.as_ref().unwrap();
    let script = installed(&dir)
        .join("node_modules")
        .join(PACKAGE)
        .join("cli.js");

    assert!(fs::read_to_string(&log)
        .unwrap()
        .contains("--ignore-scripts"));
    assert_eq!(
        Path::new(&agent.command),
        node,
        "the command is the interpreter as found"
    );
    assert_eq!(
        agent.args,
        vec![script.to_string_lossy().into_owned(), "--acp".into()]
    );
    assert_eq!(pin.index_integrity.as_deref(), Some(want.as_str()));
    assert_eq!(pin.sha256, to_hex(&Sha256::digest(&bytes)));
    assert_eq!(
        pin.tree_sha256.as_deref(),
        Some(tree_hash(&installed(&dir)).unwrap().as_str())
    );
    assert!(script.is_file());
    // The staging folder, npm's cache included, is gone.
    assert_eq!(
        fs::read_dir(dir.join("acp-agents/.staging"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn the_installed_package_must_be_the_one_that_was_pinned() {
    let (state, dir) = state("identity");
    let (node, npm, _) = fake_tools(&dir);
    let other = tarball(
        &json!({ "name": PACKAGE, "version": "9.9.9", "bin": "cli.js" }),
        &[],
    );
    let error = state
        .acp_install_npm(request(&state, &node, &npm, &other, integrity(&other)))
        .unwrap_err();

    assert!(
        error.contains("not the name and version that was pinned"),
        "{error}"
    );
    assert!(!installed(&dir).exists());
    assert!(state.acp_view().agents.is_empty());
}

#[test]
fn the_program_is_one_file_inside_the_package() {
    let (state, dir) = state("bin");
    let (node, npm, _) = fake_tools(&dir);

    for manifest in [
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": "../outside.js" }),
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": "/bin/sh" }),
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": "missing.js" }),
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": { "a": "cli.js", "b": "other.js" } }),
        json!({ "name": PACKAGE, "version": "1.0.0" }),
    ] {
        let bytes = tarball(&manifest, &[]);

        assert!(
            state
                .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
                .is_err(),
            "{manifest}"
        );
        assert!(!installed(&dir).exists());
    }
}

#[test]
fn the_program_is_picked_like_npx_would() {
    let named = json!({ "bin": { "other": "o.js", "agent": "a.js" } });

    assert_eq!(pick_bin(&named, "@scope/agent").unwrap(), "a.js");
    assert_eq!(
        pick_bin(&json!({ "bin": { "x": "x.js" } }), "agent").unwrap(),
        "x.js"
    );
    assert_eq!(
        pick_bin(&json!({ "bin": "x.js" }), "agent").unwrap(),
        "x.js"
    );
    assert!(pick_bin(&json!({ "bin": { "a": "a.js", "b": "b.js" } }), "agent").is_err());
    assert!(pick_bin(&json!({}), "agent").is_err());
}

#[test]
fn tools_must_be_absolute_files_and_names_plain() {
    let (state, dir) = state("tools");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let base = |state: &DeviceState| request(state, &node, &npm, &bytes, integrity(&bytes));
    type Change = fn(&mut NpmInstallRequest);

    let changes: [(Change, &str); 7] = [
        (
            |r| r.node = "node".into(),
            "node was not found at an absolute path",
        ),
        (
            |r| r.npm = "/nonexistent/npm".into(),
            "npm was not found at an absolute path",
        ),
        (
            |r| r.package = "../evil".into(),
            "not a plain npm package name",
        ),
        (
            |r| r.package = "Fixture Agent".into(),
            "not a plain npm package name",
        ),
        (
            |r| r.integrity = "sha1-nope".into(),
            "no usable SHA-512 integrity",
        ),
        (
            |r| r.version = "latest".into(),
            "not a plain version number",
        ),
        (
            |r| {
                r.env.insert("NODE_OPTIONS".into(), "--require x".into());
            },
            "NODE_OPTIONS",
        ),
    ];

    for (change, reason) in changes {
        let mut r = base(&state);

        change(&mut r);

        let error = state.acp_install_npm(r).unwrap_err();

        assert!(error.contains(reason), "{reason}: {error}");
    }

    // A relative path to a file that does exist (cargo runs tests in the crate folder) is still not accepted.
    assert!(program_path("Cargo.toml", "Cargo.toml")
        .unwrap_err()
        .contains("absolute path"));
    assert!(valid_package_name("@scope/agent-x"));
    assert!(!valid_package_name("@scope"));
    assert!(!valid_package_name("a/b"));
}

#[test]
fn only_a_download_in_a_staging_folder_is_installed() {
    let (state, dir) = state("outside");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let mut r = request(&state, &node, &npm, &bytes, integrity(&bytes));
    let elsewhere = dir.join("elsewhere.tgz");

    fs::write(&elsewhere, &bytes).unwrap();
    r.archive = elsewhere.to_string_lossy().into_owned();

    assert!(state.acp_install_npm(r).is_err());
}

#[test]
fn a_program_node_cannot_run_is_refused_before_anything_is_recorded() {
    let (state, dir) = state("not-js");
    let (node, npm, _) = fake_tools(&dir);
    let shell = tarball(
        &json!({ "name": PACKAGE, "version": "1.0.0", "bin": "run.sh" }),
        &[("run.sh", "#!/bin/sh\necho hi\n")],
    );
    let error = state
        .acp_install_npm(request(&state, &node, &npm, &shell, integrity(&shell)))
        .unwrap_err();

    assert!(error.contains("not a JavaScript file"), "{error}");
    assert!(!installed(&dir).exists());

    let shebang = tarball(
        &json!({ "name": PACKAGE, "version": "1.0.0", "bin": "run" }),
        &[("run", "#!/usr/bin/env node\nconsole.log(1)\n")],
    );

    state
        .acp_install_npm(request(&state, &node, &npm, &shebang, integrity(&shebang)))
        .unwrap();
}

#[test]
fn a_tarball_swapped_after_the_check_is_refused() {
    let (state, dir) = state("swap");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);

    // npm reads the tarball, then another process rewrites it before the installer looks again.
    let mut script = fs::read_to_string(&npm).unwrap();

    script.push_str("echo tamper >> \"$last\"\n");
    fs::write(&npm, script).unwrap();

    let error = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap_err();

    assert!(
        error.contains("changed while it was being installed"),
        "{error}"
    );
    assert!(state.acp_view().agents.is_empty());
    assert!(!installed(&dir).exists());
}

#[test]
fn a_node_reached_through_a_link_with_another_name_installs() {
    let (state, dir) = state("node-link");
    let (real, npm, _) = fake_tools(&dir);
    let nodejs = dir.join("nodejs");
    let link = dir.join("bin-node/node");

    fs::rename(&real, &nodejs).unwrap();
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&nodejs, &link).unwrap();

    let view = state
        .acp_install_npm(request_for(&state, &link, &npm, "1.0.0"))
        .unwrap();

    assert_eq!(
        Path::new(&view.agents[0].command),
        link,
        "the recorded command is the link, by its own name"
    );
    assert!(state.acp_spawn_plan("fixture", None).is_ok());
}

#[test]
fn several_names_for_one_file_are_one_program_and_different_files_are_not() {
    let same = json!({ "bin": { "a": "cli.js", "b": "./cli.js" } });
    let different = json!({ "bin": { "a": "cli.js", "b": "other.js" } });

    assert_eq!(pick_bin(&same, "pkg").unwrap(), "cli.js");
    assert!(pick_bin(&different, "pkg").is_err());
    // A name whose value is not a path is not another name for the same file.
    assert!(pick_bin(&json!({ "bin": { "a": "cli.js", "b": 5 } }), "pkg").is_err());
    assert_eq!(pick_bin(&different, "a").unwrap(), "cli.js");
}

#[test]
fn a_node_re_pointed_after_the_confirmation_is_refused() {
    let (state, dir) = state("node-repoint");
    let (real, npm, _) = fake_tools(&dir);
    let other = dir.join("other-node");
    let link = dir.join("bin-node/node");

    fs::copy(&real, &other).unwrap();
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();

    // The request carries what the link resolved to at the confirmation; the link then moves.
    let confirmed = request_for(&state, &link, &npm, "1.0.0");

    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&other, &link).unwrap();

    let error = state.acp_install_npm(confirmed).unwrap_err();

    assert!(
        error.contains("not the file it was when you confirmed"),
        "{error}"
    );
    assert!(state.acp_view().agents.is_empty(), "nothing is recorded");
}

#[test]
fn an_npm_re_pointed_after_the_confirmation_is_refused() {
    let (state, dir) = state("npm-repoint");
    let (node, real_npm, _) = fake_tools(&dir);
    let other = dir.join("other-npm");
    let link = dir.join("bin-npm/npm");

    fs::copy(&real_npm, &other).unwrap();
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real_npm, &link).unwrap();

    let confirmed = request_for(&state, &node, &link, "1.0.0");

    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&other, &link).unwrap();

    let error = state.acp_install_npm(confirmed).unwrap_err();

    assert!(error.contains("npm is not the file it was"), "{error}");
    assert!(state.acp_view().agents.is_empty());
}

#[test]
fn an_npm_that_fails_installs_nothing_and_says_why() {
    let (state, dir) = state("npm-fails");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);

    fs::write(
        &npm,
        "#!/usr/bin/env node\necho registry unreachable >&2\nexit 1\n",
    )
    .unwrap();

    let error = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap_err();

    assert!(
        error.contains("npm could not install the package"),
        "{error}"
    );
    assert!(error.contains("registry unreachable"), "{error}");
    assert!(state.acp_view().agents.is_empty());
    assert!(!installed(&dir).exists());
}

#[test]
fn a_tool_replaced_or_rewritten_at_the_same_path_is_refused() {
    for which in ["node", "npm"] {
        for how in ["replaced", "rewritten"] {
            let (state, dir) = state(&format!("same-path-{which}-{how}"));
            let (node, npm, _) = fake_tools(&dir);
            let confirmed = request_for(&state, &node, &npm, "1.0.0");
            let path = if which == "node" { &node } else { &npm };
            let content = fs::read(path).unwrap();

            if how == "replaced" {
                // A new file under the same name: another inode, the same resolved path.
                let new = dir.join("new-file");

                fs::write(&new, &content).unwrap();
                fs::set_permissions(&new, fs::metadata(path).unwrap().permissions()).unwrap();
                fs::rename(&new, path).unwrap();
            } else {
                // The same file, other bytes.
                fs::write(path, [content.as_slice(), b"# changed\n"].concat()).unwrap();
            }

            let error = state.acp_install_npm(confirmed).unwrap_err();

            assert!(
                error.contains("is not the file it was when you confirmed"),
                "{which} {how}: {error}"
            );
            assert!(state.acp_view().agents.is_empty());
        }
    }
}

#[test]
fn a_dependency_that_is_not_from_the_package_index_is_refused_before_npm_runs() {
    let (state, dir) = state("deps");
    let (node, npm, log) = fake_tools(&dir);

    for (field, name, spec) in [
        (
            "dependencies",
            "left",
            "git+https://github.com/example/left.git#main",
        ),
        (
            "dependencies",
            "left",
            "git+ssh://git@github.com/example/left.git",
        ),
        ("dependencies", "left", "github:example/left"),
        ("dependencies", "left", "example/left"),
        ("dependencies", "left", "https://example.com/left-1.0.0.tgz"),
        ("dependencies", "left", "file:../left"),
        ("dependencies", "left", "link:../left"),
        ("optionalDependencies", "opt", "git://example.com/opt.git"),
        ("peerDependencies", "peer", "http://example.com/peer.tgz"),
        ("dependencies", "alias", "npm:github:example/left"),
        ("dependencies", "local", "evil.tgz"),
        ("dependencies", "local", "left-1.0.0.tar.gz"),
        ("dependencies", "local", "bundle.tar"),
        ("dependencies", "local", ".."),
        ("dependencies", "local", "./left"),
    ] {
        let mut manifest = manifest();

        manifest[field] = json!({ name: spec });

        let bytes = tarball(&manifest, &[]);
        let error = state
            .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
            .unwrap_err();

        assert!(
            error.contains(&format!(
                "depends on {name} from an address that is not the package index"
            )),
            "{spec}: {error}"
        );
        assert!(!log.exists(), "npm must not run for {spec}");
    }
}

#[test]
fn dependencies_from_the_package_index_are_allowed() {
    let (state, dir) = state("deps-ok");
    let (node, npm, _) = fake_tools(&dir);
    let mut manifest = manifest();

    manifest["dependencies"] = json!({
        "a": "^1.2.3", "b": "~1.2", "c": "1.x || >=2.0.0 <3", "d": "latest", "e": "*", "f": "",
        "g": "npm:other@^1.0.0", "h": "npm:@scope/other@1.0.0", "i": "1.0.0 - 2.0.0", "j": "1.0.0-beta.1+build",
    });
    manifest["optionalDependencies"] = json!({ "k": "2.x" });
    manifest["peerDependencies"] = json!({ "l": ">=1" });

    let bytes = tarball(&manifest, &[]);

    state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap();
}

/// Set on the child process of `only_the_variables_npm_needs_reach_it`, which has the extra variables.
const ENV_CHILD: &str = "NEORE_NPM_ENV_CHILD";

/// The proxy and certificate settings the parent of `npm_env_child` gives it, and npm must get.
const PROXY_SETTINGS: [(&str, &str); 7] = [
    ("HTTPS_PROXY", "http://proxy.example:3128"),
    ("HTTP_PROXY", "http://proxy.example:3128"),
    ("NO_PROXY", "localhost,.internal"),
    ("https_proxy", "http://proxy.example:3128"),
    ("http_proxy", "http://proxy.example:3128"),
    ("no_proxy", "localhost,.internal"),
    ("NODE_EXTRA_CA_CERTS", "/etc/corp/ca.pem"),
];

/// Runs only as the child of `only_the_variables_npm_needs_reach_it`: the process environment is never changed
/// in the test run itself, where other tests run at the same time.
#[test]
fn npm_env_child() {
    if std::env::var_os(ENV_CHILD).is_none() {
        return;
    }

    let (state, dir) = state("npm-env");
    let (node, npm, _) = fake_tools(&dir);
    let env_log = dir.join("npm-env.log");
    let bytes = tarball(&manifest(), &[]);
    let mut script = fs::read_to_string(&npm).unwrap();

    script.push_str(&format!("env > '{}'\n", env_log.display()));
    fs::write(&npm, script).unwrap();
    state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap();

    let names: Vec<String> = fs::read_to_string(&env_log)
        .unwrap()
        .lines()
        .filter_map(|line| line.split_once('=').map(|(name, _)| name.to_owned()))
        .collect();
    let allowed = [
        "PATH",
        "HOME",
        "TMPDIR",
        "npm_config_cache",
        "npm_config_userconfig",
        "npm_config_globalconfig",
        "npm_config_ignore_scripts",
        // Proxy and certificate settings, which the parent of this test sets.
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "no_proxy",
        "NODE_EXTRA_CA_CERTS",
        // Set by the shell that runs the script, not passed in.
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
    ];

    for name in &names {
        assert!(
            allowed.contains(&name.as_str()),
            "{name} reached npm: {names:?}"
        );
    }

    assert!(names.contains(&"npm_config_ignore_scripts".to_owned()));

    let seen = fs::read_to_string(&env_log).unwrap();

    for (name, value) in PROXY_SETTINGS {
        assert!(
            seen.lines().any(|line| line == format!("{name}={value}")),
            "{name} did not reach npm"
        );
    }

    println!("npm-env-checked");
}

#[test]
fn only_the_variables_npm_needs_reach_it() {
    let test = format!(
        "{}::npm_env_child",
        module_path!().trim_start_matches("device_core::")
    );
    let mut command = Command::new(std::env::current_exe().unwrap());

    command
        .args([test.as_str(), "--exact", "--nocapture", "--test-threads=1"])
        .env(ENV_CHILD, "1");

    for (name, value) in PROXY_SETTINGS {
        command.env(name, value);
    }

    let output = command
        .env("NODE_OPTIONS", "--require /tmp/evil.js")
        .env("npm_config_foo", "bar")
        .env("NEORE_TEST_SECRET", "hunter2")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        output.status.success() && stdout.contains("npm-env-checked"),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A package whose `lib` is a link to `target`, with a `package.json` whose bin is `bin`.
fn tarball_with_lib_link(bin: &str, target: &Path) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let manifest = json!({ "name": PACKAGE, "version": "1.0.0", "bin": bin }).to_string();
    let mut file = tar::Header::new_gnu();

    file.set_size(manifest.len() as u64);
    file.set_mode(0o644);
    file.set_cksum();
    builder
        .append_data(&mut file, "package/package.json", manifest.as_bytes())
        .unwrap();

    let mut link = tar::Header::new_gnu();

    link.set_entry_type(tar::EntryType::Symlink);
    link.set_size(0);
    link.set_mode(0o777);
    link.set_cksum();
    builder
        .append_link(&mut link, "package/lib", target)
        .unwrap();

    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());

    gz.write_all(&builder.into_inner().unwrap()).unwrap();
    gz.finish().unwrap()
}

#[test]
fn a_program_reached_through_a_link_out_of_the_package_is_refused() {
    let (state, dir) = state("bin-link-out");
    let (node, npm, _) = fake_tools(&dir);
    let outside = dir.join("outside");

    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("cli.js"), "console.log('outside');\n").unwrap();

    // `lib` is a link to a folder outside the package, and the program is a regular file inside it.
    let bytes = tarball_with_lib_link("lib/cli.js", &outside);
    let error = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap_err();

    assert!(error.contains("not a file inside it"), "{error}");
    assert!(!installed(&dir).exists());
}

#[test]
fn a_program_reached_through_a_link_to_a_sibling_package_is_refused() {
    let (state, dir) = state("bin-link-sibling");
    let (node, npm, _) = fake_tools(&dir);
    let mut script = fs::read_to_string(&npm).unwrap();

    // npm also installed another package next to this one, as it does for a dependency.
    script.push_str(
        "mkdir -p \"$prefix/node_modules/other-pkg\"\necho \"console.log('other');\" > \"$prefix/node_modules/other-pkg/cli.js\"\n",
    );
    fs::write(&npm, script).unwrap();

    // `lib` leads from this package to that one, inside `node_modules` but outside the package.
    let bytes = tarball_with_lib_link("lib/cli.js", Path::new("../other-pkg"));
    let error = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap_err();

    assert!(error.contains("not a file inside it"), "{error}");
    assert!(state.acp_view().agents.is_empty());
}

/// A tarball from `(path, text)` entries, paths as given (no `package/` added), repeats allowed.
fn raw_tarball(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());

    for (path, text) in entries {
        let mut header = tar::Header::new_gnu();

        header.set_size(text.len() as u64);
        header.set_mode(0o644);
        // The raw name field: `set_path` itself drops a leading `./`, which a real tarball can carry.
        header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
        header.set_cksum();
        builder.append(&header, text.as_bytes()).unwrap();
    }

    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());

    gz.write_all(&builder.into_inner().unwrap()).unwrap();
    gz.finish().unwrap()
}

#[test]
fn a_second_package_json_or_a_shrinkwrap_cannot_hide_dependencies() {
    let (state, dir) = state("hidden-deps");
    let (node, npm, log) = fake_tools(&dir);
    let clean = manifest().to_string();
    let evil = json!({
        "name": PACKAGE, "version": "1.0.0", "bin": "cli.js",
        "dependencies": { "left": "github:example/left" },
    })
    .to_string();

    for (what, entries, reason) in [
        (
            "the same path twice",
            vec![
                ("package/package.json", clean.as_str()),
                ("package/package.json", evil.as_str()),
            ],
            "more than one package.json",
        ),
        (
            "another top folder",
            vec![
                ("package/package.json", clean.as_str()),
                ("a/package.json", evil.as_str()),
            ],
            "more than one package.json",
        ),
        (
            "a dot-slash spelling",
            vec![
                ("package/package.json", clean.as_str()),
                ("./package/package.json", evil.as_str()),
            ],
            "more than one package.json",
        ),
        (
            "a shrinkwrap",
            vec![
                ("package/package.json", clean.as_str()),
                ("package/npm-shrinkwrap.json", "{}"),
            ],
            "npm-shrinkwrap.json",
        ),
    ] {
        let bytes = raw_tarball(&entries);
        let error = state
            .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
            .unwrap_err();

        assert!(error.contains(reason), "{what}: {error}");
        assert!(!log.exists(), "npm must not run for {what}");
    }

    // One package.json under any top folder is the usual shape and installs.
    let one = raw_tarball(&[
        ("package/package.json", clean.as_str()),
        ("package/cli.js", "x"),
    ]);

    state
        .acp_install_npm(request(&state, &node, &npm, &one, integrity(&one)))
        .unwrap();
}

#[test]
fn a_tool_rewritten_with_the_same_size_and_its_modification_time_restored_is_refused() {
    use std::os::unix::fs::MetadataExt;

    let (state, dir) = state("touch-r");
    let (node, npm, _) = fake_tools(&dir);
    let confirmed = request_for(&state, &node, &npm, "1.0.0");
    let meta = fs::metadata(&node).unwrap();
    let (before, confirmed_ctime) = (meta.modified().unwrap(), (meta.ctime(), meta.ctime_nsec()));
    let mut content = fs::read(&node).unwrap();
    let last = content.len() - 2;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut toggle = false;

    // Same length, other bytes, then `touch -r`. The file system stamps ctime from a coarse clock (up to one tick,
    // 10 ms or more), so a rewrite in the tick of the confirmation keeps it. Rewrite until ctime has moved; a real
    // swap comes long after the person confirmed.
    loop {
        content[last] = if toggle { b'#' } else { b'!' };
        toggle = !toggle;
        fs::write(&node, &content).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&node)
            .unwrap()
            .set_modified(before)
            .unwrap();

        let now = fs::metadata(&node).unwrap();

        if (now.ctime(), now.ctime_nsec()) != confirmed_ctime {
            break;
        }

        if std::time::Instant::now() >= deadline {
            eprintln!("skipped: this file system's change time did not advance in 2 s");

            return;
        }

        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let error = state.acp_install_npm(confirmed).unwrap_err();

    assert!(
        error.contains("is not the file it was when you confirmed"),
        "{error}"
    );
}

#[test]
fn npm_runs_under_the_confirmed_node_whatever_its_own_shebang_names() {
    let (state, dir) = state("npm-shebang");
    let (node, npm, _) = fake_tools(&dir);
    let mut script = fs::read_to_string(&npm).unwrap();
    let bytes = tarball(&manifest(), &[]);

    // A launcher that names another interpreter by an absolute path, which no PATH decides.
    script = script.replacen(
        "#!/usr/bin/env node",
        "#!/opt/not-the-confirmed/bin/node",
        1,
    );
    fs::write(&npm, script).unwrap();
    state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap();

    let argv = fs::read_to_string(dir.join("node-argv.log")).unwrap();

    assert!(
        argv.lines().next().unwrap().ends_with("npm"),
        "the confirmed node was started on npm's file first: {argv}"
    );
    assert!(argv.contains("--ignore-scripts"), "{argv}");
}

#[test]
fn an_npm_that_node_cannot_run_is_refused_not_executed() {
    let (state, dir) = state("npm-native");
    let (node, npm, log) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);

    fs::write(&npm, "#!/bin/sh\necho native shim > /dev/null\n").unwrap();

    let error = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap_err();

    assert!(error.contains("npm is not a JavaScript file"), "{error}");
    assert!(!log.exists());
    assert!(!dir.join("node-argv.log").exists(), "node did not run");
    assert!(state.acp_view().agents.is_empty());
}

#[test]
fn a_download_can_be_reserved_by_one_call_only() {
    let (state, dir) = state("reserve");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let request = request(&state, &node, &npm, &bytes, integrity(&bytes));
    let staged = state.staged_archive(&request.archive).unwrap();

    // Two calls that both resolved the download before either took it.
    let (archive, reserved) = reserve_stage(&state.install_root(), &staged).unwrap();

    assert!(archive.is_file() && reserved.is_dir());
    assert!(!staged.exists(), "the download moved with its folder");
    assert!(reserve_stage(&state.install_root(), &staged)
        .unwrap_err()
        .contains("already being installed"));
    assert!(archive.is_file(), "the first call's folder is untouched");

    // A folder a call has reserved cannot be taken again by another, by either way in.
    assert!(reserve_stage(&state.install_root(), &archive)
        .unwrap_err()
        .contains("already being installed"));
    assert!(state.staged_archive(&archive.to_string_lossy()).is_err());
    assert!(archive.is_file(), "the reservation is untouched");

    // The full call on the same request finds nothing to take.
    assert!(state.acp_install_npm(request).is_err());
    assert!(archive.is_file(), "and did not delete it");
}

#[test]
fn a_reservation_that_fails_for_another_reason_says_so() {
    use std::os::unix::fs::PermissionsExt;

    let (state, dir) = state("reserve-denied");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let request = request(&state, &node, &npm, &bytes, integrity(&bytes));
    let staged = state.staged_archive(&request.archive).unwrap();
    let holding = dir.join("acp-agents").join(INSTALLING_DIR);

    fs::create_dir_all(&holding).unwrap();
    fs::set_permissions(&holding, fs::Permissions::from_mode(0o500)).unwrap();

    // A root user can write there anyway; the case cannot arise and the test has nothing to say.
    let writable = fs::write(holding.join("probe"), "x").is_ok();
    let result = reserve_stage(&state.install_root(), &staged);

    fs::set_permissions(&holding, fs::Permissions::from_mode(0o700)).unwrap();

    if writable {
        return;
    }

    let error = result.unwrap_err();

    assert!(error.contains("could not be set aside"), "{error}");
    assert!(!error.contains("already being installed"), "{error}");
}

#[test]
fn a_reserved_download_is_not_swept_as_stale_and_is_cleared_when_the_state_starts() {
    let (state, dir) = state("reserved-sweep");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let request = request(&state, &node, &npm, &bytes, integrity(&bytes));
    let staged = state.staged_archive(&request.archive).unwrap();
    let (archive, reserved) = reserve_stage(&state.install_root(), &staged).unwrap();

    // Older than the day after which an abandoned staging folder is removed.
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 60 * 60);

    fs::File::open(&reserved)
        .unwrap()
        .set_modified(old)
        .unwrap();
    state.acp_install_stage().unwrap();
    assert!(archive.is_file(), "the sweep of old staging left it alone");

    // Starting the state in a later run means no install is running: what is still reserved is abandoned.
    let reserved = {
        let earlier = reserved.with_file_name("99999999.1-0");

        fs::rename(&reserved, &earlier).unwrap();
        earlier
    };
    let _fresh = DeviceState::new(&dir, Box::new(|_| {}));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);

    while reserved.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    assert!(!reserved.exists(), "cleared at start");
}

#[test]
fn a_reinstall_keeps_approvals_only_for_the_same_installed_tree() {
    let (state, dir) = state("reinstall-approvals");
    let (node, npm, _) = fake_tools(&dir);
    let project = dir.join("project");
    let bytes = tarball(&manifest(), &[]);
    let install = |state: &DeviceState| {
        state
            .acp_install_npm(request(state, &node, &npm, &bytes, integrity(&bytes)))
            .unwrap()
    };

    fs::create_dir_all(&project).unwrap();
    install(&state);
    state
        .acp_update(
            serde_json::from_value(json!({
                "op": "grant", "agentKey": "fixture", "folder": project.to_string_lossy(),
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(state.acp_view().consents.len(), 1);

    // The same tarball and the same installed files: still the program that was approved.
    install(&state);
    assert_eq!(state.acp_view().consents.len(), 1, "unchanged keeps them");

    // The same tarball, but npm resolved a dependency to other code this time.
    let mut script = fs::read_to_string(&npm).unwrap();

    script.push_str("echo 'resolved differently' > \"$prefix/node_modules/dep.js\"\n");
    fs::write(&npm, script).unwrap();

    let view = install(&state);

    assert!(view.consents.is_empty(), "a different tree drops them");
}

#[test]
fn only_a_node_shebang_makes_a_program_node_can_run() {
    for (line, expected) in [
        ("#!/usr/bin/env node", true),
        ("#!/usr/bin/env -S node --flag", true),
        ("#!/usr/local/bin/node", true),
        ("#!/usr/bin/node --harmony", true),
        ("#!/bin/sh # node", false),
        ("#!/bin/sh", false),
        ("#!/usr/bin/env sh", false),
        ("#!/usr/bin/env bash -c node", false),
        ("#!/usr/bin/python3 node", false),
        ("#!/usr/bin/nodejs", false),
        ("// node", false),
        ("", false),
    ] {
        assert_eq!(is_node_shebang(line), expected, "{line}");
    }

    let (_, dir) = state("shebang-file");
    let fake = dir.join("run");

    fs::write(&fake, "#!/bin/sh # node\necho hi\n").unwrap();
    assert!(!runs_under_node(&fake));
    fs::write(&fake, "#!/usr/bin/env node\nconsole.log(1)\n").unwrap();
    assert!(runs_under_node(&fake));
}

#[test]
fn an_entry_with_an_absolute_path_or_a_dot_dot_cannot_stand_in_for_the_manifest() {
    let (state, dir) = state("odd-paths");
    let (node, npm, log) = fake_tools(&dir);
    let clean = manifest().to_string();
    let evil = json!({
        "name": PACKAGE, "version": "1.0.0", "bin": "cli.js",
        "dependencies": { "left": "github:example/left" },
    })
    .to_string();

    for (what, second, reason) in [
        (
            "an absolute path",
            "/package/package.json",
            "absolute path or a `..`",
        ),
        (
            "a dot-dot",
            "package/../package/package.json",
            "absolute path or a `..`",
        ),
        (
            "a dot in the middle",
            "package/./package.json",
            "more than one package.json",
        ),
    ] {
        let bytes = raw_tarball(&[
            ("package/package.json", clean.as_str()),
            (second, evil.as_str()),
        ]);
        let error = state
            .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
            .unwrap_err();

        assert!(error.contains(reason), "{what}: {error}");
        assert!(!log.exists(), "npm must not run for {what}");
    }
}

#[test]
fn a_manifest_by_another_case_or_a_folded_name_cannot_stand_in_for_it() {
    let (state, dir) = state("folded-names");
    let (node, npm, log) = fake_tools(&dir);
    let clean = manifest().to_string();
    let evil = json!({
        "name": PACKAGE, "version": "1.0.0", "bin": "cli.js",
        "dependencies": { "left": "github:example/left" },
    })
    .to_string();

    for (what, second, text, reason) in [
        (
            "upper case",
            "package/PACKAGE.JSON",
            evil.as_str(),
            "more than one package.json",
        ),
        (
            "mixed case",
            "package/Package.Json",
            evil.as_str(),
            "more than one package.json",
        ),
        (
            "shrinkwrap in capitals",
            "package/NPM-SHRINKWRAP.JSON",
            "{}",
            "npm-shrinkwrap.json",
        ),
        (
            "a long s",
            "package/packa\u{17f}e.json",
            evil.as_str(),
            "not plain ASCII",
        ),
        (
            "a folded shrinkwrap",
            "package/npm-\u{17f}hrinkwrap.json",
            "{}",
            "not plain ASCII",
        ),
    ] {
        let bytes = raw_tarball(&[("package/package.json", clean.as_str()), (second, text)]);
        let error = state
            .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
            .unwrap_err();

        assert!(error.contains(reason), "{what}: {error}");
        assert!(!log.exists(), "npm must not run for {what}");
    }
}

#[test]
fn the_sweep_of_reserved_downloads_spares_this_runs_and_clears_other_runs() {
    let (state, dir) = state("reserved-run-id");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let request = request(&state, &node, &npm, &bytes, integrity(&bytes));
    let staged = state.staged_archive(&request.archive).unwrap();
    let (archive, reserved) = reserve_stage(&state.install_root(), &staged).unwrap();
    let holding = reserved.parent().unwrap();
    let earlier = holding.join("99999999.1-0");

    assert!(reserved
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(&format!("{}-", run_id())));

    fs::create_dir_all(earlier.join("unpacked")).unwrap();
    sweep_trash(holding.to_path_buf()).unwrap().join().unwrap();

    assert!(
        archive.is_file(),
        "this run's reservation survives the sweep"
    );
    assert!(!earlier.exists(), "another run's is cleared");
}

/// Nothing is left reserved in `acp-agents/.installing` once a call has refused.
fn nothing_is_reserved(dir: &Path) -> bool {
    fs::read_dir(dir.join("acp-agents").join(INSTALLING_DIR))
        .is_ok_and(|mut entries| entries.next().is_none())
}

#[test]
fn a_download_over_the_size_limit_is_refused_before_it_is_read_and_cleaned_up() {
    let (state, dir) = state("tarball-cap");
    let (node, npm, log) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let limits = Limits {
        tarball_bytes: bytes.len() as u64 - 1,
        ..LIMITS
    };
    let error = state
        .acp_install_npm_within(
            request(&state, &node, &npm, &bytes, integrity(&bytes)),
            &limits,
        )
        .unwrap_err();

    assert!(error.contains("more than an agent may be"), "{error}");
    assert!(!log.exists(), "npm did not run");
    assert!(nothing_is_reserved(&dir));
    assert!(state.acp_view().agents.is_empty());

    // The limit itself is allowed.
    let limits = Limits {
        tarball_bytes: bytes.len() as u64,
        ..LIMITS
    };

    state
        .acp_install_npm_within(
            request(&state, &node, &npm, &bytes, integrity(&bytes)),
            &limits,
        )
        .unwrap();
}

#[test]
fn what_is_read_of_a_download_is_bounded_even_when_it_grows_after_the_size_check() {
    let limits = Limits {
        tarball_bytes: 10,
        ..LIMITS
    };

    assert!(bounded_digests(std::io::Cursor::new(vec![0_u8; 10]), &limits).is_ok());
    assert!(
        bounded_digests(std::io::Cursor::new(vec![0_u8; 11]), &limits)
            .unwrap_err()
            .contains("more than an agent may be")
    );
}

#[test]
fn an_install_that_outgrows_the_staging_budget_is_stopped_while_it_runs() {
    let (state, dir) = state("stage-budget");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let mut script = fs::read_to_string(&npm).unwrap();

    // npm unpacks, then keeps writing: far more than the verified tarball, and it would go on for a minute.
    script.push_str("head -c 300000 /dev/zero > \"$prefix/big.bin\"\nsleep 60\n");
    fs::write(&npm, script).unwrap();

    let limits = Limits {
        stage_bytes: 100_000,
        ..LIMITS
    };
    let error = state
        .acp_install_npm_within(
            request(&state, &node, &npm, &bytes, integrity(&bytes)),
            &limits,
        )
        .unwrap_err();

    assert!(
        error.contains("more disk space than an agent may use"),
        "{error}"
    );
    assert!(!installed(&dir).exists());
    assert!(nothing_is_reserved(&dir));
    assert!(state.acp_view().agents.is_empty());
}

#[test]
fn an_npm_that_writes_past_the_budget_and_exits_at_once_is_still_refused() {
    let (state, dir) = state("stage-budget-fast");
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let mut script = fs::read_to_string(&npm).unwrap();

    // Done before the first measurement could have seen it.
    script.push_str("head -c 300000 /dev/zero > \"$prefix/big.bin\"\n");
    fs::write(&npm, script).unwrap();

    let limits = Limits {
        stage_bytes: 100_000,
        ..LIMITS
    };
    let error = state
        .acp_install_npm_within(
            request(&state, &node, &npm, &bytes, integrity(&bytes)),
            &limits,
        )
        .unwrap_err();

    assert!(
        error.contains("more disk space than an agent may use"),
        "{error}"
    );
    assert!(!installed(&dir).exists());
    assert!(nothing_is_reserved(&dir));
}

#[test]
fn a_small_staging_folder_is_within_budget() {
    let (_, dir) = state("budget-small");

    fs::write(dir.join("a"), vec![0_u8; 4096]).unwrap();
    assert!(!stage_over(&dir, 10_000));
}

#[test]
fn a_staging_folder_past_the_limit_is_over_budget_wherever_the_bytes_are() {
    let (_, dir) = state("budget-nested");
    let tree = dir.join("tree");
    let nested = tree.join("cache/deep");

    fs::create_dir_all(&nested).unwrap();
    fs::write(tree.join("a"), vec![0_u8; 600]).unwrap();
    assert!(!stage_over(&tree, 1000), "600 bytes fit in 1000");

    // The rest sits two folders down, as npm's cache does.
    fs::write(nested.join("b"), vec![0_u8; 600]).unwrap();
    assert!(stage_over(&tree, 1000), "1200 bytes do not");
    assert!(!stage_over(&tree, 1200), "the limit itself is allowed");
}

#[test]
fn an_npm_past_its_deadline_is_stopped() {
    let (_, dir) = state("timeout");
    let (node, npm, _) = fake_tools(&dir);
    let (prefix, home) = (dir.join("prefix"), dir.join("home"));

    fs::create_dir_all(&prefix).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(&npm, "#!/usr/bin/env node\nsleep 60\n").unwrap();

    // A deadline already past when npm is first looked at.
    let limits = Limits {
        npm_timeout: Duration::ZERO,
        ..LIMITS
    };
    let error = run_npm(
        &node,
        &npm,
        &prefix,
        &dir.join("package.tgz"),
        &home,
        &dir,
        &limits,
    )
    .unwrap_err();

    assert!(error.contains("took too long"), "{error}");
}

/// Whether the process is gone: not there at all, or a zombie that only waits to be reaped (its parent was killed
/// with it, and where nothing adopts orphans it stays).
fn process_is_gone(pid: i32) -> bool {
    // SAFETY: plain syscall with no memory arguments; signal 0 only checks that the process exists.
    if unsafe { libc::kill(pid, 0) } != 0 {
        return true;
    }

    Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .is_ok_and(|output| {
            let state = String::from_utf8_lossy(&output.stdout);

            state.trim().is_empty() || state.trim().starts_with('Z')
        })
}

#[test]
fn stopping_npm_kills_what_npm_started_too() {
    let (state, dir) = state("group-kill");
    let (node, npm, _) = fake_tools(&dir);
    let pid_file = dir.join("helper.pid");
    let bytes = tarball(&manifest(), &[]);
    let mut script = fs::read_to_string(&npm).unwrap();

    // A helper that would outlive its parent unless the whole group is signalled, with its pid written before npm
    // writes past the budget (the stop only happens after that).
    script.push_str(&format!(
        "sleep 60 &\necho $! > '{}'\nhead -c 300000 /dev/zero > \"$prefix/big.bin\"\nwait\n",
        pid_file.display()
    ));
    fs::write(&npm, script).unwrap();

    let limits = Limits {
        stage_bytes: 100_000,
        ..LIMITS
    };

    assert!(state
        .acp_install_npm_within(
            request(&state, &node, &npm, &bytes, integrity(&bytes)),
            &limits,
        )
        .is_err());

    let pid: i32 = fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();

    // The kernel needs a moment to deliver the signal.
    let gone = (0..50).any(|_| {
        std::thread::sleep(Duration::from_millis(100));

        process_is_gone(pid)
    });

    assert!(gone, "the helper npm started is still running");
}

#[test]
fn a_multi_call_node_shim_is_recorded_by_the_name_it_runs_under() {
    use std::os::unix::fs::PermissionsExt;

    let (state, dir) = state("node-shim");
    let (real, npm, _) = fake_tools(&dir);
    let shim = dir.join("version-shim");
    let link = dir.join("bin-node/node");

    // Decides what to be from the name it was started as, as mise and Volta shims do: as `node` it runs the script
    // it is given, or reports itself when it has none.
    fs::write(
        &shim,
        "#!/bin/sh\ncase \"$(basename \"$0\")\" in node) if [ $# -eq 0 ]; then echo node-ok; else exec /bin/sh \"$@\"; fi ;; *) echo shim-needs-a-name >&2; exit 3 ;; esac\n",
    )
    .unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    fs::remove_file(&real).unwrap();
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&shim, &link).unwrap();

    let bytes = tarball(&manifest(), &[]);
    let view = state
        .acp_install_npm(request(&state, &link, &npm, &bytes, integrity(&bytes)))
        .unwrap();
    let output = Command::new(&view.agents[0].command).output().unwrap();

    assert!(output.status.success(), "the recorded command runs as node");
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "node-ok");
}

/// Whether the file `npm` names, links followed, is one node can run: what the installer needs to run it.
fn npm_runs_under_node(npm: &Path) -> bool {
    fs::canonicalize(npm).is_ok_and(|resolved| runs_under_node(&resolved))
}

#[test]
fn an_npm_that_is_a_launcher_is_not_a_real_tool() {
    let (_, dir) = state("npm-launcher");
    let shim = dir.join("npm");
    let script = dir.join("npm-cli.js");
    let linked = dir.join("bin-npm");

    fs::write(&shim, "#!/bin/sh\nexec volta run npm \"$@\"\n").unwrap();
    fs::write(&script, "console.log('npm');\n").unwrap();
    std::os::unix::fs::symlink(&script, &linked).unwrap();

    assert!(!npm_runs_under_node(&shim));
    assert!(npm_runs_under_node(&script));
    assert!(npm_runs_under_node(&linked), "a link to the script counts");
}

/// A real `node` and `npm` from the PATH, or `None`. `NEORE_REQUIRE_NPM=1` turns a missing one, or an npm that
/// is a launcher, into a failure.
fn real_tools() -> Option<(PathBuf, PathBuf)> {
    let find = |name: &str| {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    };

    choose_real_tools(
        find("node"),
        find("npm"),
        std::env::var_os("NEORE_REQUIRE_NPM").is_some(),
    )
}

fn choose_real_tools(
    node: Option<PathBuf>,
    npm: Option<PathBuf>,
    required: bool,
) -> Option<(PathBuf, PathBuf)> {
    let unusable = match (&node, &npm) {
        (Some(_), Some(npm)) if npm_runs_under_node(npm) => None,
        (Some(_), Some(_)) => Some(
            "npm on PATH is a launcher (a version-manager shim or a native program), not a JavaScript file",
        ),
        _ => Some("node and npm were not found on PATH"),
    };

    match (unusable, node, npm) {
        (None, Some(node), Some(npm)) => Some((node, npm)),
        (reason, _, _) => {
            let reason = reason.unwrap_or("node and npm were not found on PATH");

            assert!(!required, "NEORE_REQUIRE_NPM is set but {reason}");
            eprintln!("skipped: {reason}");

            None
        }
    }
}

#[test]
fn a_required_npm_that_is_a_launcher_fails_instead_of_skipping() {
    let (_, dir) = state("require-npm");
    let node = dir.join("node");
    let shim = dir.join("npm");

    fs::write(&node, "#!/bin/sh\n").unwrap();
    fs::write(&shim, "#!/bin/sh\nexec volta run npm \"$@\"\n").unwrap();

    assert!(choose_real_tools(Some(node.clone()), Some(shim.clone()), false).is_none());
    assert!(
        std::panic::catch_unwind(|| choose_real_tools(Some(node), Some(shim), true)).is_err(),
        "a required npm must not be skipped"
    );
    assert!(std::panic::catch_unwind(|| choose_real_tools(None, None, true)).is_err());
}

fn marker_package(marker: &Path) -> Vec<u8> {
    let script = format!(
        "require('fs').writeFileSync({}, 'ran');\n",
        serde_json::to_string(&marker.to_string_lossy()).unwrap()
    );
    let manifest = json!({
        "name": PACKAGE, "version": "1.0.0", "bin": { PACKAGE: "cli.js" },
        "scripts": {
            "preinstall": "node marker.js", "install": "node marker.js",
            "postinstall": "node marker.js", "prepare": "node marker.js"
        }
    });

    tarball(&manifest, &[("marker.js", &script)])
}

#[test]
fn no_lifecycle_script_runs_during_an_install() {
    let Some((node, npm)) = real_tools() else {
        return;
    };
    let (state, dir) = state("scripts");
    let marker = dir.join("script-ran");
    let bytes = marker_package(&marker);

    // The control: the same package, installed by npm without the flag, does run its script. Without this the
    // assertion below could pass for a fixture whose scripts never run.
    let control = dir.join("control");

    fs::create_dir_all(&control).unwrap();

    let tgz = control.join("package.tgz");

    fs::write(&tgz, &bytes).unwrap();

    let status = Command::new(&npm)
        .args([
            "install",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            "--prefix",
        ])
        .arg(&control)
        .arg(&tgz)
        .env_clear()
        .env("npm_config_ignore_scripts", "false")
        .env("npm_config_userconfig", control.join("userrc"))
        .env("npm_config_globalconfig", control.join("globalrc"))
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", node.parent().unwrap().display()),
        )
        .env("HOME", &control)
        .env("npm_config_cache", control.join("cache"))
        .output()
        .unwrap();

    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(
        marker.exists(),
        "the control install should have run the fixture's scripts"
    );
    fs::remove_file(&marker).unwrap();

    let view = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap();

    assert_eq!(view.agents.len(), 1);
    assert!(
        !marker.exists(),
        "a lifecycle script ran during the install"
    );
    assert!(state.acp_spawn_plan("fixture", None).is_ok());
}

#[test]
fn a_real_npm_install_runs_the_package_with_the_pinned_node() {
    let Some((node, npm)) = real_tools() else {
        return;
    };
    let (state, dir) = state("real");
    let bytes = tarball(&manifest(), &[]);
    let view = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap();
    let agent = &view.agents[0];
    let output = Command::new(&agent.command)
        .args(&agent.args[..1])
        .output()
        .unwrap();

    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
    assert!(installed(&dir)
        .join("node_modules")
        .join(PACKAGE)
        .join("cli.js")
        .is_file());
}

#[test]
fn an_unreadable_part_of_the_staging_folder_counts_as_over_budget() {
    use std::os::unix::fs::PermissionsExt;

    let (_, dir) = state("budget-unreadable");
    let tree = dir.join("tree");
    let hidden = tree.join("hidden");

    fs::create_dir_all(&hidden).unwrap();
    fs::write(hidden.join("big"), vec![0_u8; 5000]).unwrap();
    assert!(!stage_over(&tree, 10_000), "readable and small");

    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o000)).unwrap();

    let readable_anyway = fs::read_dir(&hidden).is_ok();
    let over = stage_over(&tree, 10_000);

    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o700)).unwrap();

    if readable_anyway {
        eprintln!("skipped: this user can read a folder with no permissions (root)");

        return;
    }

    assert!(over, "what cannot be counted must not pass the cap");
}

#[test]
fn what_npm_left_running_is_stopped_when_it_exits_whatever_the_status() {
    for code in [0, 1] {
        let (_, dir) = state(&format!("helper-left-{code}"));
        let (node, npm, _) = fake_tools(&dir);
        let pid_file = dir.join("helper.pid");
        let (prefix, home) = (dir.join("prefix"), dir.join("home"));

        fs::create_dir_all(&prefix).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(
            &npm,
            format!(
                "#!/usr/bin/env node\nsleep 60 &\necho $! > '{}'\nexit {code}\n",
                pid_file.display()
            ),
        )
        .unwrap();

        let result = run_npm(
            &node,
            &npm,
            &prefix,
            &dir.join("package.tgz"),
            &home,
            &dir,
            &LIMITS,
        );

        assert_eq!(result.is_ok(), code == 0, "{result:?}");

        let pid: i32 = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let gone = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(100));

            process_is_gone(pid)
        });

        assert!(gone, "the helper outlived npm (exit {code})");
    }
}
