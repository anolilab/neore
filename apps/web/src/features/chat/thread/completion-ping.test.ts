import { afterEach, describe, expect, it, vi } from "vitest";

import playCompletionPing from "./completion-ping";

describe(playCompletionPing, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("stays silent when the browser refuses to create an audio context", () => {
        vi.stubGlobal(
            "AudioContext",
            vi.fn(() => {
                throw new DOMException("refused", "NotSupportedError");
            }),
        );

        expect(() => playCompletionPing()).not.toThrow();
    });

    it("releases the context when the sound graph cannot be built", () => {
        const context = {
            close: vi.fn(async () => {}),
            createOscillator: vi.fn(() => {
                throw new Error("no oscillator");
            }),
            currentTime: 0,
            destination: {},
            resume: vi.fn(async () => {}),
        };

        vi.stubGlobal(
            "AudioContext",
            // The ping calls it with `new`, which an arrow function cannot take.
            // eslint-disable-next-line func-names, prefer-arrow-callback
            vi.fn(function () {
                return context;
            }),
        );

        expect(() => playCompletionPing()).not.toThrow();
        expect(context.close).toHaveBeenCalledOnce();
    });
});
