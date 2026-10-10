fn main() {
    println!("cargo:rerun-if-env-changed=NEORE_SITE_URL");

    // A release build must say which deployment it wraps. There is no sensible
    // default: a guessed origin would ship an app that loads the wrong site and
    // grants IPC to it.
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var("NEORE_SITE_URL").is_err()
    {
        panic!("NEORE_SITE_URL must be set for a release build, e.g. NEORE_SITE_URL=https://app.example.com");
    }

    // Declaring the app's commands turns each into an `allow-<command>`
    // permission that a capability must grant. Without this manifest every
    // `#[tauri::command]` is callable from any window the IPC reaches.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "notify",
            "take_pending_compose",
            "start_browser_sign_in_command",
            "take_pending_sign_in",
            "quick_compose",
            "close_quick_composer",
            "device_status",
            "device_pair",
            "device_manifest",
            "device_execute",
            "device_open_settings",
            "device_prompt_current",
            "device_prompt_answer",
            "device_settings_get",
            "device_settings_update",
            "device_pick_folder",
            "device_audit_tail",
        ]),
    ))
    .expect("failed to run tauri-build");
}
