# Neore desktop

`@neore/desktop` is an Electron 44 shell around the **deployed** web app. It
holds no UI of its own beyond a few local windows; the main window loads the
site, and a sandboxed preload exposes `window.neoreNative` on that origin only.
The web side of the bridge is `apps/web/src/lib/native/bridge.ts`, a no-op
outside the shell. Background: [`plans/desktop-and-mobile-apps.md`](../../plans/desktop-and-mobile-apps.md).

## What is in it

| Folder                | What it does                                                                        |
| --------------------- | ----------------------------------------------------------------------------------- |
| `src/main.ts`         | Main process: windows, tray, deep links (`neore://`), updater, IPC wiring           |
| `src/preload.ts`      | The site preload (`window.neoreNative`)                                             |
| `src/quick-composer/` | The global-shortcut composer window (plain HTML and JS, copied rather than bundled) |
| `src/device/`         | Device execution: the local approval window and the `@neore/device-core-node` addon |
| `src/terminal/`       | The local terminal window; the PTY runs in a utility-process host                   |
| `src/dictation/`      | On-device dictation behind `whisper-cli`                                            |
| `src/acp/`            | Runs coding agents on this computer and posts their turns to the backend            |

## Build-time origins

The site and backend origins are baked in at build time. There is no runtime
override, because the site origin is the only one granted IPC and the page must
not be able to choose where turn output goes.

| Variable            | Default                 | Purpose                                                            |
| ------------------- | ----------------------- | ------------------------------------------------------------------ |
| `NEORE_SITE_URL`    | `http://localhost:5173` | The deployment the shell loads, and the only origin given IPC      |
| `NEORE_BACKEND_URL` | `http://localhost:8788` | Where the main process posts coding-agent output (`/hosts/ingest`) |
| `NEORE_RELEASE`     | unset                   | `1` makes both URLs required and `NEORE_BACKEND_URL` https-only    |

The defaults match `pnpm dev`, so a local run needs nothing set.

## Run it locally

Start the web app and backend first (`pnpm dev`; see the root `CLAUDE.md` for
the port map), then:

```bash
pnpm --filter @neore/desktop start      # build, then electron .
```

The device-execution addon (`@neore/device-core-node`) is a Rust napi build
(`pnpm --filter @neore/device-core-node run build`, needs the Rust toolchain)
that the shell loads at runtime, and `smoke` checks that it loads.

## Test and lint

```bash
pnpm --filter @neore/desktop test           # vitest, unit
pnpm --filter @neore/desktop test:e2e       # Playwright driving the built shell
pnpm --filter @neore/desktop lint:types
pnpm --filter @neore/desktop lint:eslint      # there is no prettier script in this package
pnpm --filter @neore/desktop smoke          # after a build: bundles exist, addon and node-pty load
```

The e2e suite builds `dist/` itself and points the shell at a fixture server on
`127.0.0.1:4399` (`NEORE_E2E_PORT` moves it). Electron allows one instance, so
it runs with a single worker. `getUserMedia` with a fake media device hangs in a
sandboxed shell, so the dictation e2e feeds audio through the page's own
preload bridge; `NEORE_E2E_MICROPHONE=1` uses the (fake) microphone instead,
and `NEORE_WHISPER_CLI` / `NEORE_WHISPER_MODEL` / `NEORE_WHISPER_CLIP` run a real
recogniser.

## Package

```bash
export NEORE_SITE_URL=https://app.example.com NEORE_BACKEND_URL=https://api.example.com
pnpm --filter @neore/desktop run pack        # unpacked app in release/
pnpm --filter @neore/desktop run dist        # installers via electron-builder, never publishes
pnpm --filter @neore/desktop run smoke:artifacts
```

Both set `NEORE_RELEASE=1`, so a missing URL, or an http backend, fails the build.

Packaging is `electron-builder.yml`; the `desktop-v*` tag workflow
(`.github/workflows/desktop.yml`) builds macOS, Windows and Linux and attaches
the installers to a draft release. Signing comes from the environment
(`CSC_*` for macOS, `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` for Windows;
names are in `.env.signing.example`), and an unsigned build is still produced
without them.

Two helpers are built ahead of packaging and shipped as `extraResources`:

- **`neore-host`** (`pnpm --filter @neore/desktop run host-bundle build <rust-target>...`,
  then `sign` and `manifest`): the binaries the app uploads to a server over
  SSH, plus the SHA-256 manifest they are checked against. macOS binaries are
  signed before they are hashed, and `mac.signIgnore` keeps app signing from
  touching them. Set `NEORE_HOST_BUNDLE` to use a bundle in a dev run.
- **`whisper-cli`** (`pnpm --filter @neore/desktop run build:dictation-helper`):
  whisper.cpp at one pinned commit, statically linked. Needs git, cmake and a
  C++ toolchain; macOS arm64 is the only target built so far. Where none is
  built, dictation refuses cleanly.

## Constraints worth knowing

- **Origin checks.** Every IPC handler checks the sender's origin in the main
  process. The web CSP deliberately does not allow `ipc:`; do not loosen
  `connect-src` to silence the resulting console warning.
- **Sign-in** goes through the system browser on the extension grant
  (redirect `neore://auth/callback`) and ends at `/api/auth/client-grant/cookie`.
  Do not add a second grant system.
- **Device execution** is remote code execution on the user's machine, so the
  page is a relay only; the approval window is local and the only holder of the
  approval commands. See [`plans/device-execution.md`](../../plans/device-execution.md),
  [`plans/ssh-environments.md`](../../plans/ssh-environments.md) and
  [`docs/devices.mdx`](../../docs/devices.mdx). `packages/device-core` holds the
  Rust side; the HMAC vectors are pinned on both sides.
- **Terminal** is the user's own shell and has no site-facing channel: its
  window has its own preload and an in-memory session that cancels every
  request but `file:`. The PTY runs in a utility process, never in main.
  `node-pty` 1.1.0 ships the macOS `spawn-helper` without the execute bit;
  `scripts/after-pack.cjs` fixes the packaged copy. Windows is unavailable.
  See [`plans/desktop-terminal.md`](../../plans/desktop-terminal.md).
- **Dictation** is opt-in from a local settings window; with the switch off no
  shortcut, window, download or helper starts. The dictation window has no
  network, and the model is downloaded by the main process after a confirm
  dialog and hashed while streaming. See
  [`plans/desktop-dictation.md`](../../plans/desktop-dictation.md).
- **Coding agents on this computer** (`src/acp/`) post turns to the backend from
  the main process, signed with the device secret; the backend origin is the
  build-time `NEORE_BACKEND_URL`. See
  [`plans/acp-agent-host.md`](../../plans/acp-agent-host.md).
- Never run `pnpm deploy` here or anywhere; CI owns deployment.
