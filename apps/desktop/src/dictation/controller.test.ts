import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSpec } from "./catalog.js";
import type { CaptureWindow, ControllerDependencies, DictationController } from "./controller.js";
import { createDictationController, MAX_RECORDING_MS, REPEAT_GUARD_MS } from "./controller.js";
import type { ModelStatus } from "./model-store.js";
import { ModelError } from "./model-store.js";
import type { Recognizer } from "./recognizer.js";
import { RecognizerError } from "./recognizer.js";

const MODEL: ModelSpec = { bytes: 1, file: "m.bin", id: "m", label: "M", sha256: "0".repeat(64), url: "https://x.example/m.bin", version: "v1" };
const ONE_SECOND = Buffer.alloc(32_000, 3);

const buildDependencies = (window: CaptureWindow, recognizer: Recognizer, notices: string[]) => {
    return {
        confirmDownload: vi.fn(async (_spec: ModelSpec) => true),
        enabled: vi.fn(() => true),
        hasHelper: vi.fn(() => true),
        insert: vi.fn((_text: string) => {}),
        log: vi.fn((_message: string) => {}),
        microphoneAllowed: vi.fn(async () => true),
        model: () => MODEL,
        models: {
            download: vi.fn(async (_spec: ModelSpec) => "/models/m.bin"),
            ensureVerified: vi.fn(async (_spec: ModelSpec) => "/models/m.bin"),
            isDownloading: vi.fn((_spec: ModelSpec) => false),
            status: vi.fn(async (_spec: ModelSpec): Promise<ModelStatus> => { return { bytes: 1, file: "m.bin", state: "present", version: "v1" }; }),
        },
        notify: vi.fn((title: string, body: string) => {
            notices.push(`${title}: ${body}`);
        }),
        now: vi.fn(() => 1_000_000),
        openWindow: vi.fn(() => window),
        startRecognizer: vi.fn((_modelPath: string) => recognizer),
    };
};

interface Harness {
    controller: DictationController;
    deps: ReturnType<typeof buildDependencies>;
    notices: string[];
    recognizer: Recognizer & { early?: (error: RecognizerError) => void; transcribed: Buffer[] };
    window: CaptureWindow & { closed: number; stopped: number };
}

const harness = (overrides: Partial<ControllerDependencies> = {}, transcribe: (pcm: Buffer) => Promise<{ segments: string[]; text: string }> = async () => {
    return { segments: ["hi"], text: "hi there" };
}): Harness => {
    const notices: string[] = [];
    const window = {
        close: vi.fn(() => {
            window.closed += 1;
        }),
        closed: 0,
        stop: vi.fn(async () => {
            window.stopped += 1;
        }),
        stopped: 0,
    };
    const recognizer = {
        early: undefined as ((error: RecognizerError) => void) | undefined,
        exited: vi.fn(async () => {}),
        kill: vi.fn(),
        onEarlyExit: (listener: (error: RecognizerError) => void) => {
            recognizer.early = listener;
        },
        pid: 1234,
        transcribe: vi.fn(async (pcm: Buffer) => {
            recognizer.transcribed.push(pcm);

            return transcribe(pcm);
        }),
        transcribed: [] as Buffer[],
    };
    const dependencies = buildDependencies(window, recognizer, notices);

    return { controller: createDictationController({ ...dependencies, ...overrides }), deps: dependencies, notices, recognizer, window };
};

/** Lets the awaits inside `press()` (status, microphone, window) run. */
const settled = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
    }
};

const speak = async (h: Harness, audio: Buffer = ONE_SECOND): Promise<void> => {
    h.controller.press();
    await settled();
    h.controller.addAudio(audio);
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("a dictation", () => {
    it("opens the window on press, and on release closes it, recognises the audio and inserts the text", async () => {
        const h = harness();

        h.controller.press();
        await settled();

        expect(h.controller.state()).toBe("recording");
        expect(h.deps.openWindow).toHaveBeenCalledTimes(1);

        h.controller.addAudio(ONE_SECOND);
        h.controller.addAudio(ONE_SECOND);
        h.controller.release();
        await settled();

        expect(h.window.stopped).toBe(1);
        expect(h.window.closed).toBe(1);
        expect(h.recognizer.transcribed[0]?.length).toBe(64_000);
        expect(h.deps.insert).toHaveBeenCalledWith("hi there");
        expect(h.controller.lastOutcome()).toBe("inserted");
        expect(h.controller.state()).toBe("idle");
    });

    it("keeps the last chunk the page sends while it stops", async () => {
        const h = harness();
        const tail = Buffer.alloc(32_000, 9);

        vi.mocked(h.window.stop).mockImplementation(async () => {
            expect(h.controller.addAudio(tail)).toBe(true);
        });
        await speak(h);
        h.controller.release();
        await settled();

        expect(h.recognizer.transcribed[0]?.length).toBe(64_000);
        expect(h.recognizer.transcribed[0]?.subarray(32_000).equals(tail)).toBe(true);
    });

    it("refuses audio when it is not recording or draining", async () => {
        const h = harness();

        expect(h.controller.addAudio(ONE_SECOND)).toBe(false);

        await speak(h);
        h.controller.release();
        await settled();

        expect(h.controller.addAudio(ONE_SECOND)).toBe(false);
    });

    it("keeps no audio once it is over", async () => {
        const h = harness();

        await speak(h);
        h.controller.release();
        await settled();
        // A late chunk from the closed page is not collected for the next dictation.
        h.controller.addAudio(ONE_SECOND);
        await speak(h, Buffer.alloc(16_000));
        h.controller.release();
        await settled();

        expect(h.recognizer.transcribed.map((pcm) => pcm.length)).toStrictEqual([32_000, 16_000]);
    });

    it("loads the model while the user speaks: the helper starts before the key is released", async () => {
        const h = harness();

        h.controller.press();
        await settled();

        expect(h.deps.models.ensureVerified).toHaveBeenCalledTimes(1);
        expect(h.deps.startRecognizer).toHaveBeenCalledWith("/models/m.bin");
    });

    it("ends on a second press after the repeat guard, not on the keyboard repeating", async () => {
        let clock = 1_000_000;
        const h = harness({ now: () => clock });

        await speak(h);
        clock += 40;
        h.controller.press();
        await settled();
        expect(h.controller.state()).toBe("recording");

        clock += REPEAT_GUARD_MS + 1;
        h.controller.press();
        await settled();
        expect(h.deps.insert).toHaveBeenCalledWith("hi there");
    });

    it("ends after the longest recording even if the release never arrives", async () => {
        const h = harness();

        await speak(h);
        await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS + 1);

        expect(h.deps.insert).toHaveBeenCalledWith("hi there");
    });

    it("drops audio past the cap instead of growing without limit", async () => {
        const h = harness();

        h.controller.press();
        await settled();

        for (let index = 0; index < 100; index += 1) {
            h.controller.addAudio(Buffer.alloc(100_000));
        }

        h.controller.release();
        await settled();

        expect(h.recognizer.transcribed[0]?.length).toBeLessThanOrEqual(60 * 32_000);
    });

    it("treats a tap as nothing: no recognition and no message", async () => {
        const h = harness();

        await speak(h, Buffer.alloc(1000));
        h.controller.release();
        await settled();

        expect(h.recognizer.transcribe).not.toHaveBeenCalled();
        expect(h.deps.insert).not.toHaveBeenCalled();
        expect(h.notices).toStrictEqual([]);
        expect(h.controller.lastOutcome()).toBe("too-short");
        expect(h.recognizer.kill).toHaveBeenCalled();
    });

    it("says so when nothing was recognised, and inserts nothing", async () => {
        const h = harness({}, async () => {
            return { segments: [], text: "" };
        });

        await speak(h);
        h.controller.release();
        await settled();

        expect(h.deps.insert).not.toHaveBeenCalled();
        expect(h.notices).toStrictEqual(["Dictation: No speech was recognised."]);
    });

    it("discards the audio on cancel", async () => {
        const h = harness();

        await speak(h);
        h.controller.cancel();
        await settled();

        expect(h.window.closed).toBe(1);
        expect(h.recognizer.kill).toHaveBeenCalled();
        expect(h.deps.insert).not.toHaveBeenCalled();
        expect(h.controller.lastOutcome()).toBe("cancelled");
    });

    it("cancels while transcribing: the helper is stopped and its late result is dropped", async () => {
        let finishTranscribing: (value: { segments: string[]; text: string }) => void = () => {};
        // The tsconfig lib predates Promise.withResolvers.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const transcription = new Promise<{ segments: string[]; text: string }>((resolve) => {
            finishTranscribing = resolve;
        });
        const h = harness({}, () => transcription);

        await speak(h);
        h.controller.release();
        await settled();

        expect(h.controller.state()).toBe("transcribing");

        h.controller.cancel();
        await settled();

        expect(h.controller.state()).toBe("idle");
        expect(h.controller.lastOutcome()).toBe("cancelled");
        expect(h.recognizer.kill).toHaveBeenCalled();

        finishTranscribing({ segments: ["hi"], text: "hi there" });
        await settled();

        expect(h.deps.insert).not.toHaveBeenCalled();
        expect(h.controller.lastOutcome()).toBe("cancelled");
    });

    it("treats a window closed by the user as a cancel", async () => {
        const h = harness();

        await speak(h);
        h.controller.windowClosed();
        await settled();

        expect(h.controller.lastOutcome()).toBe("cancelled");
        expect(h.controller.state()).toBe("idle");
    });
});

describe("a failure", () => {
    it("shows the error and recovers when the helper dies during the recording", async () => {
        const h = harness();

        await speak(h);
        h.recognizer.early?.(new RecognizerError("crashed", "The speech engine stopped unexpectedly"));
        await settled();

        expect(h.notices).toStrictEqual(["Dictation: The speech engine stopped unexpectedly"]);
        expect(h.window.closed).toBe(1);
        expect(h.controller.state()).toBe("idle");

        // The next dictation works.
        await speak(h);
        h.controller.release();
        await settled();
        expect(h.deps.insert).toHaveBeenCalledWith("hi there");
    });

    it("shows the error when the helper dies while recognising", async () => {
        const h = harness({}, async () => {
            throw new RecognizerError("crashed", "The speech engine stopped unexpectedly");
        });

        await speak(h);
        h.controller.release();
        await settled();

        expect(h.notices).toStrictEqual(["Dictation: The speech engine stopped unexpectedly"]);
        expect(h.deps.insert).not.toHaveBeenCalled();
        expect(h.controller.state()).toBe("idle");
    });

    it("shows the error and uses nothing when the model fails its checksum", async () => {
        const h = harness();

        h.deps.models.ensureVerified.mockRejectedValue(new ModelError("checksum", "The speech model does not match its checksum and was removed"));

        await speak(h);
        await settled();

        expect(h.notices).toStrictEqual(["Dictation: The speech model does not match its checksum and was removed"]);
        expect(h.deps.startRecognizer).not.toHaveBeenCalled();
        expect(h.window.closed).toBe(1);
    });

    it.each([
        ["denied", "Neore can't use the microphone"],
        ["no-device", "No microphone was found."],
        ["error", "The microphone could not be opened."],
    ] as const)("reports a capture failure: %s", async (failure, message) => {
        const h = harness();

        await speak(h);
        h.controller.captureFailed(failure);

        expect(h.notices[0]).toContain(message);
        expect(h.window.closed).toBe(1);
        expect(h.controller.state()).toBe("idle");
    });
});

describe("before a window opens", () => {
    it("refuses cleanly where the helper was not built", async () => {
        const h = harness({ hasHelper: () => false });

        h.controller.press();
        await settled();

        expect(h.deps.openWindow).not.toHaveBeenCalled();
        expect(h.notices).toStrictEqual(["Dictation: On-device dictation is not available on this computer yet."]);
        expect(h.controller.lastOutcome()).toBe("no-helper");
    });

    it("opens no window when the operating system denies the microphone", async () => {
        const h = harness({ microphoneAllowed: async () => false });

        h.controller.press();
        await settled();

        expect(h.deps.openWindow).not.toHaveBeenCalled();
        expect(h.controller.lastOutcome()).toBe("no-microphone");
        expect(h.notices[0]).toContain("microphone");
    });

    it("ends the press that the system's first microphone prompt held, and says to hold the shortcut again", async () => {
        const h = harness({ microphoneAllowed: async () => "prompted" });

        h.controller.press();
        await settled();

        expect(h.deps.openWindow).not.toHaveBeenCalled();
        expect(h.controller.lastOutcome()).toBe("no-microphone");
        expect(h.notices[0]).toContain("Hold the shortcut again");
    });

    it("says where this OS keeps the microphone switch, when it was told", async () => {
        const h = harness({ microphoneAllowed: async () => false, microphoneSettings: "Settings → Privacy & security → Microphone" });

        h.controller.press();
        await settled();

        expect(h.notices[0]).toBe("Dictation: Neore can't use the microphone. Allow it in Settings → Privacy & security → Microphone and try again.");
    });

    it("asks before downloading a missing model, opens no window, and downloads once agreed", async () => {
        const h = harness();

        h.deps.models.status.mockResolvedValue({ state: "missing" });
        h.controller.press();
        await settled();

        expect(h.deps.confirmDownload).toHaveBeenCalledWith(MODEL);
        expect(h.deps.models.download).toHaveBeenCalledWith(MODEL);
        expect(h.deps.openWindow).not.toHaveBeenCalled();
        expect(h.controller.lastOutcome()).toBe("download-started");
        expect(h.notices.at(-1)).toContain("ready");
    });

    it("says the model is still downloading, without asking again", async () => {
        const h = harness();

        h.deps.models.status.mockResolvedValue({ state: "missing" });
        h.deps.models.isDownloading.mockReturnValue(true);
        h.controller.press();
        await settled();

        expect(h.deps.confirmDownload).not.toHaveBeenCalled();
        expect(h.deps.models.download).not.toHaveBeenCalled();
        expect(h.controller.lastOutcome()).toBe("downloading");
        expect(h.notices.at(-1)).toContain("still downloading");
    });

    it("downloads nothing when the person declines", async () => {
        const h = harness({ confirmDownload: async () => false });

        h.deps.models.status.mockResolvedValue({ state: "missing" });
        h.controller.press();
        await settled();

        expect(h.deps.models.download).not.toHaveBeenCalled();
        expect(h.controller.lastOutcome()).toBe("download-declined");
    });

    it("reports a failed download", async () => {
        const h = harness();

        h.deps.models.status.mockResolvedValue({ state: "missing" });
        h.deps.models.download.mockRejectedValue(new ModelError("checksum", "The downloaded speech model does not match its checksum"));
        h.controller.press();
        await settled();

        expect(h.notices.at(-1)).toBe("Dictation: The downloaded speech model does not match its checksum");
    });

    it("ignores presses while it is busy", async () => {
        const h = harness();

        await speak(h);
        h.controller.release();
        h.controller.press();
        await settled();

        expect(h.deps.openWindow).toHaveBeenCalledTimes(1);
    });
});

describe("with the switch off", () => {
    it("does nothing at all: no status check, no question, no download, no window, no helper", async () => {
        const h = harness({ enabled: () => false });

        h.controller.press();
        await settled();

        expect(h.controller.lastOutcome()).toBe("disabled");
        expect(h.controller.state()).toBe("idle");
        expect(h.deps.models.status).not.toHaveBeenCalled();
        expect(h.deps.models.isDownloading).not.toHaveBeenCalled();
        expect(h.deps.confirmDownload).not.toHaveBeenCalled();
        expect(h.deps.models.download).not.toHaveBeenCalled();
        expect(h.deps.microphoneAllowed).not.toHaveBeenCalled();
        expect(h.deps.openWindow).not.toHaveBeenCalled();
        expect(h.deps.models.ensureVerified).not.toHaveBeenCalled();
        expect(h.deps.startRecognizer).not.toHaveBeenCalled();
        expect(h.notices).toStrictEqual([]);
    });

    it("stays silent for a press made before the switch was turned on", async () => {
        let on = false;
        const h = harness({ enabled: () => on });

        h.controller.press();
        await settled();
        on = true;
        h.controller.press();
        await settled();

        expect(h.deps.openWindow).toHaveBeenCalledTimes(1);
    });

    it("asks for no microphone access when the switch went off while the model status was read", async () => {
        let on = true;
        const microphoneAllowed = vi.fn(async () => true);
        const h = harness({
            enabled: () => on,
            microphoneAllowed,
            models: {
                download: vi.fn(),
                ensureVerified: vi.fn(),
                isDownloading: vi.fn(() => false),
                status: vi.fn(async () => {
                    on = false;

                    return { bytes: 1, file: "m.bin", state: "present" as const, version: "v1" };
                }),
            },
        });

        h.controller.press();
        await settled();

        expect(microphoneAllowed).not.toHaveBeenCalled();
        expect(h.deps.openWindow).not.toHaveBeenCalled();
        expect(h.notices).toStrictEqual([]);
    });

    it("downloads nothing when the switch went off while the download question was open", async () => {
        let on = true;
        let answer: (accepted: boolean) => void = () => {};
        const question = {
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the tsconfig lib predates `Promise.withResolvers`
            promise: new Promise<boolean>((resolve) => {
                answer = resolve;
            }),
        };
        const h = harness({ confirmDownload: vi.fn(async () => question.promise), enabled: () => on });

        h.deps.models.status.mockResolvedValue({ state: "missing" });
        h.controller.press();
        await settled();
        on = false;
        answer(true);
        await settled();

        expect(h.deps.models.download).not.toHaveBeenCalled();
        expect(h.controller.lastOutcome()).toBe("disabled");
    });
});

describe("the chosen model", () => {
    it("is read at each press, and the helper loads the one this dictation began with", async () => {
        const other = { ...MODEL, file: "o.bin", id: "o" };
        let current = MODEL;
        const h = harness({ model: () => current });

        await speak(h);
        current = other;
        h.controller.release();
        await settled();

        expect(h.deps.models.status).toHaveBeenCalledWith(MODEL);
        expect(h.deps.models.ensureVerified).toHaveBeenCalledWith(MODEL);
    });

    it("says nothing about a download that was cancelled by turning dictation off", async () => {
        const h = harness();

        h.deps.models.status.mockResolvedValue({ state: "missing" });
        h.deps.models.download.mockRejectedValue(new ModelError("cancelled", "The model download was cancelled"));
        h.controller.press();
        await settled();

        expect(h.notices).toStrictEqual(["Dictation: Downloading the speech model. You will be told when it is ready."]);
    });
});
