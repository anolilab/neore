# Desktop dictation on Hex: replace the whisper.cpp helper

Status: plan, 2026-10-31, owner-approved direction (bundle Hex, replace whisper.cpp). Starts
after the open agent-host PRs have merged, like [coding-workbench.md](coding-workbench.md).
Follows [desktop-dictation.md](desktop-dictation.md), whose S1–S4 are built; this plan changes
only the recogniser and its model store. Window, capture, hold key, insert, settings and
permissions stay as they are. Each slice is one PR. Sizes: S = one small PR, M = one PR that
needs design, L = several PRs.

Read first: CLAUDE.md "Desktop dictation", [desktop-dictation.md](desktop-dictation.md) §3, §5
and Appendix A, `apps/desktop/src/dictation/` (`recognizer.ts`, `catalog.ts`,
`model-store.ts`, `real-helper.test.ts`), `apps/desktop/scripts/build-dictation-helper.mjs`,
`.github/workflows/dictation-desktop.yml`.

## 1. Goal and decision

Dictation keeps its behaviour, and the recogniser becomes Hex
([anomalyco/hex](https://github.com/anomalyco/hex), MIT, Rust), run as an embedded helper we
build, pin, sign and ship ourselves. The whisper.cpp helper, its build script, its model store
and its CI matrix are removed once every supported platform has passed on Hex.

Why: Hex is actively maintained around exactly this job (on-device speech for desktop apps),
ships a model catalogue with pinned checksums, Parakeet models we expect to beat whisper
small on speed (H0 measures it; upstream only claims this with Vulkan on x64, and ARM64
transcribes on the CPU), and Metal (macOS) / Vulkan (Windows, Linux) acceleration. Our
whisper.cpp pin is ours alone to maintain, and its CPU-only Windows build is close to the
1.5× budget (one CI run on `windows-latest` measured 2.72×).

Decisions:

- **Bundled, never discovered.** We build Hex from a pinned commit, record the SHA-256 of
  every binary we ship, and spawn only that file. A Hex app the user installed is never used
  or contacted (no `local-api.json` discovery, no `connect()`).
- **Embedded mode only.** `hex service --embedded`: a direct child, stdin as its lifetime
  lease, a one-line JSON handshake on stdout (`url`, bearer `token`, `apiVersion: "2"`),
  HTTP on `127.0.0.1:0` only, no CORS. The token never leaves the main process.
- **Isolated state.** The helper runs with `HEX_APPLICATION_SUPPORT_DIR` set to
  `<userData>/dictation/hex`, so its models, logs and receipts live under our app data and
  never mix with a user-installed Hex. Delete in settings removes files there.
- **No silent fallback, no cloud** (unchanged from desktop-dictation.md §1).
- **Same budget.** A supported platform's default model must finish the spoken 11 s clip in
  at most 1.5 times its length on a four-core runner, measured on the shipped binary.
- **Upstream first for gaps.** Anything Hex lacks (below) is proposed upstream before we
  patch around it; a local patch is the fallback, carried in the build script with a link.

## 2. What Hex gives us, and what it does not (checked 2026-10-31, Hex 3.0.0, SDK 0.3.1)

| Fact | Source |
| --- | --- |
| `service --embedded` and the modules behind it (`local_api`, `transcription_service`) are compiled on all three OSes, and we found no run-time OS refusal in `run_service` | `src/main.rs` (`Command::Service`, the `mod` list), `src/local_api.rs` |
| **Conflicting upstream evidence:** the README says the Windows beta does not include "the local transcription API"; `docs/cli.md` says Linux and Windows publish the same local API; their SDK plan (2026-09-01) still calls both modules macOS-gated. Upstream has validated the embedded path only on Apple Silicon macOS. H0 decides per platform | README "Windows Beta", `docs/cli.md`, `docs/specs/local-transcription-service.md`, `docs/plans/typescript-sdk.md` |
| No published helper binary: `@hex-ai/service-darwin-arm64` is a private placeholder; consumers pass an explicit command | `sdk/service-darwin-arm64/README.md` |
| API 2: `GET /health`, `GET /models`, `POST /models/{id}/prepare` (SSE progress), `POST /transcriptions?model=` (PCM WAV, 8–48 kHz, int or f32, capped at about 5.8 min) | spec, "Wire Protocol (API 2)" |
| No partial transcripts in embedded mode (`partialTranscripts: false`); streaming exists only inside the Hex app | spec, Capabilities |
| No delete endpoint; model files live under the support dir | spec; `src/app_paths.rs` |
| Model artifacts are fetched from `huggingface.co` at pinned revisions and verified against SHA-256s compiled into the binary | `src/transcription_models.rs` |
| `HEX_APPLICATION_SUPPORT_DIR` overrides the support dir; logs go to `<support>/logs` | `src/app_paths.rs` |
| The uploaded WAV is not saved by the HTTP path; diagnostic logs may contain transcript text | spec; README "Privacy and local data" |
| `HEX_RETAIN_DICTATION_AUDIO` would keep WAVs on disk | README |
| Inference uses a patched transcribe.cpp fork (Metal / Vulkan / CPU); x64 needs AVX2 | `Cargo.toml` `[patch.crates-io]`, README |
| Models offered: `parakeet_unified_en`, `parakeet_v2`, `parakeet_v3`, `whisper_large_v3_turbo`, `qwen3_asr06_b`, `qwencleo_asr_1_7b`, `sense_voice_small`, `cohere_transcribe`, … | spec, `ModelId` |

The binary is the whole Hex app (tray, UI, capture), not a transcription-only build. That
matters for size, link dependencies (Linux GUI libraries) and signing; H0 measures it.

## 3. Invariants crossed

All of desktop-dictation.md §5 still hold. What changes:

- **Checksums.** Today the model SHA-256 ships in our build (`catalog.ts`). With Hex it ships
  inside the helper binary, and the helper binary's SHA-256 ships in our build
  (`resources/dictation/manifest.json`). The chain stays: our build → helper digest →
  model digests. A test asserts the spawned file's digest before first use.
- **Who downloads.** The helper downloads models, not our main process. It has a network
  path the dictation window still does not have. The download host stays Hugging Face. Our
  stall/deadline rules (`model-store.ts`) are replaced by Hex's; H0 checks that a stalled
  download fails within a bounded time and that `close()` stops it. Today's download goes
  through Electron's `net.fetch`, which uses the system proxy; Hex's downloader is its own,
  so H0 checks whether it honours `HTTPS_PROXY` (then passed through the env allowlist) and
  a proxy-only network is a listed limitation if it does not.
- **No audio on disk.** The WAV goes over loopback HTTP from memory. The helper is spawned
  with the existing env allowlist (`recognizer.ts` `ENV_ALLOWLIST`) plus
  `HEX_APPLICATION_SUPPORT_DIR`, so `HEX_RETAIN_DICTATION_AUDIO` can never reach it. The
  S2 test that scans temp and app data after a dictation runs against the Hex helper.
- **No transcript in logs.** If the embedded helper writes transcript text to
  `<support>/logs`, that breaks "no user text stored". H0 checks; the fix is upstream (an
  embedded-mode log level) or a log directory we delete after each session.
- **Licences.** Hex is MIT: its licence text ships in the app's third-party notices, with
  those of its Rust dependency tree and the transcribe.cpp / ggml fork (H1). Model licences
  differ per model and are not checked yet: H0 reads each one, the picker shows any
  attribution a licence requires, and a model whose licence forbids our use is not offered.

## 4. Slices

**H0 — Viability probe (M).** One CI workflow builds Hex at the pinned commit on every
platform we support today (darwin-arm64, linux-x64, linux-arm64, win32-x64, win32-arm64) and
runs the embedded helper against whisper.cpp's `jfk.wav` and the nine-language set from
`tools/dictation-bench/`.
- Records, per platform: build time and toolchain (Rust, Vulkan SDK, cmake, clang-cl on
  Windows arm64), binary size, linked libraries (Linux: everything beyond libc; the current
  helper links only libc and is capped at glibc 2.35), handshake time, prepare time, time
  for the 11 s clip per model, peak memory, mean error per language.
- Checks: `HEX_APPLICATION_SUPPORT_DIR` is honoured by the embedded mode; what the helper
  logs; stdin EOF stops it within 5 s, including mid-download and mid-inference; a killed
  host leaves no orphan helper or downloader; a stalled download fails in bounded time; the
  binary starts on a machine with no GPU and no Vulkan loader (CPU fallback, not a crash);
  model licences.
- Output: a go / no-go per platform and the default model per platform and language, in
  Appendix A. A no-go platform keeps whisper.cpp until upstream fixes it (H5 then waits for
  it), or is marked unsupported if the owner prefers.
- Acceptance: the appendix table is filled from CI artefacts; every no-go names its reason.

**H1 — Helper build and packaging (M).** `apps/desktop/scripts/build-dictation-helper.mjs`
builds Hex instead of whisper.cpp: the pinned commit, `cargo build --release --locked`, the
per-platform flags H0 chose, a manifest with the commit, version and SHA-256 per target.
electron-builder ships it as today (`helper/${os}-${arch}` → `resources/dictation`, with its licence
texts; `src/dictation/index.ts` refuses cleanly where none was built).
- macOS: the helper is signed with our Developer ID and hardened runtime as a nested
  executable, and notarised with the app; verified after re-signing (digest and identity
  change at that step, so the manifest records the pre-sign digest of the upstream build and
  the packaging step checks it before signing).
- Windows: signed with the desktop app's signing step if one exists; otherwise the same
  status as the current helper.
- Linux: the link-dependency check from the current script, with the list H0 accepted.
- Notices: the third-party licence texts beside the helper (today whisper.cpp's) are
  generated from the pinned build (`cargo about` over Hex's lockfile, plus the
  transcribe.cpp / ggml fork's licence), and the build fails when one is missing.
- The build skips when the output is newer than the pin, as today.
- Acceptance: packaging fails when a helper is missing, stale or its digest differs; CI
  builds every target and uploads the manifest.

**H2 — Hex recogniser (M).** `recognizer.ts` gains a `createHexRecognizer` behind the
existing `Recognizer` interface:
- Spawns the helper with the env allowlist plus the support dir, reads the handshake line
  (deadline, size cap, `apiVersion === "2"` required), keeps the token in memory, and holds
  stdin as the lease.
- One warm helper per enabled dictation, closed after an idle period and on disable, quit
  and sign-out. Not after every clip.
- `transcribe(wav, language)` posts the in-memory WAV with a deadline; cancel closes the
  helper (Hex cannot interrupt native inference otherwise) and the next dictation starts a
  new one; a `busy` answer is shown as an error, not queued.
- Failures map onto `RecognizerFailure` (`crashed`, `failed`, `timeout`, `unavailable`).
- Client: direct `fetch` over loopback from the main process (about 150 lines, no new
  dependency), or `@kitlangton/hex` pinned exactly. Recommendation: direct `fetch`; the
  SDK is 0.x, and the contract we use is four endpoints. H0 may reverse this if the SDK's
  cleanup handling turns out to be the hard part.
- Acceptance: unit tests against a fake helper (handshake, bad handshake, wrong API
  version, 401, busy, timeout, crash mid-request, cancel); the S2 acceptance tests (network
  blocked after the model is prepared, killed helper, no audio on disk) pass against the
  real helper in CI.

**H3 — Models and settings (M).** `catalog.ts` maps our nine languages plus `auto` to Hex
model ids per platform, from H0's measurements (an English-only model such as
`parakeet_unified_en` is offered only for `en`). `model-store.ts` becomes a thin layer over
`GET /models` and `POST /models/{id}/prepare`: sizes from `downloadBytes`, progress from the
SSE stream, the existing confirm dialog before a download, delete by removing that model's
files from our support dir while no helper holds them.
- Settings show each model's licence attribution where its licence requires one.
- Acceptance: with the switch off, nothing is downloaded and no helper starts; a prepare
  interrupted by quit leaves no usable partial file; delete frees the bytes it listed.

**H4 — Migration and removal (S).** On first start after the update, an existing whisper
model under `<userData>/dictation/models` is deleted with a one-time notice that dictation
needs a new download (sizes shown), and the saved model choice is mapped to the new default.
whisper.cpp, its build path, its catalog entries and the `whisper-cli` CI steps are removed;
`real-helper.test.ts` and `catalog.test.ts` run on the Hex helper. CLAUDE.md's "Desktop
dictation" entry is rewritten (whisper-cli flags, `-otxt`, `-l auto` and the model sizes go;
the Hex handshake, support dir and pin rules come in). `desktop-dictation.md` S4 notes point
here.
- Acceptance: a profile with a whisper model upgrades to a working Hex dictation after one
  confirmed download; nothing named whisper-cli remains in the desktop build.

**H5 — Upstream and follow-ups (S each, owner decides what to file).** Candidates for the
Hex repository, each as an issue or PR from us:
1. A transcription-only build (cargo feature) without tray, UI and capture, so the helper is
   smaller and links no GUI libraries on Linux.
2. Embedded-mode logging without transcript text.
3. A delete endpoint for model files.
4. Partial transcripts over the embedded API, which would let the dictation window show
   text while the person speaks.
5. Windows and Linux embedded mode as supported upstream, with our CI as evidence.

Order: H0, then H1 and H2 in parallel, then H3, then H4. H5 items are filed as H0 finds them.

## 5. Risks

- **Upstream moves fast.** Hex 3.0.0 is a day old and API 2 is young. We pin a commit, read
  the changelog before each bump, and our fake-helper tests pin the contract we rely on.
- **Not validated upstream off macOS, and the evidence conflicts (§2).** If embedded mode does
  not work on Windows or Linux, four of our five platforms wait on upstream, and H5.5 becomes
  the critical path, not a follow-up. H0 is the gate; whisper.cpp stays where it fails.
- **Size.** The full app is larger than a transcription-only helper, and Vulkan builds carry
  shaders. Measured in H0; H5.1 is the fix.
- **CPU floor.** Hex x64 needs AVX2, the same floor as our current helper.
- **GPU drivers.** A broken Vulkan driver must fall back to CPU, not crash. Tested in H0 on a
  runner without a GPU.
- **Signing.** Re-signing a third-party binary inside our bundle on macOS; verified in H1
  with the notarised artefact, not only a local build.
- **Model licences.** Unknown until H0 reads them (Qwen, Cohere and SenseVoice weights may
  carry terms the others do not); attribution shown where required.
- **Proxies.** Behind a proxy that only Electron's `net` knows about, the helper's download
  may fail where today's succeeds. H0 measures; the fallback is a prepare step that downloads
  through `net.fetch` into the support dir, if Hex accepts a pre-placed verified file.

## 6. Open questions

1. **Keep whisper.cpp for a no-go platform, or mark it unsupported?** Recommendation: keep
   it for one release while the upstream fix lands, then remove it.
2. **SDK or direct client?** Recommendation: direct `fetch` (H2), revisited after H0.
3. **Default model per language.** Decided by H0's measurements, against the error rates in
   desktop-dictation.md Appendix A.

## Appendix A — H0 measurements

To be filled by H0.
