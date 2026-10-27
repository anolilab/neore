# Desktop dictation: on-device speech for the composer

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
Independent of the host plans. Adds an option; the cloud path stays the default.

## 1. Goal and decision

A desktop user can hold a key to dictate a prompt, and the transcript lands in the
composer. With the on-device option on, no audio leaves the machine.

Decisions:

- **Opt-in, off by default.** The cloud voice path stays the default
  (`backend/lunora/voice/`, `apps/web/src/features/chat/voice-mode/`).
- **No silent fallback.** If the on-device model fails, dictation says so. It does
  not send the audio to the cloud. Switching to the cloud is a user action.
- **Capture and recognition run in a dedicated local window**, with its own
  sandboxed preload and no network access. The site page gets no new channel and no
  audio. The text comes back through the existing draft channel
  (`apps/web/src/lib/native/bridge.ts`, `onNativeDraft`), which puts it in the
  composer. It does not use `onNativeCompose`, which submits a new chat. Sending
  stays a separate action by the user.
- **The model is a downloadable asset.** It is pinned by version, verified by
  checksum before first use, and deleted from settings on request.

## 2. Current state (checked)

- Cloud voice exists: a scribe token is minted by `authorizeScribeToken`
  (`backend/lunora/voice/functions.ts`), and voice mode in the web app listens
  through `apps/web/src/features/chat/voice-mode/listen.ts` and
  `utterance-detector.ts`. Audio goes to a cloud provider.
- The desktop app has no local speech code. Its only native capabilities are the
  device relay, notifications, tray, quick composer, and the sign-in flow
  (`apps/desktop/src/`).
- The shell's preload exposes `window.neoreNative` only on the site origin
  (`desktop-and-mobile-apps.md` §4). A new window needs its own preload.

## 3. Design

- **Window.** `dictation` is a local window, created from the main process when the
  hold key is pressed and closed when it is released. Its preload is a second
  sandboxed preload, checked by the same build script that checks the others
  (`apps/desktop/scripts/build.mjs`). It has no network permission. A test blocks
  network access for it and runs a full dictation.
- **Capture.** The window requests the microphone. The OS prompt is the consent.
  Audio stays in memory and is never written to disk.
- **Recognition.** A recognizer runs in a helper process, so a crash cannot take
  down the app. The helper loads the model from the app data directory. It returns
  text segments and a final transcript.
- **Microphone permission.** The desktop's permission handlers
  (`setPermissionRequestHandler` and `setPermissionCheckHandler` in
  `apps/desktop/src/main.ts`) grant `media` only to the trusted site origin, so the
  dictation window would be denied before its own consent step. S2 updates both handlers to
  allow microphone capture for the verified dictation window only, and keeps denying every
  other local window and every untrusted origin. Test: capture works in the dictation
  window, and the same request from another window is denied.
- **Insert.** The final text goes to the composer through the existing draft
  channel, which opens a new chat with the text restored in the composer and sends
  nothing. If the main window cannot take it (it is closed, or on the sign-in
  screen), the main process copies the text to the clipboard and tells the user.
- **Model store.** The model is listed in settings with its size, version and a
  delete action. A download is checked against a checksum shipped in the desktop
  build. A mismatch leaves no model on disk.

## 4. Slices

**S1 — Spike.** Measure candidate on-device models on macOS Apple Silicon and Intel,
Windows, and Linux. Record model size, download size, first-word latency, time to
finish for a 10-second clip, peak memory, CPU use, and accuracy on a fixed set of
prompts in the languages we support. Check each model's licence for redistribution
in the app. Output: one chosen model, or a stop.
- Acceptance: a table of measurements in the plan's appendix; the chosen model's
  licence is recorded and allows redistribution.

**S2 — Local window and insert.** Hold-to-dictate, the helper process, the model
store with checksum, insert into the composer.
- Acceptance: with the network blocked, a dictation completes and inserts text; a
  checksum mismatch leaves no model file; killing the helper shows an error and
  does not crash the app; released audio is not on disk after the window closes
  (test: scan the temp and app data directories).

**S3 — Settings.** Opt-in switch, model choice, delete model, language choice.
- Acceptance: with the switch off, no model is downloaded and no dictation window
  opens; delete removes the model file.

**S4 — Windows and Linux.** The same flow on the other two OSes, with the
microphone prompt and helper packaging for each.
- Acceptance: the S2 acceptance tests pass on each OS in CI, or the platform is
  marked unsupported in settings.

## 5. Invariants crossed

- The site origin gets no audio and no new IPC method. Every native channel is
  checked against the sender origin (`CLAUDE.md`, native shell).
- The dictation preload is sandboxed, and its only import is `electron`.
- No user audio is stored, logged or sent, when on-device is on.
- The model download is a fetch with a deadline. `apps/desktop/src` has no fetch helper
  today (no non-test `fetch` call), so the download uses the main process's global
  `fetch` with `AbortSignal.timeout`, and a test asserts the deadline. The checksum is
  shipped in the build, not fetched.

## 6. Risks

- **Model size and download.** A large download on first use. Measured in S1; the
  settings screen shows the size before the download.
- **Accuracy.** Weaker than the cloud model in some languages. Stated in settings,
  with the cloud option one click away.
- **CPU and battery.** Recognition on a laptop. Measured in S1, with a limit on
  continuous use.
- **Licence.** A model's licence may forbid redistribution. Checked in S1; a model
  that fails the check is not used.

## 7. Open questions

1. **Which languages at launch.** Recommendation: the languages the composer already
   offers voice in, if the chosen model covers them. Decide after S1.
2. **Hold key or toggle.** Recommendation: hold, with a toggle in settings.
3. **Cloud fallback.** Recommendation: none. A failure is shown, and the user
   chooses the cloud path.
