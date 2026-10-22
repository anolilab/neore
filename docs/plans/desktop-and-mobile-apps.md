# Desktop and mobile apps — plan

Status: **decided 2026-10-19: build it like T3 Code.** Goal: more users,
through native apps that support every Neore feature.

**Decision:** Electron desktop shell around the web app (replacing the Tauri
shell in `apps/native`), an Expo app for iOS and Android, and one shared client
runtime package. Open items are in §9.

## 0. Why Expo is for phones, not for the desktop

The request was "a desktop app, it should be an Expo app". The evidence says
Expo cannot be the desktop runtime, and following T3 Code (the owner's choice)
means the same split.

| Fact                                                                                                                                                                                                       | Source                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Expo supports iOS and Android. macOS is "out-of-tree" only; **Windows has no Expo target**. A maintainer said the team won't invest in desktop and pointed to Mac Catalyst.                                | [Expo docs](https://docs.expo.dev/modules/additional-platform-support/), [discussion](https://github.com/expo/expo/discussions/22273) |
| The only route is `expo-desktop` (react-native-macos/windows): one maintainer, "best-effort", no releases.                                                                                                 | [shirakaba/expo-desktop](https://github.com/shirakaba/expo-desktop)                                                                   |
| An "Expo Desktop launch" article that circulates is uncorroborated; the page we fetched was a sign-in landing page. Treat it as false until Expo says so.                                                  | —                                                                                                                                     |
| Neore's heavy features are DOM-only: Univer (sheets), Fabric.js (design), tiptap (pages), Streamdown/KaTeX/Mermaid, React Flow. None has a react-native-macos/windows equivalent, so "all features" fails. | `apps/web/src/features/{canvas,pages,workflow,slides}`                                                                                |
| The reference apps split the same way: **T3 Code** = Electron 44 desktop + **Expo 58 / RN 0.88** mobile + shared web UI; **opencode** desktop = Electron 44 (`packages/desktop`).                          | `gh api` on both repos, 2026-10-19                                                                                                    |

**So:** desktop = Electron around the existing web app (parity for free).
Mobile = Expo for iOS and Android. Nothing here is Expo-on-desktop.

## 1. What exists

`apps/native` is a Tauri v2 shell around the deployed web app: tray, global
Quick Composer, notifications, `neore://` deep links, updater, single-instance,
system-browser Google sign-in, and ~4.7k lines of reviewed Rust for **device
execution** (HMAC envelopes, approvals, `shell_run` in Landlock/`sandbox-exec`,
local MCP). Per `apps/native/README.md`, **nothing is signed or notarized and no
CI secret is set** (`native.yml` builds an unsigned _draft_ release). There is no
Expo app, no download page, and no mobile project (`gen/android|apple` not
generated).

The Tauri shell is being replaced (§4). Its design (origin-only IPC, relay-only
page, local approval window) is kept; only the runtime changes.

## 2. Reference apps

What each tells us. "Unverified" means read from a secondary source or inferred.

| App                          | Shape                                                                                                                                                                                                                                                                                                          | Take                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI Codex app             | Desktop "command center": parallel agents, worktrees, skills, automations, in-app browser, computer use, memory, plugins, SSH devboxes. Stack **unverified**.                                                                                                                                                  | Many threads visible at once; background "automations" (we have Tasks/Triggers); an in-app browser and review pane next to the chat. |
| T3 Code                      | Electron 44 shell + Node backend child process, token-authenticated localhost socket; `client-runtime`/`contracts` packages shared by web, desktop, **Expo mobile**; `@legendapp/list` on web _and_ mobile; `electron-updater`, native keychain (`@napi-rs/keyring`), custom protocol for remote environments. | Extract the client runtime into a package both clients import. One list lib on both platforms. Keychain for secrets.                 |
| opencode                     | Electron 44 + electron-vite + electron-builder + electron-updater; UI in a shared `packages/app`/`ui`; desktop is a client of a local server. (Earlier Tauri history **unverified**.)                                                                                                                          | Thin shell, shared UI package.                                                                                                       |
| Conductor (Mac)              | Parallel agent workspaces, each with its own diff, checks and PR path.                                                                                                                                                                                                                                         | Workspace = unit of parallel work; only relevant to Coding agents.                                                                   |
| Jan, Cherry Studio, LobeChat | Local-first chat clients (Jan: Tauri; Cherry: Electron, local data). Architecture details **unverified**.                                                                                                                                                                                                      | Local-model onboarding; data stays on device story. We already have Local models and Device execution.                               |

Not found: anything on Zed's agent panel or the Claude desktop app. Worth a
second look before Phase 2.

## 3. Phase 0 — start the long-lead items now

Run in parallel with everything else; they gate shipping, not building.

- Apple Developer ID + notarization, Windows code signing (Authenticode or Azure
  Trusted Signing). No framework change helps if installs show a Gatekeeper or
  SmartScreen warning.
- Decide the update feed (GitHub Releases, `electron-updater`'s `latest*.yml`).
- PostHog events: `desktop_download_clicked`, `desktop_first_launch`,
  `desktop_signed_in`, so later phases are judged on numbers.

## 4. Phase 1 — replace Tauri with Electron (`apps/desktop`)

**Nothing is released**, so replacing costs no installed users. Keep the app id
`de.anolilab.neore` and the `neore://` scheme. Delete `apps/native` (including
the never-generated Tauri mobile plan) once parity is checked off.

Simpler than T3's shell: they spawn a local Node backend; Neore's backend is on
Cloudflare, so the window just loads `NEORE_SITE_URL`.

### Mapping

| Today (Tauri)                                         | Electron                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Window loads `NEORE_SITE_URL` (compile-time)          | Same, baked in at build (`define`); no runtime override. `build` refuses a release without it.                                                                                                                                             |
| Runtime `CapabilityBuilder` ACL per origin            | `contextIsolation`, `sandbox`, no `nodeIntegration`; preload exposes one `window.neoreNative`; **every `ipcMain` handler checks `event.senderFrame.url` against the allowed origin**. Local windows get their own preload and channel set. |
| `window.open` / `_blank` → system browser             | `setWindowOpenHandler` + `will-navigate` lock; same-origin loads in place, everything else `shell.openExternal`.                                                                                                                           |
| Tray, global Quick Composer, hide-on-close            | `Tray`, `globalShortcut`, a local `BrowserWindow`; `close` → hide.                                                                                                                                                                         |
| Notifications, `neore://` deep links, single-instance | `Notification`, `setAsDefaultProtocolClient` + `second-instance` / `open-url`, `requestSingleInstanceLock`.                                                                                                                                |
| System-browser Google sign-in (`sign_in.rs`)          | Port the PKCE flow to the main process; still the extension grant ending at `/api/auth/client-grant/cookie`. Reuse the redirect `neore://auth/callback`.                                                                                   |
| Updater plugin + signing key                          | `electron-updater` + `electron-builder` 26 (as T3 and opencode ship).                                                                                                                                                                      |
| Device secret file store (`device/store.rs`)          | Electron `safeStorage` (OS keychain-backed; T3 has an `ElectronSafeStorage` wrapper) or `@napi-rs/keyring`.                                                                                                                                |
| `ipc:` CSP workaround                                 | **Disappears.** No Tauri postMessage fallback, so no per-page console warning; the web CSP stays as is.                                                                                                                                    |

Web side: `apps/web/src/lib/native/bridge.ts` detects `window.__TAURI__` and
calls `core.invoke`. Swap it for `window.neoreNative` with the same exports
(`notifyNative`, compose event, sign-in, `device_*`), keep the no-op outside the
shell, and update `apps/native`-referencing docs and the CLAUDE.md "Native
shell" paragraph.

Fuses and hardening from day one: disable `RunAsNode` and
`NODE_OPTIONS`, enable embedded ASAR integrity, no `remote`, strict CSP on the
local windows, `webSecurity` on. Add `verify-preload-bundle` (T3 does) so a
sandboxed preload never silently imports Node.

### Device execution: keep the Rust core, drop Tauri

The audited part is not Tauri code. Of `device/` (≈3.6k lines), only `mod.rs`
(1,226 lines, 16 `tauri::` references: commands, windows, state) is Tauri glue.
`envelope`, `hmac`, `fs`, `shell`, `sandbox` (Landlock / `sandbox-exec` / Job
Objects), `mcp`, `store` and `approval` have none.

1. Move them into a standalone crate `neore-device-core` with its tests (HMAC
   vectors stay pinned there and on the TS side).
2. Expose it to the main process as a **napi-rs addon** (same route T3 takes
   with `@napi-rs/keyring` and `ffi-rs`). One prebuilt binary per target in CI.
3. Rewrite `mod.rs` as TS IPC handlers: the relay commands
   (`device_status|pair|manifest|execute|open_settings`) are the only ones the
   page can reach; `device_prompt_*`, `device_settings_*`, `device_pick_folder`,
   `device_audit_tail` belong to the local approval window's preload alone.
   `dialog.showOpenDialog` replaces `tauri-plugin-dialog`, called from the main
   process only.
4. Re-verify, don't assume: the sandbox applies to the **child** process
   (Landlock / `sandbox-exec` / Job Object), so it should survive the move out of
   a Tauri process, but run the existing shell-sandbox tests against the addon on
   all three OSes before deleting the Tauri copy.

Decision to confirm during the port: the approval window UI (`src/device.*`)
is plain HTML today and ports as-is.

### Parity checklist (done = deleted from `apps/native`)

Quick Composer, tray, deep links incl. cold-start and second launch, sign-in,
notifications (suppressed while focused), updater, hide-on-close, device pairing,
approvals incl. tainted calls that never offer "Always allow", `shell_run`
sandbox refusal when "Require sandbox" is on, local MCP servers, folder picker,
progress reports (`reportDeviceCallProgress`), `isNativeShell()` hiding the
"Get the app" entry.

### Local models improve

Electron is Chromium, which exempts loopback from the https→http upgrade, so
Ollama / LM Studio work on desktop. Drop the Safari-specific desktop branch
only for the shell; keep it for real Safari. (Tauri on macOS uses WKWebView,
where this was at risk. We stop depending on that.)

### Ship

Signed + notarized macOS (arm64 and x64), signed Windows, Linux AppImage/deb.
Download page with OS detection on the marketing site, then Homebrew cask.
Release workflow replaces `native.yml`; draft until a smoke test passes
(launch, load `NEORE_SITE_URL`, sign in).

## 5. Phase 2 — desktop UX (web side, shell-gated)

Everything here is behind `isNativeShell()` in `apps/web/src/lib/native/` and
adds no required `VITE_` var. Ordered by expected value:

1. Native menu bar, window-state restore, launch at login, dock/taskbar badge
   for unread/finished runs, "ask about selection" global shortcut next to the
   Quick Composer.
2. Multi-window: pop a thread out; drag files onto the dock icon.
3. Command palette / switcher across threads (`features/keyboard` exists).
4. Several runs visible at once (Codex's strongest idea): a "running" rail fed by
   `usageDaily`/stream state, not a new store.
5. Offline/slow-network screen instead of a blank window; reconnect banner.

## 6. Phase 3 — extract the client runtime

Prerequisite for mobile and a pure refactor for web. Move out of
`apps/web/src/lib/{lunora,auth}` into `packages/client-runtime` (T3 does the
same): `crpc` setup, `live-queries.ts` (incl. `meta.lunoraArgs`,
`MAX_CONCURRENT_SEEDS`), `ws-ticket`, `shard-routing`, `token-refresh`,
`session-read`. Platform pieces become injected adapters (`storage`, `fetch`,
`webSocket`, `wsTicket`). The web tests stay green and move with the code.

**First check, before any of it:** does `@lunora/client` (alpha.213) run on
Hermes? (`exports`/`react-native` field, WebSocket, `crypto`, `TextDecoder`.)
`node_modules` is not installed in this worktree, so this is unchecked. If it
doesn't, the fix is upstream, not a fork.

## 7. Phase 4–6 — Expo app (`apps/mobile`)

Stack (versions as T3 Code ships them: Expo 58, RN 0.88; **only their
dependency list was read, not their usage**):

| Need                     | Pick                                                                                                                               | Why                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Routing                  | `expo-router`                                                                                                                      | Mirrors TanStack file routes; deep links for free.                                                      |
| Message list             | `@legendapp/list` (beta, built for chat: no inverted list, keeps scroll position) or FlashList v2                                  | Benchmarks found were blog-grade; **benchmark on a streaming thread on a mid Android** before choosing. |
| Streaming                | `expo/fetch` (Expo ≥52) against the gateway's NDJSON `/chat/chunks`                                                                | RN's `fetch` doesn't stream. AI SDK docs note an iOS `application/octet-stream` workaround if choppy.   |
| Markdown while streaming | **Open question.** Evaluate native renderers; fallback is Streamdown inside one `"use dom"` component per message, which is heavy. | No source found that benchmarks this. Decide with a spike on a 50-message thread.                       |
| Cache / offline          | `expo-sqlite`                                                                                                                      | Thread list + last N messages.                                                                          |
| Secrets                  | `expo-secure-store`                                                                                                                | Session token.                                                                                          |
| Images / video / files   | `expo-image`, `expo-video`, `expo-document-picker`, `expo-image-picker`                                                            | Uploads go over TUS (`@lunora/client/upload`); needs RN file handles, verify.                           |
| Animation / gestures     | Reanimated 4 + Gesture Handler                                                                                                     | Standard.                                                                                               |
| Styling                  | Uniwind (T3 uses it) or NativeWind                                                                                                 | Reuse design tokens from `packages/ui`.                                                                 |
| Updates / builds         | EAS Build + EAS Update                                                                                                             | OTA fixes between store reviews.                                                                        |
| Extras                   | `expo-notifications`, `expo-quick-actions`, `expo-paste-input`, share extension, `expo-widgets`                                    | Share-to-Neore and a home widget are the "install it" features.                                         |

### Backend work the app needs (none exists today)

- **Sign-in.** Reuse the existing **extension grant**, don't add a second one:
  the browser extension already keeps a session token and trades it for JWTs
  (`backend/lunora/auth/extension-grant.ts`). The app behaves like the extension
  with its own redirect URI added to `TRUSTED_EXTENSION_REDIRECT_URIS`. Not the
  `client-grant/cookie` endpoint — that one yields a _cookie_ and accepts only
  the desktop redirect. Confirm with `lunora-auth` before writing code.
- **Push.** The backend sends **Web Push only** (`@lunora/notify`, VAPID, browser
  endpoints allow-listed in `push-endpoint.ts`). Phones need APNs/FCM (or Expo
  push) tokens: a new subscription kind, `notify()` fan-out, and the same
  sign-out unregister.
- **Billing.** Apple/Google require in-app purchase for digital subscriptions.
  Linking out to Stripe-style checkout may get the app rejected (**verify the
  current guideline wording**). Either hide upgrade UI on iOS or add IAP.
- **Universal links.** `apple-app-site-association` / `assetlinks.json` served by
  the web app.

### Parity matrix — all 28 `apps/web/src/features/*`

Desktop = the web app in the shell, so every row is ✅ there; the column is only
the **native extra**. Mobile: **N** native RN, **D** reuse web code in an Expo DOM
component (`"use dom"`), **L** open the web app (in-app browser), **—** not on
phones.

| Feature       | Desktop extra                | Mobile | Note                                                           |
| ------------- | ---------------------------- | ------ | -------------------------------------------------------------- |
| chat          | menu, badge, multi-window    | N      | MVP. Streaming, branches (‹ 2/3 ›), regenerate, tool approvals |
| auth          | system-browser Google (done) | N      | extension grant, see above                                     |
| home          | —                            | N      | one `getHomeOverview`                                          |
| layout        | menu bar                     | N      | tab/stack navigation, not the sidebar                          |
| notifications | native + badge               | N      | needs mobile push                                              |
| projects      | —                            | N      |                                                                |
| prompts       | —                            | N      |                                                                |
| skills        | —                            | N      | list/toggle                                                    |
| sub-agents    | —                            | N      | rendered in the thread                                         |
| tasks         | —                            | N      | create/monitor                                                 |
| knowledge     | drop files on dock           | N      | TUS upload                                                     |
| vault         | —                            | N      | signed URLs                                                    |
| coding-agents | —                            | N      | start + follow results                                         |
| settings      | launch at login              | N      | subset                                                         |
| appearance    | —                            | N      |                                                                |
| onboarding    | —                            | N      |                                                                |
| changelog     | —                            | N      | small                                                          |
| devices       | **device execution (Rust)**  | N      | list/revoke only; pairing and approval stay on the desktop     |
| canvas        | —                            | D      | Fabric.js design + artifacts                                   |
| pages         | —                            | D      | tiptap; read view native later                                 |
| slides        | —                            | D      | viewer first                                                   |
| workflow      | —                            | D      | React Flow editor; run status native                           |
| evals         | —                            | L      |                                                                |
| billing       | —                            | L      | store-policy decision above                                    |
| admin         | —                            | L      |                                                                |
| local-models  | works (Chromium)             | —      | a phone's `localhost` is not the user's Ollama                 |
| keyboard      | shortcuts, palette           | —      |                                                                |
| marketing     | download page                | —      | web only                                                       |

Phases: **4** = auth + chat + threads + composer/attachments + push (one
shippable TestFlight/Play internal build); **5** = the N rows; **6** = the D rows
and polish. Each ships behind a feature flag per row.

## 8. Risks

- **Client runtime on Hermes** unverified (§6). Gate Phase 4 on it.
- **Streaming markdown on RN** unsolved (§7). Biggest UX risk for the chat row.
- **Live-query load.** The web client holds ≤32 subscriptions and throttles
  seeds to 3 (`CLAUDE.md`). A phone resuming from background re-subscribes
  everything; the mobile client needs a smaller first-paint budget.
  **Proposed, not measured:** the mobile client opens at most 8 live
  subscriptions per socket and seeds 2 at a time; a resume re-subscribes only
  the queries the visible screen reads, and the rest load on open. Chat is the
  only screen that needs more than 4. Verify on a mid Android before relying on
  the numbers; they are the first thing to change if the first paint is slow.
- **Store review.** Billing, UGC/report-abuse, account deletion (we have GDPR
  deletion) and "sign in with Apple" if a social login is offered.
- **Porting device execution.** The Rust core moves to a napi addon and its
  TS glue is new; this is remote code execution on the user's machine, so the
  port needs a fresh security review, the HMAC vectors on both sides, and the
  sandbox tests on macOS, Windows and Linux before the Tauri copy is deleted.
- **Electron cost.** Larger bundle and idle memory than Tauri (the price of
  one Chromium everywhere); accepted for consistent rendering of the editors.
  Native addon builds add three CI targets.
- **Device execution stays desktop-only.** No mobile equivalent; do not
  advertise it on phones.

## 9. Decisions (defaults taken, per owner instruction)

1. **Signing accounts:** owner to provide. Blocks Phase 0 shipping only, not
   building. Until then, builds stay unsigned in CI drafts.
2. **iOS billing:** hide upgrade UI on iOS (no IAP) for launch. Revisit once
   the store-policy wording has been checked by someone who reads it.
3. **Electron tooling:** electron-builder for packaging. **Deviation:** the
   bundling is esbuild in `apps/desktop/scripts/build.mjs`, not electron-vite.
   The same script checks every sandboxed preload: its only import may be
   `electron`, so a Node built-in fails the build.
4. **Shared code:** the React feature code is not portable to React Native
   as-is (Tailwind/DOM). Shared packages hold logic (`client-runtime`) and
   presentational primitives that have no DOM dependency. Web-only components
   (Univer, Fabric, tiptap, React Flow) reach phones through `"use dom"`
   components, not rewrites. `packages/chat-ui` already forbids backend, auth
   and router imports, so it is the first candidate.
5. **Update feed:** GitHub Releases. `publish` in `electron-builder.yml` uses
   `releaseType: draft`, and electron-updater reads `latest*.yml` from the
   release. Caveats: a draft is invisible to the updater until someone publishes
   it, and macOS auto-update needs a signed build, so it does nothing for
   today's unsigned builds. The feed is configured; it is not tested end to end.
6. **Device secret storage (deviation, open):** the pairing secret is in
   `device.json` under the device store, written by `device-core` with mode 0600
   on Unix. §4 asked for `safeStorage` or `@napi-rs/keyring`. `safeStorage` lives
   in the Electron main process, but `device-core` verifies the HMACs in Rust and
   needs the secret there, so it is the wrong side of that boundary. A keyring
   crate inside `device-core` is the real fix. It is a new dependency, so it is
   the owner's call. Windows relies on the profile ACL, untested.

## 10. Status

Last updated 2026-10-19. Nothing below is committed.

**Done**

- Electron shell (`apps/desktop`, Electron 44) replaces Tauri; `apps/native` is
  deleted. Sandboxed preload exposes `window.neoreNative` on the site origin
  only; every IPC handler checks the sender.
- Device execution: `packages/device-core` (Rust) and `packages/device-core-node`
  (napi). The web bridge calls the shell relay only when it advertises `device`.
- Device pairing secret is in the OS keychain (`keyring`), with a file fallback
  when the keychain refuses, and a migration from the old inline secret.
- Shared folders may not contain the home folder (`refused_root`); roots saved
  before this are dropped on load.
- Shell network setting (`allow_shell_network`, default off) is enforced on
  macOS through the sandbox profile and verified by a test that connects to a
  local listener.
- Security review (read-only, 14 findings) done. Fixed: audit log is 0600; MCP
  servers restart when their config changes; a background child can no longer
  block `shell_run`; the pairing prompt says it replaces an existing pairing.
  Not changed: the main-window navigation (see Open).
- Every sandboxed preload is checked at build (`apps/desktop/scripts/build.mjs`):
  its only import may be `electron`. Verified with a forced failure.
- Desktop CI (`.github/workflows/desktop.yml`): builds the addon for every
  packaged arch (macOS x64+arm64 in one job, Windows x64+arm64 in one job, Linux
  x64 and arm64 separately), runs `smoke` before packaging and `smoke:artifacts`
  after it. Windows signing is Authenticode, read from `WIN_CSC_*`.
- Rust `device-core` tests run in CI on ubuntu, windows and macos (`test.yml`).
- Update feed: `latest*.yml` from one electron-builder run per platform.
- Desktop lint: `apps/desktop/src` is at 30 findings, each a deliberate rule
  (the null wire contract, the runtime `require` for the addon, the `vi.mock`
  seams, mutual references). 107 findings are in `electron-builder.yml`, which
  the lint pass did not touch.
- PostHog desktop events: `desktop_first_launch` (sent from PostHog's `loaded`
  callback, flag set only when sent), `desktop_signed_in`, and
  `desktop_download_clicked` on the new download page (`/download`).
- Download page (`/download`): OS detection, a primary button, and the full list.
  Links go to the GitHub releases page. Arch is shown only for Linux.
- Mobile sign-in: the backend admits `neore-mobile://auth/callback` through the
  extension grant, opt-in via `TRUSTED_EXTENSION_REDIRECT_URIS` (same trust model
  as the desktop URI). The app's PKCE sign-in code is in `apps/mobile/src/auth`.
- Expo app `apps/mobile`: first slice, `eas.json` profiles. Sign-in code exists
  and is unblocked on the app side; first real sign-in is not run.
- Safari mixed-content check is skipped inside the Electron shell (`isSafariUserAgent`).
- Hermes check of `@lunora/client` (alpha.213): present except `indexedDB`.
  Phase 4 needs an RN storage adapter (expo-sqlite).
- Client runtime extracted to `packages/client-runtime` (Phase 3).
- MCP "Always allow" applies only to read-only tools: `decide` in
  `packages/device-core/src/engine.rs` requires `readOnly`, an untainted call and
  a tool other than `shell_run`/`fs_write`. Stored rules for other tools are kept
  but inert.
- Call nonces persist to `device-nonces.json` (`NonceSet::persisted`, `envelope.rs`);
  a failed write refuses the call.

**Open: needs a decision from the owner**

- Windows arm64 Windows installers: one merged `latest.yml`, built in one job
  with the arm64 addon cross-compiled on the x64 runner. Unverified on the runner
  image (see the workflow header).
- Main-window navigation: the security review asked for a site-origin allowlist.
  Not done: GitHub, Microsoft and generic OIDC sign-in redirect inside the main
  window (`backend/lunora/auth.ts`), and a site-origin-only guard would cancel
  them. Decide the providers' hosts before adding the guard.
- Shared folder `~` or a parent of it: refused now, existing roots dropped on
  load. Confirm this behaviour change is acceptable.
- Mobile `neore-mobile://auth/callback`: opt-in, so operators must list it in
  `TRUSTED_EXTENSION_REDIRECT_URIS`. Recommendation: keep it opt-in, the same as
  the native URI. Any app can register a custom scheme, so default-on would admit
  every such app's callback. Pending: `lunora-auth` sign-off, which I cannot give
  from here. Until it is given, the mobile sign-in is not enabled on any
  deployment.
- Mobile Phase 4 slice (chat, push, billing): scope and start date.
- Security findings still open: the Linux TIOCSTI risk; `/proc` readable on Linux;
  Mach IPC not restricted on macOS (unverified).
- Device secret: now in the keychain. Windows credential store and Linux secret
  service have not been run.

**Open: needs a machine or an account I do not have**

- Release smoke: launch the packaged app, load the site and sign in before a draft
  release. `smoke` and `smoke:artifacts` check the bundles and the packaged addon
  only.
- Sandbox tests on Linux (Landlock) and Windows (Job Objects, Windows
  restrictions): the CI job runs the unit tests only.
- Keychain on real macOS and Windows machines, and the Linux secret service.
- Tray, Quick Composer and the network checkbox: manual check on each OS.
- Windows and Linux arm64 addon: the cross-compile on the Windows runner and the
  arm64 runner labels need one real run.
- Update feed: needs a published draft and a signed macOS build.
- Signing: Apple Developer ID and notarization; Windows certificate for Authenticode.
  `apps/desktop/.env.signing.example` could not be read here (a permission rule
  blocks it), so its header is unchanged.
- Homebrew cask: needs the first signed release (checksum).
- Expo: `eas init` needs your Expo account.
- Hermes runtime behaviour: needs the first Expo boot.
- Lunora #1266 reproduction: needs a device or Hermes run.
- Download page: translations need `pnpm translate:extract` and `translate:compile`;
  `routeTree.gen.ts` regenerates on the next dev or build.

**Phase 2 desktop UX (§5)**: partly built. Window-state restore, launch at login
and the dock/taskbar badge are wired in `apps/desktop/src/main.ts`. Not built:
multi-window, command palette, running rail, offline screen.

**Lunora issues:** none filed. Nothing reproduced yet.
