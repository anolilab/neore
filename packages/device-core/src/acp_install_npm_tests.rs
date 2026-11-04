use super::*;
use std::io::Write;

const PACKAGE: &str = "fixture-agent";

/// The state over a folder that is removed when the returned guard drops.
fn state(name: &str) -> (DeviceState, tempfile::TempDir) {
    let dir = tempfile::Builder::new()
        .prefix(&format!("neore-acp-npm-{name}-"))
        .tempdir()
        .unwrap();

    (DeviceState::new(dir.path(), Box::new(|_| {})), dir)
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

    fs::write(&node, "#!/bin/sh\n").unwrap();
    fs::write(
        &npm,
        format!(
            "#!/bin/sh\necho \"$@\" > '{}'\nfor last; do :; done\nprefix=''\nwhile [ $# -gt 0 ]; do [ \"$1\" = --prefix ] && prefix=\"$2\"; shift; done\nmkdir -p \"$prefix/node_modules/{PACKAGE}\"\ntar xzf \"$last\" -C \"$prefix/node_modules/{PACKAGE}\" --strip-components=1\n",
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
        npm: npm.to_string_lossy().into_owned(),
        package: PACKAGE.into(),
        publisher: "Example Inc.".into(),
        source: "https://registry.npmjs.org/fixture-agent/-/fixture-agent-1.0.0.tgz".into(),
        version: "1.0.0".into(),
    }
}

fn installed(dir: &Path) -> PathBuf {
    dir.join("acp-agents/fixture/1.0.0")
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
    let (state, guard) = state("mismatch");
    let dir = guard.path().to_path_buf();
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
    let (state, guard) = state("pin");
    let dir = guard.path().to_path_buf();
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
        fs::canonicalize(&node).unwrap(),
        "the command is the interpreter resolved"
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
fn a_changed_added_or_removed_file_refuses_the_start_and_says_so() {
    let (state, guard) = state("recheck");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);

    state
        .acp_install_npm(request(
            &state,
            &node,
            &npm,
            &bytes.clone(),
            integrity(&bytes),
        ))
        .unwrap();

    let script = installed(&dir)
        .join("node_modules")
        .join(PACKAGE)
        .join("cli.js");
    let untouched = state.acp_spawn_plan("fixture", None).unwrap();

    assert_eq!(
        Path::new(&untouched.command),
        fs::canonicalize(&node).unwrap()
    );

    fs::write(&script, "console.log('changed');\n").unwrap();
    let changed = state.acp_spawn_plan("fixture", None).unwrap_err();
    assert!(
        changed.contains("no longer matches the files recorded"),
        "{changed}"
    );

    fs::write(&script, "console.log('hello');\n").unwrap();
    assert!(
        state.acp_spawn_plan("fixture", None).is_ok(),
        "restoring the bytes restores the start"
    );

    fs::write(
        installed(&dir)
            .join("node_modules")
            .join(PACKAGE)
            .join("extra.js"),
        "x",
    )
    .unwrap();
    assert!(state.acp_spawn_plan("fixture", None).is_err());
    fs::remove_file(
        installed(&dir)
            .join("node_modules")
            .join(PACKAGE)
            .join("extra.js"),
    )
    .unwrap();

    fs::remove_file(&script).unwrap();
    assert!(state.acp_spawn_plan("fixture", None).is_err());
}

#[test]
fn a_missing_install_folder_refuses_the_start() {
    let (state, guard) = state("missing");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);

    state
        .acp_install_npm(request(
            &state,
            &node,
            &npm,
            &bytes.clone(),
            integrity(&bytes),
        ))
        .unwrap();
    fs::remove_dir_all(installed(&dir)).unwrap();

    assert!(state.acp_spawn_plan("fixture", None).is_err());
}

#[test]
fn the_installed_package_must_be_the_one_that_was_pinned() {
    let (state, guard) = state("identity");
    let dir = guard.path().to_path_buf();
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
    let (state, guard) = state("bin");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);

    for manifest in [
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": "../outside.js" }),
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": "/bin/sh" }),
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": "missing.js" }),
        json!({ "name": PACKAGE, "version": "1.0.0", "bin": { "a": "cli.js", "b": "cli.js" } }),
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
fn editing_the_arguments_after_the_program_keeps_the_pin_and_the_check() {
    let (state, guard) = state("edit-args");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let view = state
        .acp_install_npm(request(
            &state,
            &node,
            &npm,
            &bytes.clone(),
            integrity(&bytes),
        ))
        .unwrap();
    let agent = &view.agents[0];
    let edit = |args: Vec<String>| {
        state
            .acp_update(
                serde_json::from_value(json!({
                    "op": "saveAgent", "key": "fixture", "label": "Fixture", "command": agent.command, "args": args,
                }))
                .unwrap(),
            )
            .unwrap()
    };
    let script = agent.args[0].clone();

    // A trailing argument changes: still the pinned program, still hashed at every start.
    let edited = edit(vec![script.clone(), "--other".into()]);

    assert!(edited.agents[0].install.is_some());
    assert!(Path::new(&script).is_file());
    assert!(state.acp_spawn_plan("fixture", None).is_ok());
    fs::write(&script, "changed").unwrap();
    assert!(state.acp_spawn_plan("fixture", None).is_err());
    fs::write(&script, "console.log('hello');\n").unwrap();

    // Only the interpreter changes (a Node upgrade moved it): the program is the same, so the check stays on.
    let new_node = state
        .acp_update(
            serde_json::from_value(json!({
                "op": "saveAgent", "key": "fixture", "label": "Fixture", "command": "/opt/other/node", "args": [script.clone()],
            }))
            .unwrap(),
        )
        .unwrap();

    assert!(new_node.agents[0].install.is_some());
    fs::write(&script, "changed").unwrap();
    assert!(state.acp_spawn_plan("fixture", None).is_err());
    fs::write(&script, "console.log('hello');\n").unwrap();

    // The program itself is replaced: no longer the install, and its files go with it, as for a binary.
    let moved = edit(vec!["/elsewhere/agent.js".into()]);

    assert!(moved.agents[0].install.is_none());
    assert!(!installed(&dir).exists());
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
    let (state, guard) = state("tools");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let base = |state: &DeviceState| request(state, &node, &npm, &bytes, integrity(&bytes));

    for change in [
        |r: &mut NpmInstallRequest| r.node = "node".into(),
        |r: &mut NpmInstallRequest| r.npm = "/nonexistent/npm".into(),
        |r: &mut NpmInstallRequest| r.package = "../evil".into(),
        |r: &mut NpmInstallRequest| r.package = "Fixture Agent".into(),
        |r: &mut NpmInstallRequest| r.integrity = "sha1-nope".into(),
        |r: &mut NpmInstallRequest| r.version = "latest".into(),
        |r: &mut NpmInstallRequest| {
            r.env.insert("NODE_OPTIONS".into(), "--require x".into());
        },
    ] {
        let mut r = base(&state);

        change(&mut r);
        assert!(state.acp_install_npm(r).is_err());
    }

    assert!(valid_package_name("@scope/agent-x"));
    assert!(!valid_package_name("@scope"));
    assert!(!valid_package_name("a/b"));
}

#[test]
fn only_a_download_in_a_staging_folder_is_installed() {
    let (state, guard) = state("outside");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let mut r = request(&state, &node, &npm, &bytes, integrity(&bytes));
    let elsewhere = dir.join("elsewhere.tgz");

    fs::write(&elsewhere, &bytes).unwrap();
    r.archive = elsewhere.to_string_lossy().into_owned();

    assert!(state.acp_install_npm(r).is_err());
}

/// A real `node` and `npm` from the PATH, or `None`. `NEORE_REQUIRE_NPM=1` turns a missing one into a failure.
fn real_tools() -> Option<(PathBuf, PathBuf)> {
    let find = |name: &str| {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    };

    match (find("node"), find("npm")) {
        (Some(node), Some(npm)) => Some((node, npm)),
        _ => {
            assert!(
                std::env::var_os("NEORE_REQUIRE_NPM").is_none(),
                "NEORE_REQUIRE_NPM is set but node and npm were not found on PATH"
            );
            eprintln!("skipped: node and npm are not on PATH");

            None
        }
    }
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
    let (state, guard) = state("scripts");
    let dir = guard.path().to_path_buf();
    let marker = dir.join("script-ran");
    let bytes = marker_package(&marker);

    // The control: the same package, installed by npm without the flag, does run its script. Without this
    // the assertion below could pass for a fixture whose scripts never run.
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
    let (state, guard) = state("real");
    let dir = guard.path().to_path_buf();
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
fn a_link_out_of_the_package_is_refused_and_one_inside_is_hashed() {
    let guard = tempfile::tempdir().unwrap();
    let root = guard.path().join("tree");
    let outside = guard.path().join("outside.js");

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

    // Through a folder that is itself a link out.
    std::os::unix::fs::symlink(guard.path(), root.join("hop")).unwrap();
    assert!(tree_hash(&root).is_err());
}

#[test]
fn a_program_node_cannot_run_is_refused_before_anything_is_recorded() {
    let (state, guard) = state("not-js");
    let dir = guard.path().to_path_buf();
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
fn a_small_staging_folder_is_within_budget() {
    let guard = tempfile::tempdir().unwrap();

    fs::write(guard.path().join("a"), vec![0_u8; 4096]).unwrap();
    assert!(!stage_over_budget(guard.path()));
}

#[test]
fn a_staging_folder_past_the_limit_is_over_budget_wherever_the_bytes_are() {
    let guard = tempfile::tempdir().unwrap();
    let nested = guard.path().join("cache/deep");

    fs::create_dir_all(&nested).unwrap();
    fs::write(guard.path().join("a"), vec![0_u8; 600]).unwrap();
    assert!(!stage_over(guard.path(), 1000), "600 bytes fit in 1000");

    // The rest sits two folders down, as npm's cache does.
    fs::write(nested.join("b"), vec![0_u8; 600]).unwrap();
    assert!(stage_over(guard.path(), 1000), "1200 bytes do not");
    assert!(
        !stage_over(guard.path(), 1200),
        "the limit itself is allowed"
    );
}

#[test]
fn a_tarball_swapped_after_the_check_is_refused() {
    let (state, guard) = state("swap");
    let dir = guard.path().to_path_buf();
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
fn a_node_that_is_gone_stops_the_start_with_a_message_that_names_it() {
    let (state, guard) = state("node-gone");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);

    state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap();
    assert!(state.acp_spawn_plan("fixture", None).is_ok());
    fs::remove_file(&node).unwrap();

    let error = state.acp_spawn_plan("fixture", None).unwrap_err();

    assert!(
        error.contains("which is gone") && error.contains("Reinstall"),
        "{error}"
    );
}

#[test]
fn names_that_differ_only_in_bytes_no_text_keeps_hash_differently() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();

    // APFS refuses a name that is not valid UTF-8; there the case cannot arise and the test has nothing to say.
    if fs::write(first.path().join(OsStr::from_bytes(b"a\xff")), "x").is_err() {
        return;
    }

    fs::write(second.path().join(OsStr::from_bytes(b"a\xfe")), "x").unwrap();
    assert_ne!(
        tree_hash(first.path()).unwrap(),
        tree_hash(second.path()).unwrap()
    );
}

#[test]
fn installs_of_one_version_that_overlap_leave_one_working_install() {
    let (state, guard) = state("overlap");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let requests: Vec<_> = (0..4)
        .map(|_| request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .collect();

    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = requests
            .into_iter()
            .map(|request| scope.spawn(|| state.acp_install_npm(request)))
            .collect();

        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    assert!(results.iter().all(Result::is_ok), "{results:?}");
    assert_eq!(state.acp_view().agents.len(), 1, "one agent is recorded");
    assert!(
        state.acp_spawn_plan("fixture", None).is_ok(),
        "the recorded install still starts"
    );
}

#[test]
fn a_pinned_agent_cannot_be_pointed_at_a_node_that_is_not_a_full_path() {
    let (state, guard) = state("bare-node");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);
    let bytes = tarball(&manifest(), &[]);
    let view = state
        .acp_install_npm(request(&state, &node, &npm, &bytes, integrity(&bytes)))
        .unwrap();
    let script = view.agents[0].args[0].clone();
    let error = state
        .acp_update(
            serde_json::from_value(json!({
                "op": "saveAgent", "key": "fixture", "label": "Fixture", "command": "node", "args": [script],
            }))
            .unwrap(),
        )
        .unwrap_err();

    assert!(error.contains("full path of Node.js"), "{error}");
    assert!(
        state.acp_view().agents[0].install.is_some(),
        "the pin is untouched"
    );
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
fn a_removal_and_a_reinstall_that_overlap_leave_files_that_match_the_record() {
    let (state, guard) = state("remove-race");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);

    state
        .acp_install_npm(request_for(&state, &node, &npm, "1.0.0"))
        .unwrap();

    for _ in 0..6 {
        let again = request_for(&state, &node, &npm, "1.0.0");

        std::thread::scope(|scope| {
            scope.spawn(|| state.acp_install_npm(again).unwrap());
            scope.spawn(|| {
                state
                    .acp_update(
                        serde_json::from_value(json!({ "op": "removeAgent", "key": "fixture" }))
                            .unwrap(),
                    )
                    .unwrap()
            });
        });

        let recorded = !state.acp_view().agents.is_empty();

        assert_eq!(
            installed(&dir).exists(),
            recorded,
            "the files exist exactly when the agent is recorded"
        );

        if recorded {
            assert!(
                state.acp_spawn_plan("fixture", None).is_ok(),
                "a recorded install starts"
            );
        } else {
            state
                .acp_install_npm(request_for(&state, &node, &npm, "1.0.0"))
                .unwrap();
        }
    }
}

#[test]
fn pruning_never_deletes_the_version_a_concurrent_install_pinned() {
    let (state, guard) = state("prune-race");
    let dir = guard.path().to_path_buf();
    let (node, npm, _) = fake_tools(&dir);

    state
        .acp_install_npm(request_for(&state, &node, &npm, "1.0.0"))
        .unwrap();

    let second = request_for(&state, &node, &npm, "2.0.0");

    std::thread::scope(|scope| {
        scope.spawn(|| state.acp_install_npm(second).unwrap());
        scope.spawn(|| {
            for _ in 0..50 {
                state.acp_install_prune("fixture");
            }
        });
    });
    state.acp_install_prune("fixture");

    let view = state.acp_view();
    let pinned = &view.agents[0].install.as_ref().unwrap().version;

    assert_eq!(pinned, "2.0.0", "the later install is the record");
    assert!(
        dir.join("acp-agents/fixture").join(pinned).exists(),
        "the pinned version is still on disk"
    );
    assert!(
        !dir.join("acp-agents/fixture/1.0.0").exists(),
        "the old version is pruned"
    );
    assert!(state.acp_spawn_plan("fixture", None).is_ok());
}

#[test]
fn a_node_reached_through_a_link_with_another_name_installs() {
    let (state, guard) = state("node-link");
    let dir = guard.path().to_path_buf();
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
        fs::canonicalize(&nodejs).unwrap(),
        "the recorded command is the file the link resolves to"
    );
    assert!(state.acp_spawn_plan("fixture", None).is_ok());
}
