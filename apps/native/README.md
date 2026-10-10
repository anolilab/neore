# @neore/native — desktop and mobile shell (Tauri v2)

One Rust codebase for macOS, Windows, Linux, iOS and Android that **wraps the
deployed web app**. Nothing from `apps/web` is bundled: the main window loads
`NEORE_SITE_URL` and the app keeps working exactly as it does in a browser. What
the shell adds is native: a tray, a global Quick Composer, notifications,
`neore://` deep links, auto-update and a single-instance lock.

```bash
pnpm native:dev      # compiles against http://localhost:5173 (run `pnpm dev:app` yourself)
pnpm native:build    # NEORE_SITE_URL=https://your.deployment pnpm native:build
pnpm --filter @neore/native run test:rust    # unit tests (URL/deep-link parsing, device execution)
```

Needs a Rust toolchain plus the Tauri system dependencies
(<https://v2.tauri.app/start/prerequisites/>). On Linux that is
`libwebkit2gtk-4.1-dev`, `librsvg2-dev` and `libappindicator3-dev`.

## Layout

| Path                                         | What                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `src-tauri/src/lib.rs`                       | Entry point, main window, runtime capability, deep links, IPC commands |
| `src-tauri/src/desktop.rs`                   | Tray, global shortcut, Quick Composer window, hide-on-close, updater   |
| `src-tauri/src/site.rs`                      | The wrapped origin and every URL derived from it (unit-tested)         |
| `src-tauri/capabilities/quick-composer.json` | The Quick Composer window's two commands                               |
| `src-tauri/src/device/`                      | Device execution: envelope HMAC, files, shell, local MCP, approvals    |
| `src-tauri/capabilities/device.json`         | The local device window's approval and settings commands               |
| `src/device.*`                               | The LOCAL device window (approvals, shared folders, local MCP servers) |
| `src-tauri/tauri.updater.conf.json`          | Updater config, merged only by release builds (`--config`)             |
| `src/quick-composer.*`                       | The LOCAL Quick Composer page                                          |
| `apps/web/src/lib/native/`                   | The web side: `bridge.ts` (feature-detected no-ops) + `NativeBridge`   |

## Build-time configuration

- **`NEORE_SITE_URL`** — the origin the shell loads, and the ONLY origin granted
  IPC. Read at compile time (`option_env!`); `build.rs` refuses a release build
  without it, and there is deliberately no runtime override, because whoever
  could set it could point an IPC-capable window at another site. The dev
  fallback is `http://localhost:5173`.
- The app identifier is `de.anolilab.neore`. Changing it after a release breaks
  updates and the OS's notification/permission memory for installed users.

## Security model

### IPC: least privilege, remote limited to our origin

- **Remote** (the web app in the main window) gets a capability built at
  runtime with `CapabilityBuilder::remote("<NEORE_SITE_URL>/*")`, only for the
  `main` window, granting exactly: `allow-notify`, `allow-take-pending-compose`,
  `allow-start-browser-sign-in-command`, `allow-take-pending-sign-in`,
  `core:event:allow-listen`, `core:event:allow-unlisten`. **No plugin command is
  reachable from the page** — notifications, the opener, the updater and deep
  links are all driven from Rust. It is built at runtime because the origin is a
  build input; a static JSON capability would have to hardcode a domain.
- **Local** (the Quick Composer page) gets `allow-quick-compose` and
  `allow-close-quick-composer`, nothing else.
- **Desktop only**, the remote capability also grants the five device RELAY
  commands (`device_status`, `device_pair`, `device_manifest`,
  `device_execute`, `device_open_settings`). The approval and settings
  commands (`device_prompt_*`, `device_settings_*`, `device_pick_folder`,
  `device_audit_tail`) belong to the LOCAL `device` window alone
  (`capabilities/device.json`), so the page can relay calls but never approve
  one or widen what the shell shares. See "Device execution" below.
- `build.rs` declares the app's commands through `AppManifest`, which makes each
  one a permission. Without it every `#[tauri::command]` would be callable from
  any page the IPC reaches.
- Any other origin the main window navigates to (an OAuth provider, say) still
  gets Tauri's injected globals, but the ACL denies every call from it.
- `window.open` / `target="_blank"`: same-origin URLs load in the main window,
  everything else opens in the system browser — never in a second webview.

### CSP: the web app's policy is NOT loosened

Tauri's IPC first tries `fetch("ipc://localhost/…")` (`http://ipc.localhost` on
Windows). The web app's `connect-src` does not allow that, and deliberately so:
Tauri's `ipc-protocol.js` catches the failure and **falls back to the
`postMessage` IPC** (`window.ipc.postMessage`, injected by wry), permanently for
that page load. The cost is one console warning plus one CSP violation report per
page load, and a slower transport that our two tiny commands never notice.

The alternative — a user-agent- or query-flag-gated `connect-src` allowance in
`apps/web/src/middleware/security-middleware.ts` — was rejected: it forks the
CSP per client, a user agent is trivially spoofable, and `http://ipc.localhost`
resolves to loopback in a normal browser, so allowing it unconditionally would
open a loopback exfiltration path. If the fallback ever becomes a problem (large
payloads), gate it on a custom user agent set with
`WebviewWindowBuilder::user_agent` and add `Vary: User-Agent`.

The LOCAL Quick Composer has its own CSP in `tauri.conf.json`, which does allow
`ipc:` and `http://ipc.localhost`.

## Web ↔ shell bridge

`apps/web/src/lib/native/bridge.ts` detects the shell through `window.__TAURI__`
(`withGlobalTauri: true`) and is a no-op everywhere else. No `@tauri-apps/*`
package is added to the web app.

| Web → shell                     | Shell → web                                                   |
| ------------------------------- | ------------------------------------------------------------- |
| `notifyNative({ title, body })` | `neore:compose` → `take_pending_compose` → sent as a new chat |

- **Notifications**: `chat-context.tsx` calls `notifyNative` when a stream ends
  and it either ran ≥ 15 s or the page is hidden. The shell additionally drops it
  while the main window is focused. Other long-running work (tasks, coding-agent
  runs) should call the same `notifyNative` — it is safe to call anywhere.
- **Compose handoff** (Quick Composer, `neore://new?text=`, a share): the text
  waits in Rust until the page PULLS it, which covers a cold start where the page
  was not listening yet. The page then **sends it as a new chat**: it files a
  request on a request channel (`features/chat/core/utils/composer-submit.ts`)
  and opens `/chat`; the new-thread composer takes the request, fills the text
  and submits once it is ready. Only the bridge files such requests, so nothing
  in a plain browser ever sends a message by itself. If a composer guard refuses
  (a turn still running, an upload pending), the text stays in the composer.

## Desktop

- **Tray**: Open / Quick Composer / Quit. Closing the main window hides it; the
  app keeps running in the tray so the shortcut stays live.
- **Global shortcut** `CmdOrCtrl+Shift+Space` toggles the Quick Composer.
  Registration failure (taken by another app; Wayland has no global shortcuts)
  is logged, not fatal — the tray entry still works.
- **Single instance**: a second launch focuses the first; with the `deep-link`
  feature it also forwards a `neore://` URL to it.
- **Deep links**: `neore://thread/<id>` opens that thread (ids are validated
  against `[A-Za-z0-9_-]{1,128}`, never escaped into a path), `neore://new?text=…`
  prefills a new chat, `neore://` focuses the app. Anything else is ignored.
  Installers register the scheme; dev runs and AppImages register it at runtime,
  which on Linux writes `~/.local/share/applications/neore-native-handler.desktop`
  and a `mimeapps.list` entry pointing at the binary that ran.

### Auto-update

`tauri-plugin-updater` is compiled in but only **registered when
`plugins.updater` is present in the config**, because the plugin refuses to
initialise without endpoints and a pubkey. The committed `tauri.conf.json` has
none; release builds merge `src-tauri/tauri.updater.conf.json` with
`--config`. Before enabling it:

1. `pnpm --filter @neore/native tauri signer generate -w ~/.tauri/neore.key`
2. Put the **public** key in `tauri.updater.conf.json#plugins.updater.pubkey` and
   a real endpoint in `endpoints` (e.g. a `latest.json` that `tauri-action`
   uploads to the GitHub release). The public key is safe to commit.
3. Store the private key and its password as the CI secrets below.

An update is downloaded and installed in the background and applied on the next
launch — except on Windows, where the installer runs at once and closes the app.

## Device execution (desktop)

The agent can use tools that run on this computer — files in folders you
shared, a shell, and local MCP servers over stdio — through the relay in
docs/plans/device-execution.md. What the shell guarantees:

- **Every call is signed by the backend** for this device (HMAC-SHA256 with the
  pairing secret, over the exact payload string, domain-prefixed) and checked
  for device id, expiry and a one-time nonce before anything else. Results and
  the tool manifest are signed back the same way. `device/hmac.rs` is pinned by
  RFC 4231; `device/envelope.rs` shares its vectors with the backend.
- **You approve every call in the local `device` window**, which shows the
  thread, the tool and exactly what will happen (resolved paths, the command
  and its folder). Buttons stay disabled for 800 ms after a prompt appears, an
  unanswered prompt is denied at the call's deadline, and closing the window
  denies everything waiting. "Always allow" is never offered for `shell_run` or
  `fs_write`, nor for any call that follows web, knowledge, MCP, device or
  attached-file content (`taintedBy`) — and such a call prompts even when a rule
  exists. Rules are stored only here and cleared on every pairing.
- **Scope:** file tools and the shell's working folder are confined to the
  shared folders (canonicalised; `..` and symlink escapes refused; never a whole
  drive). Output is capped at 64 KiB, files at 1 MiB, shell commands at 10 min.
- **Shell sandbox** (`device/sandbox.rs`): an approved command can write only in
  the shared folders and a private per-run temp folder (`$TMPDIR`, removed
  afterwards; common caches — `XDG_CACHE_HOME`, npm, pip, uv, Go, yarn, bun —
  are pointed there unless already set inside a shared folder), reads only system folders and a short list of per-user
  toolchain folders (`~/.cargo/bin`, `~/.rustup`, `~/.nvm`, `~/.local/bin`, …
  — never `~/.ssh`, `~/.config`, all of `~/.cargo`), and cannot see the rest of
  `$HOME`. **Network is not restricted.** Linux: Landlock (kernel 5.13+,
  best-effort across ABIs, plus signal/abstract-socket scoping on 6.12+) with
  `PR_SET_NO_NEW_PRIVS`, applied between fork and exec — a child that cannot
  restrict itself never execs. macOS: `sandbox-exec` with a generated profile
  (paths passed as `-D` parameters; file names under `$HOME` stay `stat`-able).
  Windows: **no sandbox** — commands run in a kill-on-close Job Object (4 GiB
  cap) and are labelled unsandboxed. "Require sandbox for shell commands" (local
  window, **on by default**) refuses `shell_run` where there is no sandbox;
  every shell prompt states which it will be. Local MCP servers are NOT
  sandboxed.
- **Local MCP servers** are added only in the local window (the exact command
  line is confirmed), spawned on first use, stopped after 10 idle minutes and on
  exit. The web app cannot add or start one.
- **Pairing** (Settings → Devices in the app): the backend mints a secret, the
  page hands it to `device_pair` ONCE, and the shell stores it (0600, app data
  dir) only after you confirm in the local window. Unpair locally or remove the
  device on the web; either ends it.
- **Audit:** `<app data>/device-audit.jsonl` (rotated at 5 MB), also shown in
  the local window; the backend keeps its own 30-day log (Settings → Devices).
- `tauri-plugin-dialog` (the folder picker) is driven from Rust
  (`device_pick_folder`); no window holds a dialog permission.

## Release signing (CI secrets — none are configured)

`.github/workflows/native.yml` builds unsigned desktop bundles into a draft
release on a `native-v*` tag. Set the repository VARIABLE `NATIVE_SITE_URL`
first. To sign, add these secrets and uncomment them in the workflow:

| Secret                                                                                           | For                               |
| ------------------------------------------------------------------------------------------------ | --------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                                | Updater artifact signatures       |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`                      | macOS code signing (Developer ID) |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`                                                    | macOS notarization                |
| Windows: an Authenticode certificate (`bundle.windows.certificateThumbprint` or a `signCommand`) | SmartScreen reputation            |

## Mobile (iOS / Android)

The same crate builds for mobile (`lib.rs` carries `tauri::mobile_entry_point`;
the tray, shortcut, Quick Composer, single instance and updater are
`cfg(desktop)`). The native projects are not generated yet — that needs Xcode or
the Android SDK/NDK:

```bash
pnpm --filter @neore/native tauri android init   # writes src-tauri/gen/android
pnpm --filter @neore/native tauri ios init       # writes src-tauri/gen/apple (macOS only)
pnpm --filter @neore/native run android:dev
```

Commit `gen/android` / `gen/apple` once generated — the manifest edits below live
there.

- **Deep links**: `plugins.deep-link.mobile` declares the `neore` scheme.
  Universal links / App Links (`https://<site>/…` opening the app) need an
  `apple-app-site-association` and `assetlinks.json` served by the web app and a
  `host` entry here — not done.
- **Share sheet / intents (not wired)**: no official Tauri v2 plugin receives
  shares. Android can be done with an `ACTION_SEND` `text/plain` intent filter in
  `gen/android/app/src/main/AndroidManifest.xml` plus a community plugin
  (`tauri-plugin-sharetarget`, GPL-2.0; `tauri-plugin-sharehub`, MIT, also iOS
  via a Share Extension). Whichever is chosen, feed the text into
  `hand_off_compose(app, text)` — the web side already handles it. They were NOT
  added: both are young single-maintainer crates that need vetting first.
- **Push notifications (not wired)**: needs APNs (an Apple key: `.p8`, key id,
  team id) and FCM (a Firebase project and `google-services.json`), a plugin that
  returns the device token (e.g. `tauri-plugin-push-notifications`, same vetting
  caveat), a backend table for device tokens and a sender. None of that exists
  yet; local notifications (`notify`) work on mobile today.

## Auth inside the webview

- **Email/password (with TOTP) and anonymous sessions work unchanged.** The app
  proxies `/api/auth/*` on its own origin, so the session cookie is first-party,
  and the RPC bearer comes from `/api/auth/token` exactly as in a browser.
- **Passkeys are unverified and probably do not work**: WKWebView only offers
  WebAuthn to apps with an associated-domains entitlement for the RP domain, and
  WebKitGTK has no WebAuthn at all. WebView2 (Windows) should.
- **Google sign-in runs in the system browser**, because Google refuses OAuth
  in embedded webviews (`disallowed_useragent`). It reuses the Firefox
  extension's one-time-code PKCE grant (`backend/lunora/auth/extension-grant.ts`)
  rather than a second grant system:
    1. Clicking "Continue with Google" navigates to `accounts.google.com`; the
       shell cancels that navigation (`on_navigation`) and instead opens
       `<site>/auth/extension?client=native&code_challenge=…&redirect_uri=neore://auth/callback&state=…`
       in the default browser (`src-tauri/src/sign_in.rs`). The tray's "Sign in
       with browser" and the page's `startNativeBrowserSignIn()` do the same.
    2. The user signs in there (Google works — it is a real browser), approves,
       and the page redirects to `neore://auth/callback?code=…&state=…`.
    3. The shell accepts the callback only if `state` matches the ONE flow it
       started (15-minute window), then hands `{ code, codeVerifier, redirectUri }`
       to the page (`take_pending_sign_in`).
    4. The page posts it to `/api/auth/client-grant/cookie`
       (`backend/lunora/auth/client-grant-cookie.ts`, a better-auth endpoint
       reached through the app's own proxy), which runs the unchanged
       `exchangeExtensionCode` and sets the normal signed session cookie on the
       app origin; the page reloads signed in.

    **Operator step:** the native callback is opt-in. Add it to the backend's
    `TRUSTED_EXTENSION_REDIRECT_URIS` — which then replaces the Firefox default, so
    list both: `https://c64d88ed4645bb5915bc267506fbc3dcd4a1da90.extensions.allizom.org/,neore://auth/callback`.
    It is never a default because a custom scheme is not exclusive: any app can
    register `neore:`. That is the code interception PKCE defends against
    (RFC 8252 §8.1) — the verifier never leaves the shell until its callback
    arrives, and the cookie endpoint refuses every redirect URI but the native one.

- **Connector OAuth** (`/dashboard/settings/connectors/callback`) runs inside
  the webview and returns to the app route as in a browser; providers that block
  embedded webviews (Google-hosted MCP servers) hit the same limitation.
