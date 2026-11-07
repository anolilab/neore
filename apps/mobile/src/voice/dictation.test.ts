import { describe, expect, it, vi } from "vitest";

import type { DictationEngine, DictationPath } from "./dictation";
import { createDictationRouter, createDictationSetting, SETTING_UNREADABLE_MESSAGE } from "./dictation";
import type { OnDeviceRecognizer } from "./on-device";
import { createOnDeviceSession, createRecognizerLock, ON_DEVICE_UNAVAILABLE_MESSAGE, pickSpeechLocale } from "./on-device";
import { MIC_BUSY_MESSAGE } from "./voice-input";

const NOTHING_SENT = /Nothing was sent/u;
const NOTHING_HEARD = /No speech was heard/u;

const fakeEngine = (): DictationEngine => {
    return { finish: vi.fn(async () => {}), start: vi.fn(async () => {}) };
};

const fakeRecognizer = (hasOnDevice: boolean): OnDeviceRecognizer => {
    return {
        abort: vi.fn(),
        getMicrophonePermissionsAsync: async () => {
            return { granted: true };
        },
        getSupportedLocales: async () => {
            return { installedLocales: [], locales: ["de-DE", "en-US"] };
        },
        requestMicrophonePermissionsAsync: async () => {
            return { granted: true };
        },
        start: vi.fn(),
        stop: vi.fn(),
        supportsOnDeviceRecognition: () => hasOnDevice,
    };
};

/** A router over `engines`, with the setting read by `readOnDevice`; `errors` collects what the composer shows. */
const routed = (readOnDevice: () => Promise<boolean>, engines: Record<DictationPath, DictationEngine>) => {
    const errors: (string | undefined)[] = [];
    const router = createDictationRouter({
        engine: (path) => engines[path],
        onError: (message) => {
            errors.push(message);
        },
        onPath: () => {},
        readOnDevice,
    });

    return { errors, router };
};

describe(createDictationRouter, () => {
    it.each([
        [false, "cloud", "on-device"],
        [true, "on-device", "cloud"],
    ] as const)("with the setting %s, a press goes to %s only", async (isOnDevice, chosen, other) => {
        const engines = { cloud: fakeEngine(), "on-device": fakeEngine() };
        const { router } = routed(async () => isOnDevice, engines);

        await router.start();
        await router.finish();

        expect(engines[chosen].start).toHaveBeenCalledOnce();
        expect(engines[chosen].finish).toHaveBeenCalledOnce();
        expect(engines[other].start).not.toHaveBeenCalled();
        expect(engines[other].finish).not.toHaveBeenCalled();
    });

    it.each([
        ["cannot be read", async () => {
            throw new Error("keychain locked");
        }],
        ["holds a value never written", async () => "yes"],
    ])("records nothing when the setting %s", async (_name, getItem) => {
        const engines = { cloud: fakeEngine(), "on-device": fakeEngine() };
        const { readOnDevice } = createDictationSetting({ getItem, setItem: async () => {} });
        const { errors, router } = routed(readOnDevice, engines);

        await router.start();

        expect(errors.at(-1)).toBe(SETTING_UNREADABLE_MESSAGE);
        expect(engines.cloud.start).not.toHaveBeenCalled();
        expect(engines["on-device"].start).not.toHaveBeenCalled();
    });

    it("a press while switching on is still being saved goes on the device, not to the cloud", async () => {
        const values = new Map<string, string>();

        vi.useFakeTimers();

        const { readOnDevice, writeOnDevice } = createDictationSetting({
            getItem: async (key) => values.get(key) ?? null,
            setItem: async (key, value) => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 100);
                });
                values.set(key, value);
            },
        });
        const engines = { cloud: fakeEngine(), "on-device": fakeEngine() };
        const { router } = routed(readOnDevice, engines);

        const saving = writeOnDevice(true);
        const pressing = router.start();

        await vi.advanceTimersByTimeAsync(100);
        await Promise.all([saving, pressing]);
        vi.useRealTimers();

        expect(engines["on-device"].start).toHaveBeenCalledOnce();
        expect(engines.cloud.start).not.toHaveBeenCalled();
    });

    it.each([
        ["an iPhone without on-device recognition", { OS: "ios", Version: "18.0" }, false],
        ["Android 12, where on-device only prefers offline", { OS: "android", Version: 32 }, true],
        ["Android 13 without on-device recognition", { OS: "android", Version: 33 }, false],
    ])("on %s, shows the error and never calls the cloud path", async (_name, platform, hasOnDevice) => {
        const recognizer = fakeRecognizer(hasOnDevice);
        const errors: (string | undefined)[] = [];
        const onDevice = createOnDeviceSession({
            lang: "en-US",
            lock: createRecognizerLock(),
            now: () => 0,
            onError: (message) => {
                errors.push(message);
            },
            onPhase: () => {},
            onText: () => {},
            platform,
            recognizer,
        });
        const cloud = fakeEngine();
        const { router } = routed(async () => true, { cloud, "on-device": onDevice });

        await router.start();
        await router.finish();

        expect(errors.at(-1)).toBe(ON_DEVICE_UNAVAILABLE_MESSAGE);
        expect(recognizer.start).not.toHaveBeenCalled();
        expect(cloud.start).not.toHaveBeenCalled();
        expect(cloud.finish).not.toHaveBeenCalled();
    });

    it("a recognizer that fails mid-run shows the error, keeps the draft and never calls the cloud path", async () => {
        const recognizer = fakeRecognizer(true);
        const errors: (string | undefined)[] = [];
        const onText = vi.fn();
        let clock = 0;
        const onDevice = createOnDeviceSession({
            lang: "de-DE",
            lock: createRecognizerLock(),
            now: () => clock,
            onError: (message) => {
                errors.push(message);
            },
            onPhase: () => {},
            onText,
            platform: { OS: "android", Version: 34 },
            recognizer,
        });
        const cloud = fakeEngine();
        const { router } = routed(async () => true, { cloud, "on-device": onDevice });

        await router.start();
        clock = 2000;
        await router.finish();
        onDevice.handle({ code: "language-not-supported", type: "error" });
        onDevice.handle({ type: "end" });

        expect(recognizer.start).toHaveBeenCalledWith(expect.objectContaining({ lang: "de-DE", requiresOnDeviceRecognition: true }));
        expect(errors.at(-1)).toMatch(NOTHING_SENT);
        expect(onText).not.toHaveBeenCalled();
        expect(cloud.start).not.toHaveBeenCalled();
    });
});

describe(pickSpeechLocale, () => {
    it.each([
        ["de-DE", ["de-DE", "en-US"], "de-DE"],
        ["en-DE", ["de-DE", "en-GB", "en-US"], "en-GB"],
        ["zh-Hans-CN", ["zh_CN", "zh_TW"], "zh_CN"],
        ["fi-FI", ["de-DE"], "fi-FI"],
    ])("picks a recognizer locale for %s", (wanted, available, expected) => {
        expect(pickSpeechLocale(wanted, available)).toBe(expected);
    });
});

describe(createRecognizerLock, () => {
    it("holds the recognizer after a screen leaves until that recognition ends, so its end never closes the next press", async () => {
        const recognizer = fakeRecognizer(true);
        const lock = createRecognizerLock();
        const session = (errors: (string | undefined)[]) =>
            createOnDeviceSession({
                lang: "en-US",
                lock,
                now: () => 0,
                onError: (message) => {
                    errors.push(message);
                },
                onPhase: () => {},
                onText: () => {},
                platform: { OS: "ios", Version: "18.0" },
                recognizer,
            });
        const left = session([]);
        const nextErrors: (string | undefined)[] = [];
        const next = session(nextErrors);

        await left.start();
        left.detach();
        await next.start();

        expect(nextErrors.at(-1)).toBe(MIC_BUSY_MESSAGE);

        // The aborted recognition's end arrives: heard app-wide, it frees the recognizer and reaches no press.
        next.handle({ type: "end" });
        lock.ended();
        await next.finish();
        await next.start();

        expect(recognizer.start).toHaveBeenCalledTimes(2);
        expect(lock.isTaken()).toBe(true);
    });

    it("a release before the recognizer is running stops it once it runs, and an earlier recognition's end does not close it", async () => {
        const recognizer = fakeRecognizer(true);
        const lock = createRecognizerLock();
        const onText = vi.fn();
        let clock = 0;
        const session = createOnDeviceSession({
            lang: "en-US",
            lock,
            now: () => clock,
            onError: () => {},
            onPhase: () => {},
            onText,
            platform: { OS: "ios", Version: "18.0" },
            recognizer,
        });

        await session.start();
        clock = 2000;
        await session.finish();

        expect(recognizer.stop).not.toHaveBeenCalled();

        // The reset of the previous recognition ends it, before this one has started.
        session.handle({ type: "end" });
        session.handle({ type: "start" });

        expect(recognizer.stop).toHaveBeenCalledOnce();

        session.handle({ isFinal: true, transcript: "hello", type: "result" });
        session.handle({ type: "end" });

        expect(onText).toHaveBeenCalledWith("hello");
        expect(lock.isTaken()).toBe(false);
    });

    it("an end the press did not ask for cuts the recognizer off, so the microphone is never left on", async () => {
        const recognizer = fakeRecognizer(true);
        const errors: (string | undefined)[] = [];
        const session = createOnDeviceSession({
            lang: "en-US",
            lock: createRecognizerLock(),
            now: () => 0,
            onError: (message) => {
                errors.push(message);
            },
            onPhase: () => {},
            onText: () => {},
            platform: { OS: "ios", Version: "18.0" },
            recognizer,
        });

        await session.start();
        session.handle({ type: "start" });
        session.handle({ type: "end" });

        expect(recognizer.abort).toHaveBeenCalledOnce();
        expect(errors.at(-1)).toMatch(NOTHING_HEARD);
    });
});
