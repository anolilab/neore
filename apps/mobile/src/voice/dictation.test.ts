import { describe, expect, it, vi } from "vitest";

import type { DictationEngine, DictationPath } from "./dictation";
import { createDictationRouter, SETTING_UNREADABLE_MESSAGE } from "./dictation";
import type { OnDeviceRecognizer } from "./on-device";
import { createOnDeviceSession, createRecognizerLock, ON_DEVICE_UNAVAILABLE_MESSAGE } from "./on-device";

const NOTHING_SENT = /Nothing was sent/u;

const fakeEngine = (): DictationEngine => {
    return { finish: vi.fn(async () => {}), start: vi.fn(async () => {}) };
};

const fakeRecognizer = (hasOnDevice: boolean): OnDeviceRecognizer => {
    return {
        abort: vi.fn(),
        getMicrophonePermissionsAsync: async () => {
            return { granted: true };
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

    it("records nothing when the setting cannot be read", async () => {
        const engines = { cloud: fakeEngine(), "on-device": fakeEngine() };
        const { errors, router } = routed(async () => {
            throw new Error("keychain locked");
        }, engines);

        await router.start();

        expect(errors.at(-1)).toBe(SETTING_UNREADABLE_MESSAGE);
        expect(engines.cloud.start).not.toHaveBeenCalled();
        expect(engines["on-device"].start).not.toHaveBeenCalled();
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
