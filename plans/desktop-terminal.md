# Desktop terminal: an interactive shell per folder

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
S3 needs the SSH transport ([ssh-environments.md](ssh-environments.md) S3).

## 1. Goal and decision

A desktop user can open a terminal for a folder, beside its chat, and run commands
interactively, as they would in their own terminal app.

Decisions:

- **Local window only.** A terminal is a shell running as the user, outside the
  device sandbox. It is therefore never reachable from the site page, from the
  phone, or from an outside agent. Anything that can type into it can do what the
  user can do.
- **No output goes to the backend.** Terminal output, scrollback and input are not
  stored, synced or logged anywhere except the local window's memory.
- **Not a substitute for approved commands.** Agents keep using `shell_run`, which
  is approved and sandboxed. The terminal does not change that.

## 2. Current state (checked)

- No terminal exists in the desktop app or in `packages/device-core`. A search for
  PTY and terminal-emulator code found none.
- `shell_run` runs one non-interactive command, approved and sandboxed
  (`packages/device-core/src/shell.rs`, `sandbox.rs`).
- The local window is a second window with its own preload
  (`apps/desktop/src/device/window/preload.ts`). The site preload
  (`apps/desktop/src/preload.ts`) is a different origin and gets no terminal channel.

## 3. Design

- **Process.** A pseudo-terminal per terminal tab, owned by the main process. The native PTY code runs in a helper child process with a start deadline, so a native crash cannot take the main process down. It
  starts the user's login shell in the folder, with the environment the shell
  would have when started from the app, so the user's tools are on the path. It is
  killed when its tab closes and when the app quits.
- **Rendering.** The terminal view is in the local window, with an xterm-compatible
  emulator (MIT licence to confirm in S1). The view has no network access.
- **IPC.** Input and resize go from the local window to the main process over a
  channel only the local window's preload exposes. The site origin cannot call
  these channels. The main process checks the sender on every call.
- **Persistence.** Scrollback lives in memory and is dropped when the tab closes.
  A reopened terminal starts a new shell. Nothing is written to the app data
  directory.
- **Windows.** The pseudo-terminal API differs on Windows, so S4 covers it
  separately.

## 4. Slices

**S1 — Local terminal.** One terminal tab for a folder in the local window: spawn,
input, resize, copy and paste, kill on close.
- Acceptance: quitting the app kills every shell it started (test: count child
  processes before and after quit); a call to open a terminal from the site origin
  is refused (test); no terminal output appears in any backend request (test: a
  full session with the network traffic recorded).

**S2 — Scrollback and reopen.** Bounded scrollback in memory, a new shell on reopen.
- Acceptance: scrollback stops at its limit; closing the window drops it (test: a
  heap or buffer check after close).

**S3 — SSH terminal.** A terminal on an SSH host, through the SSH transport.
- Acceptance: the host-key prompt appears before the terminal opens; a host that
  was not trusted gets no shell; the terminal ends when the connection ends, with a
  message.

**S4 — Windows.** The pseudo-terminal on Windows, with its own tests.
- Acceptance: S1 acceptance on Windows in CI, or the feature is marked unsupported
  on that platform.

## 5. Invariants crossed

- The trust boundary: the terminal is local-window only, and the site origin has no
  channel to it (`CLAUDE.md`, native shell).
- Nothing about a terminal goes to the backend, the phone, or outside agents.
- The shell's environment is the user's; no secret is injected by Neore.
- No terminal output is persisted: no cache file, no log, no database row.

## 6. Risks

- **Shell access is broad.** It is the user's own, so the risk is accidental harm
  and not escalation. The window is always visible when open, and it closes when
  the folder's chat closes if the user chooses.
- **Secrets in scrollback.** Kept in memory only and dropped on close. Copy and
  paste is the user's action.
- **Wrong folder.** The shell starts in the folder the tab names. The tab title shows
  the path.
- **Platform work.** Windows is the costly part (S4). Shipping S1 on macOS and
  Linux first is acceptable.

## 7. Open questions

1. **Mirror to the phone.** Rejected for now. Terminal output is sensitive, and a
   mirror would be a new read path that must be designed on its own. Revisit only
   with a separate plan.
2. **Persist scrollback.** Recommendation: no, for the reason in §5.
3. **Rendering engine.** Recommendation: the xterm-compatible emulator in §3, if
   its licence check passes in S1. Measure throughput on heavy output in S1.
