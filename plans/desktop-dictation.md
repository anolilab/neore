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
in the app. Output: one chosen model, or a stop (per platform; Windows arm64 is
decided in S4, see Appendix A).
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

S4 as built (`.github/workflows/dictation-desktop.yml`, `apps/desktop/scripts/build-dictation-helper.mjs`):

- **Helper.** The same whisper.cpp pin on Windows x64, Linux x64 and Linux arm64, plus Windows arm64 built with
  clang-cl (ggml refuses to build ARM with MSVC unless it may tune for the build machine, which the portable build
  never does). `GGML_NATIVE=OFF` on ARM leaves bare armv8-a, which has no half-precision or dot-product instructions, so
  arm64 builds set `armv8.2-a+fp16+dotprod` (Cortex-A75 and later; a Raspberry Pi 4 is below it). `GGML_OPENMP=OFF`
  everywhere but macOS: its runtime (`vcomp140`, `libgomp`) is not inside a single file. **CPU floor:** on x64
  `GGML_NATIVE=OFF` still enables AVX2, FMA, F16C and BMI2, so a CPU older than Haswell (2013; AMD older than Excavator)
  dies with SIGILL at start, which dictation reports as a helper error; ARM builds need Cortex-A75 or later (v8.2-a with
  half-precision and dot product). Nothing detects an older CPU at run time. The script checks the finished
  binary: Linux links only the C library (and the glibc it needs is printed and, with `--max-glibc`, capped, which the
  release and CI do on the 22.04 runners, 2.35; CI tests that binary on the 24.04 runners), Windows imports no Visual C++ runtime DLL.
- **Text on every OS.** At the pin, `-f - -otxt` makes the helper open `/dev/stdout` (the console, `CON`, on Windows). A
  Node pipe is a socket, which cannot be opened by path, so the helper exits 0 with no text: CI showed it on Linux, and
  Windows has the same shape. The helper is given an output name that is not `-` and no format flag instead, which makes it
  print each segment to stdout itself, one line per segment behind a timestamp (`parseTranscript` strips it); no file is
  opened under that name. The same arguments on every OS. Only the real helper shows this, so CI runs it on a spoken clip.
- **Microphone.** macOS asks once (unchanged). Windows has no prompt for a desktop app, only a switch in Settings →
  Privacy & security → Microphone: an explicit refusal stops the dictation with that path in the message, anything else is left to the
  capture, which reports `denied` if it is blocked. Linux has no OS gate; the page's `denied` / `no-device` is the answer.
- **Models.** Small is the default on every machine without a GPU, as in Appendix A.
- **Unsupported.** `unsupportedReason` (`catalog.ts`) lists the platforms that are built, packaged and tested;
  everywhere else settings says so, offers nothing and the shortcut stays off. Windows on ARM is not in the list yet, and
  neither are Intel Macs. CI runs each runner with `NEORE_DICTATION_EXPECT`, so the table must agree with the runner it
  runs on, and the Windows on ARM leg asserts the settings page says "unavailable".
- **Budget.** A supported platform's default model must finish a spoken 11 s clip in at most 1.5 times its length on a
  four-core runner (`real-helper.test.ts`; the slowest build S1 accepted took 0.84 times, the MSVC Windows arm64 build it
  rejected 4.3). The Windows on ARM leg only records its time (small, base and tiny) in its step summary: when small is
  inside the budget there, its entry moves into `SUPPORTED`, `desktop.yml` builds it with `-- --arch arm64`, and the
  smoke test counts it. Until then the clang-cl measurement is pending, and so is Appendix A's row for it (Appendix A is
  part of the S1 branch, which is not on this one).

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

## Appendix A — S1 spike measurements

Harness: `tools/dictation-bench/` (`bench.py`, 18 prompts in the nine supported
languages read by synthetic voices, plus one clip of exactly ten seconds), run by
`.github/workflows/dictation-bench.yml`. Recogniser: whisper.cpp v1.9.5 (pinned
commit in the workflow). The error figure is the mean of the per-language rates (word
error rate, character error rate for Japanese and Chinese), so languages counted
in characters and in words are not mixed in one total. "10 s clip" is the wall time to finish the
ten-second clip with batch decoding. First-word latency is not measured here:
batch decoding returns the text only at the end. S2 measures it with streamed
partial results on the chosen model. Peak memory is
the process's resident peak.

| Platform | Model | Size | Mean error per language | 10 s clip | CPU time (10 s clip) | Peak memory |
| --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 (M4, Metal, machine under build load) | tiny | 78 MB | 16.1 % | 0.70 s | 0.53 s | 279 MB |
| macOS arm64 | base | 148 MB | 12.2 % | 0.67 s | — | 383 MB |
| macOS arm64 | small | 488 MB | 6.5 % | 1.38 s | — | 857 MB |
| macOS arm64 | large-v3-turbo q5_0 | 574 MB | 1.5 % | 3.91 s | — | 852 MB |
| Linux x64 (GitHub runner, 4 vCPU, no GPU) | tiny | 78 MB | 15.9 % | 1.15 s | 4.2 s | 177 MB |
| Linux x64 | base | 148 MB | 12.2 % | 2.15 s | 8.0 s | 285 MB |
| Linux x64 | small | 488 MB | 6.5 % | 6.68 s | 25.2 s | 751 MB |
| Linux x64 | large-v3-turbo q5_0 | 574 MB | 1.5 % | 39.0 s | 154 s | 794 MB |
| Linux arm64 (runner, 4 vCPU) | tiny | 78 MB | 15.9 % | 1.46 s | 5.3 s | 176 MB |
| Linux arm64 | base | 148 MB | 12.2 % | 2.76 s | 10.4 s | 284 MB |
| Linux arm64 | small | 488 MB | 6.5 % | 8.44 s | 32.5 s | 750 MB |
| Linux arm64 | large-v3-turbo q5_0 | 574 MB | 1.5 % | 44.6 s | 176 s | 793 MB |
| Windows x64 (runner, 4 vCPU) | tiny | 78 MB | 15.9 % | 1.22 s | 4.2 s | 195 MB |
| Windows x64 | base | 148 MB | 12.2 % | 2.23 s | 8.1 s | 303 MB |
| Windows x64 | small | 488 MB | 6.5 % | 6.84 s | 25.1 s | 769 MB |
| Windows x64 | large-v3-turbo q5_0 | 574 MB | 1.5 % | 36.8 s | 140 s | 812 MB |
| macOS x64 (runner, CPU only) | tiny | 78 MB | 15.9 % | 1.65 s | 4.5 s | 228 MB |
| macOS x64 | base | 148 MB | 12.2 % | 2.67 s | 8.1 s | 338 MB |
| macOS x64 | small | 488 MB | 6.5 % | 7.47 s | 24.8 s | 809 MB |
| macOS x64 | large-v3-turbo q5_0 | 574 MB | 1.5 % | 25.4 s | 87.2 s | 874 MB |
| Windows arm64 (runner, 4 vCPU) | tiny | 78 MB | 15.9 % | 5.15 s | 19.7 s | 184 MB |
| Windows arm64 | base | 148 MB | 12.2 % | 11.2 s | 44.1 s | 294 MB |
| Windows arm64 | small | 488 MB | 6.5 % | 42.9 s | 169 s | 755 MB |
| Windows arm64 | large-v3-turbo q5_0 | 574 MB | 1.5 % | 295 s | 1,047 s | 720 MB |

macOS x64: a first run used Metal on the runner's virtual GPU, which was slower
than the CPU (tiny took 23 s for the 10 s clip) and returned no text for the
quantised large model; the rows above are the CPU-only run (`--no-gpu`), which
is also what Intel Macs should use. Windows arm64 is four to seven times slower than
Linux arm64 on the same model, which points at the build rather than the chip: the
leg builds with MSVC, and ggml's arm64 fast paths are written for GCC and Clang.
S4 rebuilds it with clang-cl and measures again before choosing its model.

Error rates are the same on every platform that ran, so accuracy depends only on
the model; speed depends on the hardware. Without a GPU, large-v3-turbo needs
about four times the clip's length on these 4-core runners.

**Licences.** whisper.cpp is MIT. The Whisper model weights are MIT (released by
their authors under MIT), and the ggml conversions are published under the same
terms, so both may be redistributed inside the app with the licence text.

**Recommendation.** Pick the model per machine, from what the recogniser can use:

- **Apple Silicon:** large-v3-turbo q5_0 (574 MB). It is the only candidate that
  holds in all nine languages (1.5 % mean across languages, no language above 6 %), and Metal
  finishes a 10 s clip in about 4 s.
- **Machines without a supported GPU (Windows, Linux, Intel Macs):** small
  (488 MB, 6.5 %), about 7 s for a 10 s clip on a 4-core runner and faster on a
  typical desktop CPU. Settings says it is weaker on Chinese (24 %) and Italian
  (14 %), and offers large-v3-turbo as a slower, more accurate choice.
- **Windows arm64:** undecided until S4's clang-cl rebuild. As measured, even
  small takes four times the clip's length, so only tiny or base would be usable.
- A GPU backend for Windows and Linux (Vulkan or CUDA builds of whisper.cpp) would
  let them use large-v3-turbo too; that is a packaging question for S2, not a
  reason to block it.

The chosen models' licences allow redistribution (above). Every platform row is
recorded, so S1 is done for macOS, Windows x64 and Linux. S1's model-or-stop decision
for Windows arm64 is deliberately left open and decided in S4, once the clang-cl rebuild
shows what that platform can run; until then dictation is not offered there.
