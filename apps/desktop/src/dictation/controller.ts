import type { ModelSpec } from "./catalog.js";
import type { CaptureFailure } from "./channels.js";
import { SAMPLE_RATE } from "./channels.js";
import type { ModelStore } from "./model-store.js";
import { ModelError } from "./model-store.js";
import type { Recognizer } from "./recognizer.js";
import { RecognizerError } from "./recognizer.js";

/** Holding longer than this ends the dictation as if the key had been released. */
export const MAX_RECORDING_MS = 60_000;
/** A second press this soon after the last one is the keyboard repeating (Windows repeats a held global shortcut), not a deliberate stop. */
export const REPEAT_GUARD_MS = 700;
/** Under 0.4 s of audio is a tap, not speech. */
const MIN_AUDIO_BYTES = Math.floor(SAMPLE_RATE * 2 * 0.4);
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * (MAX_RECORDING_MS / 1000);

export type DictationState = "idle" | "preparing" | "recording" | "transcribing";

export type DictationOutcome
    = | "cancelled"
        | "disabled"
        | "download-declined"
        | "download-started"
        | "downloading"
        | "empty"
        | "error"
        | "inserted"
        | "no-helper"
        | "no-microphone"
        | "too-short";

/** The dictation window, as the controller sees it. */
export interface CaptureWindow {
    close: () => void;
    /** Asks the page to stop its microphone and send what is left. Resolves once it has (or gives up waiting). */
    stop: () => Promise<void>;
}

export interface ControllerDependencies {
    /** Asks before a large download. Resolves with the answer. */
    confirmDownload: (spec: ModelSpec) => Promise<boolean>;
    /** The opt-in switch, read at every press: off means nothing happens, not even a model download. */
    enabled: () => boolean;
    /** Whether the helper binary exists in this build: dictation refuses cleanly where it was not built. */
    hasHelper: () => boolean;
    insert: (text: string) => void;
    log: (message: string) => void;
    /**
     * The OS-level microphone decision; `false` stops before a window opens. `"prompted"` means the system just asked
     * the person: the key may be up by now and nothing could see it, so this press ends and the next one records.
     */
    microphoneAllowed: () => Promise<boolean | "prompted">;
    /** The model the user chose (or this machine's default), read at every press. */
    model: () => ModelSpec;
    models: Pick<ModelStore, "download" | "ensureVerified" | "isDownloading" | "status">;
    notify: (title: string, body: string) => void;
    now: () => number;
    openWindow: () => CaptureWindow;
    startRecognizer: (modelPath: string) => Recognizer;
}

export interface DictationController {
    /** A chunk of audio from the page. The caller has already checked who sent it. Whether the chunk was kept. */
    addAudio: (chunk: Buffer) => boolean;
    cancel: () => void;
    /** The page reported a capture failure. */
    captureFailed: (failure: CaptureFailure) => void;
    lastOutcome: () => DictationOutcome | undefined;
    /** The shortcut was pressed. */
    press: () => void;
    /** The key was released, or focus left the dictation window. */
    release: () => void;
    state: () => DictationState;
    /** The window went away on its own. */
    windowClosed: () => void;
}

const CAPTURE_MESSAGES: Record<CaptureFailure, string> = {
    denied: "Neore can't use the microphone. Allow it in your system's privacy settings and try again.",
    error: "The microphone could not be opened.",
    "no-device": "No microphone was found.",
};

const TITLE = "Dictation";

/** Stops the helper once it exists; a helper that never started has nothing to stop. */
const killWhenStarted = async (pending: Promise<Recognizer>): Promise<void> => {
    try {
        const started = await pending;

        started.kill();
    } catch {
        // It failed to start, and the failure was already reported.
    }
};

export const createDictationController = (dependencies: ControllerDependencies): DictationController => {
    let state: DictationState = "idle";
    let outcome: DictationOutcome | undefined;
    /** Bumped when a dictation ends, so a step that was awaiting for an older one drops its result. */
    let generation = 0;
    let lastPress = -Infinity;
    let window: CaptureWindow | undefined;
    let chunks: Buffer[] = [];
    let bytes = 0;
    /** The key is up and the page is flushing its last chunk: audio still counts until `stop()` resolves. */
    let draining = false;
    let recognizer: Promise<Recognizer> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: DictationOutcome): void => {
        generation += 1;
        outcome = result;
        state = "idle";
        draining = false;
        clearTimeout(timer);
        timer = undefined;
        // The audio lives only in this array: dropping it is the whole of "released".
        chunks = [];
        bytes = 0;
        window?.close();
        window = undefined;

        const pending = recognizer;

        recognizer = undefined;

        if (pending !== undefined) {
            killWhenStarted(pending);
        }
    };

    const fail = (message: string, detail?: unknown): void => {
        dependencies.log(`dictation failed: ${message}${detail === undefined ? "" : ` (${String(detail)})`}`);
        settle("error");
        dependencies.notify(TITLE, message);
    };

    const failFrom = (error: unknown): void => {
        if (error instanceof RecognizerError) {
            fail(error.message, error.detail);
        } else if (error instanceof ModelError) {
            fail(error.message);
        } else {
            fail("Dictation stopped unexpectedly.", error);
        }
    };

    const download = async (spec: ModelSpec): Promise<void> => {
        dependencies.notify(TITLE, "Downloading the speech model. You will be told when it is ready.");

        try {
            await dependencies.models.download(spec);
            dependencies.notify(TITLE, "The speech model is ready. Hold the shortcut to dictate.");
        } catch (error) {
            // The user turned dictation off or deleted the model: they know, and a notice would only be noise.
            if (error instanceof ModelError && error.code === "cancelled") {
                return;
            }

            dependencies.log(`model download failed: ${String(error)}`);
            dependencies.notify(TITLE, error instanceof ModelError ? error.message : "The speech model could not be downloaded.");
        }
    };

    /** Whether a window should open now. Every step that waits checks that this dictation is still the current one. */
    const prepare = async (mine: number, model: ModelSpec): Promise<boolean> => {
        if (!dependencies.enabled()) {
            settle("disabled");

            return false;
        }

        if (!dependencies.hasHelper()) {
            settle("no-helper");
            dependencies.notify(TITLE, "On-device dictation is not available on this computer yet.");

            return false;
        }

        const { state: modelState } = await dependencies.models.status(model);

        if (modelState === "missing") {
            if (dependencies.models.isDownloading(model)) {
                settle("downloading");
                dependencies.notify(TITLE, "The speech model is still downloading. You will be told when it is ready.");

                return false;
            }

            const accepted = mine === generation && await dependencies.confirmDownload(model);

            if (mine !== generation) {
                return false;
            }

            // Switched off while the question was open: nothing is fetched.
            if (accepted && !dependencies.enabled()) {
                settle("disabled");

                return false;
            }

            if (!accepted) {
                settle("download-declined");

                return false;
            }

            settle("download-started");
            download(model);

            return false;
        }

        const allowed = await dependencies.microphoneAllowed();

        if (mine !== generation) {
            return false;
        }

        if (allowed === "prompted") {
            settle("no-microphone");
            dependencies.notify(TITLE, "Microphone access is on. Hold the shortcut again to dictate.");

            return false;
        }

        if (!allowed) {
            settle("no-microphone");
            dependencies.notify(TITLE, CAPTURE_MESSAGES.denied);

            return false;
        }

        return true;
    };

    const startHelper = async (mine: number, model: ModelSpec): Promise<Recognizer> => {
        const modelPath = await dependencies.models.ensureVerified(model);
        const started = dependencies.startRecognizer(modelPath);

        started.onEarlyExit((error) => {
            if (mine === generation) {
                failFrom(error);
            }
        });

        return started;
    };

    /** A model that fails its checksum, or a helper that cannot start, ends the dictation with its message. */
    const watchStart = async (pending: Promise<Recognizer>, mine: number): Promise<void> => {
        try {
            await pending;
        } catch (error) {
            if (mine === generation) {
                failFrom(error);
            }
        }
    };

    const begin = async (): Promise<void> => {
        state = "preparing";

        const mine = generation;
        // One model for this whole dictation: a change in settings applies to the next one.
        const model = dependencies.model();

        try {
            if (!await prepare(mine, model)) {
                return;
            }
        } catch (error) {
            // A cancelled attempt's late error is not a newer press's to carry.
            if (mine === generation) {
                failFrom(error);
            }

            return;
        }

        if (mine !== generation) {
            return;
        }

        window = dependencies.openWindow();
        state = "recording";
        timer = setTimeout(finish, MAX_RECORDING_MS);

        // The model is checked while the user speaks; the helper starts as soon as it passes, so it is loading by the time the key is up.
        recognizer = startHelper(mine, model);
        watchStart(recognizer, mine);
    };

    const finish = async (): Promise<void> => {
        if (state !== "recording") {
            return;
        }

        state = "transcribing";
        clearTimeout(timer);

        const mine = generation;
        const pending = recognizer;
        const mineWindow = window;

        draining = true;

        try {
            await mineWindow?.stop();
        } catch {
            // The page is gone; what arrived is what there is.
        }

        // A newer dictation may have started since; its flag and window are not ours to clear.
        if (mine === generation) {
            draining = false;
        }

        // Closed on release: the microphone is off and the page, with any audio it held, is destroyed.
        mineWindow?.close();

        if (window === mineWindow) {
            window = undefined;
        }

        if (mine !== generation) {
            return;
        }

        const audio = Buffer.concat(chunks);

        chunks = [];

        if (audio.length < MIN_AUDIO_BYTES) {
            settle("too-short");

            return;
        }

        try {
            const helper = await pending;
            const { text } = await helper?.transcribe(audio) ?? { text: "" };

            if (mine !== generation) {
                return;
            }

            if (text === "") {
                settle("empty");
                dependencies.notify(TITLE, "No speech was recognised.");

                return;
            }

            settle("inserted");
            dependencies.insert(text);
        } catch (error) {
            if (mine === generation) {
                failFrom(error);
            }
        }
    };

    return {
        addAudio: (chunk) => {
            if ((state !== "recording" && !draining) || bytes + chunk.length > MAX_AUDIO_BYTES) {
                return false;
            }

            chunks.push(chunk);
            bytes += chunk.length;

            return true;
        },
        cancel: () => {
            // Transcribing too: settling kills the helper, and the late result is dropped by the generation check.
            if (state !== "idle") {
                settle("cancelled");
            }
        },
        captureFailed: (failure) => {
            if (state === "recording") {
                fail(CAPTURE_MESSAGES[failure]);
            }
        },
        lastOutcome: () => outcome,
        press: () => {
            const now = dependencies.now();
            const sincePrevious = now - lastPress;

            lastPress = now;

            if (state === "idle") {
                begin();
            } else if (state === "recording" && sincePrevious > REPEAT_GUARD_MS) {
                finish();
            }
        },
        release: () => {
            finish();
        },
        state: () => state,
        windowClosed: () => {
            // Our own close during `finish` or `settle` arrives here too, with the window already forgotten.
            if (window !== undefined && state === "recording") {
                settle("cancelled");
            }
        },
    };
};
