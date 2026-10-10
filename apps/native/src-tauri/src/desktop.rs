//! Desktop-only: tray, global shortcut, Quick Composer window, hide-on-close
//! and the auto-updater.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::{focus_main, hand_off_compose, log, site, start_browser_sign_in, MAIN_WINDOW};

pub const QUICK_COMPOSER: &str = "quick-composer";
const QUICK_COMPOSER_SHORTCUT: &str = "CommandOrControl+Shift+Space";

pub fn setup<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    tray(app)?;
    shortcut(app);
    hide_main_on_close(app);
    updater(app);

    Ok(())
}

fn tray<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Neore", true, None::<&str>)?;
    let compose = MenuItem::with_id(
        app,
        "compose",
        "Quick Composer",
        true,
        Some(QUICK_COMPOSER_SHORTCUT),
    )?;
    let sign_in = MenuItem::with_id(app, "sign-in", "Sign in with browser", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Neore", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &compose, &sign_in, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Neore")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => focus_main(app),
            "compose" => toggle_quick_composer(app),
            "sign-in" => start_browser_sign_in(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;

    Ok(())
}

/// A global shortcut can be taken by another app, and Wayland has no global
/// shortcuts at all — so a failure is logged, never fatal.
fn shortcut<R: Runtime>(app: &App<R>) {
    let result =
        app.global_shortcut()
            .on_shortcut(QUICK_COMPOSER_SHORTCUT, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_quick_composer(app);
                }
            });

    if let Err(error) = result {
        log(&format!(
            "could not register {QUICK_COMPOSER_SHORTCUT}: {error}"
        ));
    }
}

/// Closing the main window keeps the app in the tray (and the shortcut alive);
/// "Quit Neore" in the tray menu exits.
fn hide_main_on_close<R: Runtime>(app: &App<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let hidden = window.clone();

    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
    });
}

pub fn toggle_quick_composer<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(QUICK_COMPOSER) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
        }

        return;
    }

    // A LOCAL page (`src/quick-composer.html`), not the remote app: it opens
    // instantly, works offline, and gets only its own two commands.
    let built = WebviewWindowBuilder::new(
        app,
        QUICK_COMPOSER,
        WebviewUrl::App("quick-composer.html".into()),
    )
    .title("Quick Composer")
    .inner_size(620.0, 168.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .focused(true)
    .build();

    match built {
        Ok(window) => {
            let blurred = window.clone();

            window.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = blurred.hide();
                }
            });
        }
        Err(error) => log(&format!("could not open the Quick Composer: {error}")),
    }
}

/// Called by the Quick Composer: hand the text to a new chat in the main window.
#[tauri::command]
pub fn quick_compose<R: Runtime>(app: AppHandle<R>, text: String) -> Result<(), String> {
    let text = site::clamp_text(&text, site::MAX_COMPOSE_CHARS);

    if text.is_empty() {
        return Err("nothing to send".into());
    }

    if let Some(window) = app.get_webview_window(QUICK_COMPOSER) {
        let _ = window.hide();
    }

    hand_off_compose(&app, text);

    Ok(())
}

#[tauri::command]
pub fn close_quick_composer<R: Runtime>(app: AppHandle<R>) {
    if let Some(window) = app.get_webview_window(QUICK_COMPOSER) {
        let _ = window.hide();
    }
}

/// The updater plugin REQUIRES `plugins.updater` (endpoints + pubkey) and fails
/// to initialise without it. The committed config has none — release CI merges
/// `tauri.updater.conf.json` — so an unconfigured build simply has no updater.
fn updater<R: Runtime>(app: &App<R>) {
    if !app.config().plugins.0.contains_key("updater") {
        return;
    }

    if let Err(error) = app
        .handle()
        .plugin(tauri_plugin_updater::Builder::new().build())
    {
        log(&format!("updater disabled: {error}"));

        return;
    }

    let handle = app.handle().clone();

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;

        let update = match handle.updater() {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };

        match update {
            Ok(Some(update)) => {
                let version = update.version.clone();

                match update.download_and_install(|_, _| {}, || {}).await {
                    // Applied on the next launch; a restart mid-reply would lose the stream.
                    Ok(()) => {
                        let _ = handle
                            .notification()
                            .builder()
                            .title("Neore update installed")
                            .body(format!(
                                "Version {version} will be used after you restart Neore."
                            ))
                            .show();
                    }
                    Err(error) => log(&format!("update {version} failed: {error}")),
                }
            }
            Ok(None) => {}
            Err(error) => log(&format!("update check failed: {error}")),
        }
    });
}
