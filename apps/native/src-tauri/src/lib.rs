//! Neore's native shell: one Tauri v2 codebase for macOS, Windows, Linux, iOS
//! and Android around the DEPLOYED web app. Nothing of the web app is bundled;
//! the main window loads `NEORE_SITE_URL` (see `site.rs`).
//!
//! IPC surface, least privilege: the remote origin may call `notify`,
//! `take_pending_compose`, `start_browser_sign_in` and `take_pending_sign_in`,
//! on desktop the five `device_*` relay commands (`device/mod.rs`), and listen
//! to events — nothing else, and no plugin command at all. Every plugin
//! (notification, opener, updater, deep link, dialog) is driven from Rust. The
//! local Quick Composer window may call only its own two commands
//! (`capabilities/quick-composer.json`), and the local device window only its
//! approval and settings commands (`capabilities/device.json`).

use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod device;
mod sign_in;
mod site;

use sign_in::{PendingSignIn, SignInHandoff};
use site::DeepLink;

pub const MAIN_WINDOW: &str = "main";

/// Emitted to the main window when text is waiting in `PendingCompose`. It
/// carries no payload: the page pulls the text with `take_pending_compose`,
/// which also covers the cold start where the page was not listening yet.
pub const COMPOSE_EVENT: &str = "neore:compose";

/// Text handed to the web app for a new chat (Quick Composer, deep link, share).
#[derive(Default)]
pub struct PendingCompose(Mutex<Option<String>>);

pub struct Site(pub Url);

/// Emitted to the main window when a system-browser sign-in came back; the page
/// pulls the code and verifier with `take_pending_sign_in` (see `sign_in.rs`).
pub const SIGN_IN_EVENT: &str = "neore:sign-in";

/// The one system-browser sign-in this process is waiting for.
#[derive(Default)]
struct SignInFlow(Mutex<Option<PendingSignIn>>);

/// A completed callback, waiting for the page to exchange it.
#[derive(Default)]
struct PendingSignInHandoff(Mutex<Option<SignInHandoff>>);

/// Opens the grant page in the SYSTEM browser (see `sign_in.rs`).
pub fn start_browser_sign_in<R: Runtime>(app: &AppHandle<R>) {
    let (pending, url) = sign_in::begin(&app.state::<Site>().0);

    *app.state::<SignInFlow>().0.lock().unwrap() = Some(pending);

    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        log(&format!("could not open the browser for sign-in: {error}"));
    }
}

fn finish_browser_sign_in<R: Runtime>(app: &AppHandle<R>, code: String, state: &str) {
    let pending = app.state::<SignInFlow>().0.lock().unwrap().take();

    match sign_in::complete(pending, code, state, std::time::Instant::now()) {
        Ok(handoff) => {
            *app.state::<PendingSignInHandoff>().0.lock().unwrap() = Some(handoff);
            focus_main(app);
            let _ = app.emit_to(MAIN_WINDOW, SIGN_IN_EVENT, ());
        }
        Err(reason) => log(&format!("dropped a sign-in callback: {reason}")),
    }
}

/// Stores `text` for the web app, shows the main window and tells the page.
pub fn hand_off_compose<R: Runtime>(app: &AppHandle<R>, text: String) {
    if let Some(pending) = app.try_state::<PendingCompose>() {
        *pending.0.lock().unwrap() = Some(text);
    }

    focus_main(app);
    let _ = app.emit_to(MAIN_WINDOW, COMPOSE_EVENT, ());
}

pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        #[cfg(desktop)]
        {
            let _ = window.unminimize();
            let _ = window.show();
        }
        let _ = window.set_focus();
    }
}

fn navigate_main<R: Runtime>(app: &AppHandle<R>, url: Url) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.navigate(url);
    }
    focus_main(app);
}

fn handle_deep_links<R: Runtime>(app: &AppHandle<R>, urls: impl IntoIterator<Item = Url>) {
    let origin = &app.state::<Site>().0;

    for link in urls {
        if let Some((code, state)) = sign_in::parse_callback(&link) {
            finish_browser_sign_in(app, code, &state);
            continue;
        }

        match site::parse_deep_link(origin, &link) {
            Some(DeepLink::Open(url)) => navigate_main(app, url),
            Some(DeepLink::Compose(text)) => hand_off_compose(app, text),
            Some(DeepLink::Focus) => focus_main(app),
            None => log(&format!("ignored deep link {link}")),
        }
    }
}

fn log(message: &str) {
    eprintln!("[neore-native] {message}");
}

/// Shows a system notification for a finished reply, task or agent run. The
/// page decides WHAT is worth notifying; this only suppresses it while the
/// user is looking at the app anyway.
#[tauri::command]
fn notify<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if window.is_focused().unwrap_or(false) && window.is_visible().unwrap_or(false) {
            return Ok(());
        }
    }

    let title = site::clamp_text(&title, 120);

    if title.is_empty() {
        return Err("title is required".into());
    }

    let mut builder = app.notification().builder().title(title);

    if let Some(body) = body
        .map(|body| site::clamp_text(&body, 300))
        .filter(|body| !body.is_empty())
    {
        builder = builder.body(body);
    }

    builder.show().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_browser_sign_in_command<R: Runtime>(app: AppHandle<R>) {
    start_browser_sign_in(&app);
}

#[tauri::command]
fn take_pending_sign_in(pending: State<'_, PendingSignInHandoff>) -> Option<SignInHandoff> {
    pending.0.lock().unwrap().take()
}

#[tauri::command]
fn take_pending_compose(pending: State<'_, PendingCompose>) -> Option<String> {
    pending.0.lock().unwrap().take()
}

fn main_window<R: Runtime>(app: &tauri::App<R>, origin: &Url) -> tauri::Result<()> {
    let handle = app.handle().clone();
    let site = origin.clone();
    let navigating = app.handle().clone();

    let builder = WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW,
        WebviewUrl::External(site::new_chat_url(origin)),
    )
    // Google refuses embedded webviews: instead of its error page, run the
    // sign-in in the system browser and come back through `neore://`.
    .on_navigation(move |url| {
        if sign_in::is_blocked_oauth_host(url) {
            start_browser_sign_in(&navigating);

            return false;
        }

        true
    });

    #[cfg(desktop)]
    let builder = builder
        .title("Neore")
        .inner_size(1200.0, 820.0)
        .min_inner_size(420.0, 560.0)
        // `target="_blank"` / `window.open`: same-origin stays in the app,
        // everything else goes to the system browser, never a second webview.
        .on_new_window(move |url, _features| {
            if site::is_same_origin(&site, &url) {
                navigate_main(&handle, url);
            } else if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = handle.opener().open_url(url.as_str(), None::<&str>);
            }

            NewWindowResponse::Deny
        });

    #[cfg(mobile)]
    let _ = (handle, site);

    builder.build()?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let origin = site::site_origin();

    let mut builder = tauri::Builder::default();

    // Must be the FIRST plugin: a second launch (incl. one started by a
    // `neore://` link) exits here and forwards its arguments to this instance,
    // where the deep-link plugin turns them into `on_open_url` events.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                focus_main(app)
            }))
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            // Driven from Rust only (`device::device_pick_folder`); no window is granted a dialog permission.
            .plugin(tauri_plugin_dialog::init());
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingCompose::default())
        .manage(SignInFlow::default())
        .manage(PendingSignInHandoff::default())
        .manage(Site(origin.clone()))
        .invoke_handler(tauri::generate_handler![
            notify,
            take_pending_compose,
            start_browser_sign_in_command,
            take_pending_sign_in,
            #[cfg(desktop)]
            desktop::quick_compose,
            #[cfg(desktop)]
            desktop::close_quick_composer,
            #[cfg(desktop)]
            device::device_status,
            #[cfg(desktop)]
            device::device_pair,
            #[cfg(desktop)]
            device::device_manifest,
            #[cfg(desktop)]
            device::device_execute,
            #[cfg(desktop)]
            device::device_open_settings,
            #[cfg(desktop)]
            device::device_prompt_current,
            #[cfg(desktop)]
            device::device_prompt_answer,
            #[cfg(desktop)]
            device::device_settings_get,
            #[cfg(desktop)]
            device::device_settings_update,
            #[cfg(desktop)]
            device::device_pick_folder,
            #[cfg(desktop)]
            device::device_audit_tail,
        ])
        .setup(move |app| {
            // Remote IPC, limited to the deployment's own origin and the main
            // window. Built at runtime because the origin is a build input;
            // a static capability file would have to hardcode it.
            let remote = CapabilityBuilder::new("remote-app")
                .remote(site::remote_pattern(&origin))
                .local(false)
                .window(MAIN_WINDOW)
                .permission("core:event:allow-listen")
                .permission("core:event:allow-unlisten")
                .permission("allow-notify")
                .permission("allow-take-pending-compose")
                .permission("allow-start-browser-sign-in-command")
                .permission("allow-take-pending-sign-in");

            // The device RELAY only: status, pairing request, manifest, execute
            // and opening the local window. Answering prompts and changing
            // settings are local-window commands the page can never reach.
            #[cfg(desktop)]
            let remote = remote
                .permission("allow-device-status")
                .permission("allow-device-pair")
                .permission("allow-device-manifest")
                .permission("allow-device-execute")
                .permission("allow-device-open-settings");

            app.add_capability(remote)?;

            main_window(app, &origin)?;

            #[cfg(desktop)]
            desktop::setup(app)?;

            #[cfg(desktop)]
            {
                let data_dir = app.path().app_data_dir()?;

                app.manage(device::DeviceState::new(&data_dir));

                // Idle local MCP servers are stopped after 10 minutes.
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    handle.state::<device::DeviceState>().reap_idle_servers();
                });
            }

            // Installers (deb/rpm/msi/nsis/dmg) register the scheme; a dev run or
            // an AppImage has to do it at runtime. On Linux that writes
            // `~/.local/share/applications/neore-native-handler.desktop` and a
            // `mimeapps.list` entry pointing at THIS binary.
            #[cfg(any(target_os = "linux", windows))]
            if cfg!(debug_assertions) || std::env::var_os("APPIMAGE").is_some() {
                if let Err(error) = app.deep_link().register_all() {
                    log(&format!("could not register the neore:// scheme: {error}"));
                }
            }

            let handle = app.handle().clone();
            app.deep_link()
                .on_open_url(move |event| handle_deep_links(&handle, event.urls()));

            // A cold start BY a link: the URL arrives before the listener exists.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                handle_deep_links(app.handle(), urls);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Neore native shell")
        .run(|_app, _event| {
            // Local MCP servers must not outlive the app.
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = _event {
                if let Some(state) = _app.try_state::<device::DeviceState>() {
                    state.stop_servers();
                }
            }
        });
}
