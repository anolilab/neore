# DESKTOP SHELL KNOWLEDGE BASE

## INVARIANTS

- **Native shell** (`apps/desktop`, Electron 45) loads the deployed app from a
  BUILD-TIME `NEORE_SITE_URL` and exposes `window.neoreNative` only on that
  origin, through a sandboxed preload; every IPC handler checks the sender's
  origin in the main process. Device execution sits behind `packages/device-core`. The web side is `apps/web/src/lib/native/bridge.ts`,
  a no-op outside the shell — call `notifyNative` from any long-running flow.
  Google sign-in
  goes through the system browser on the EXTENSION grant (redirect
  `neore://auth/callback`, opt-in in `TRUSTED_EXTENSION_REDIRECT_URIS`) and ends
  at `/api/auth/client-grant/cookie`, which sets the normal session cookie — do
  not add a second grant system. See its README.
  **Terminal** (`apps/desktop/src/terminal/`) is the user's
  own interactive shell, outside the device sandbox, so it has NO site-facing
  channel: its window (`terminal-window/`, own preload and in-memory session that
  cancels every request but `file:`) is the only sender `index.ts` admits, and the
  page never names the folder or the shell. The PTY runs in a utility-process host
  (`terminal-host.cjs`), never in main: `RunAsNode` is fused off in packaged builds,
  so a `child_process.fork` of the app would relaunch Neore. `node-pty` 1.1.0 ships
  the macOS `spawn-helper` WITHOUT the execute bit (the first spawn is `posix_spawnp failed`):
  `after-pack.cjs` fixes the packaged copy before signing, `spawn-helper.ts` a
  checkout, and `npmRebuild: false` keeps electron-builder from rebuilding it for the
  runner's arch alone (node-pty prefers `build/Release` over the right prebuild).
  Nothing about a terminal is stored: scrollback is xterm's buffer in the window
  (`scrollback.ts`), main and host hold counters and one batch. Quit signals every shell synchronously (`killNow`).

- **Registry installs** (`apps/desktop/src/acp/{registry,install}.ts`, `device-core/src/acp_install.rs`):
  the desktop reads the ACP registry (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`) only when
  the local window searches. A `binary` download is installable only with a published `sha256`, which the schema
  makes OPTIONAL (`npx`/`uvx` entries never have one), so those are listed and refused. The window names an id and
  version; the main process takes archive, checksum and command from its own snapshot and words the native
  consent itself. Rust hashes, unpacks (no links, no `..`) and records the pin; there is no update path, by design.

- **Desktop dictation** (`apps/desktop/src/dictation/`, desktop-dictation.md S2) is off until the settings
  switch turns it on (`DEFAULT_SETTINGS.enabled: false`); off, no shortcut is registered.
  Hold `CommandOrControl+Shift+D` (`Y` on Windows arm64, `hold.ts`): a `dictation` window opens in its OWN in-memory session (`webRequest` cancels
  everything but its own files, so it has no network), captures 16 kHz mono in the page and sends chunks to the main
  process, which keeps them in memory and writes a WAV to the stdin of a pinned `whisper-cli` (whisper.cpp v1.9.5,
  `scripts/build-dictation-helper.mjs`; static, Metal embedded on Apple Silicon; not offered on Intel Macs, `catalog.ts#SUPPORTED`). Audio never touches disk.
  Non-obvious: `-f -` prints NOTHING without `-otxt` (upstream turns the output name into stdout and drops the segment
  callback), and the default language is `en`, so pass `-l auto`. **`globalShortcut` reports presses only**, so the
  release is the key-up the focused dictation window sees (`before-input-event`), with blur, a second press (ignored while
  the OS is repeating a held key), Escape and a 60 s cap as the other ends. The microphone policy is ONE function
  (`dictation/permissions.ts`) installed on the default session and on the window's: Chromium asks the check handler
  first WITHOUT a `mediaType`, so a check names no kind and only the request (`mediaTypes` exactly `["audio"]`) is the
  audio gate. The model (574 MB on Apple Silicon, else 488 MB) downloads in the main process after a confirm dialog,
  hashed while streaming, renamed into place only on a match. **`getUserMedia` with `--use-fake-device-for-media-stream`
  hangs in a sandboxed shell and on a Mac without a usable audio service**, so the e2e feeds audio through the page's own
  preload bridge; `NEORE_E2E_MICROPHONE=1` uses the (fake) microphone, and `NEORE_WHISPER_CLI` / `_MODEL` / `_CLIP` run
  a real recogniser.

- **Agent sign-in** (`apps/desktop/src/acp/sign-in.ts`): Neore keeps no agent credential. The
  state is the agent's answer to `session/new` on a short-lived connection with no prompt (`AUTH_REQUIRED` = signed out),
  opened in ONE stable folder per agent under `<userData>/acp-sign-in/`: some agents keep a record per folder, so a fresh
  folder per check would add one each time. Sign-out is the agent's own `logout`, after its open sessions end. Never
  sign a real account in or out in a test: Claude keeps its credential in the macOS Keychain, so an empty HOME isolates nothing.

- **Offline cold start** is the SITE's service worker, not the shell: `apps/web/public/offline-shell-sw.js` keeps
  `/offline-shell` (root route only, rendered for nobody: the root `beforeLoad` never reads the session on that path,
  `apps/web/src/lib/root-before-load.ts`) per build revision, revalidated every 30 min of online use, and answers an
  Electron GET navigation the network FAILED with it (a 5xx is passed through), else `offline.html`: never an older
  revision's shell, whose precached chunks are gone. Only `activate` prunes other revisions. The cached response keeps
  its own CSP header, whose nonce matches its HTML. It only helps after one online run, and only for route chunks that
  run loaded (`bundle-assets`). Detection is `Electron/` in the worker's user agent: keep the default user agent. The recovery page stays for a first run.

- **Window look** (`appearance.ts`, `app-menu.ts`, `menu-delivery.ts`): site windows start hidden; `maximize()` SHOWS a
  hidden window on Windows and Linux, so the saved maximized state is applied at the reveal, and an early bring-forward
  runs that reveal (`bringForward`), never a bare `show()`. A main window closed (hidden) before its reveal stays hidden
  through `ready-to-show` and the fallback timer; only `bringForward` reveals it. A reveal nobody asked for never takes the
  focus from another window of ours (`showInactive`; `show` focuses on Windows, and a blurred dictation ends); a main
  window saved maximized then maximizes at its first focus, since `maximize` activates on Windows. The live accent event is `accent-color-changed` on Windows and
  Linux only; macOS needs `subscribeNotification("AppleColorPreferencesChangedNotification")`. Vibrancy shows only through
  a fully transparent `backgroundColor`. The pre-paint fill follows `<userData>/appearance.json`, the `dark` class the
  last site page showed (the site has its own theme setting), else `nativeTheme`: sampled at `did-finish-load`, then
  followed by an `executeJavaScript` promise that settles at the next change (no IPC channel), re-armed per document
  until the webContents is destroyed, leaves the site or commits another document. A window not revealed when its load
  fails is shown at the recovery page's `did-finish-load` (`ready-to-show` does not fire again), or `SHOW_FALLBACK_MS` later. The deployed site ships apart from the shell, so a menu command waits until the
  page's `onMenuCommand` sends `menu-commands-ready` (per document); 2 s after a load without it, New Chat loads the URL and
  the rest is dropped. A committed non-site document (the recovery page) queues nothing: New Chat loads the site over it,
  the rest is dropped. Commands queue from `did-start-navigation` (main frame, cross-document) to the NEW page's ready: a
  ready before `did-navigate` is the departing page's; `did-fail-provisional-load` gives that page its state back. The
  preload counts subscribers: the last unsubscribe sends `menu-commands-unready`, which queues again and re-arms the 2 s. New Chat's ⌘N is `registerAccelerator: false`: the site binds it itself.
