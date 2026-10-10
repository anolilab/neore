import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUtteranceDetector } from "./utterance-detector";

describe(createUtteranceDetector, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("ends the utterance once the grace period after a commit passes quietly", () => {
        const onUtterance = vi.fn<(text: string) => void>();
        const detector = createUtteranceDetector({ graceMs: 1000, onUtterance });

        detector.partial("hello");
        detector.commit("hello there");
        vi.advanceTimersByTime(999);

        expect(onUtterance).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);

        expect(onUtterance).toHaveBeenCalledExactlyOnceWith("hello there");
    });

    it("holds the utterance open while the speaker keeps talking", () => {
        const onUtterance = vi.fn<(text: string) => void>();
        const detector = createUtteranceDetector({ graceMs: 1000, onUtterance });

        detector.commit("first part");
        vi.advanceTimersByTime(800);
        detector.partial("second");
        vi.advanceTimersByTime(5000);

        expect(onUtterance).not.toHaveBeenCalled();

        detector.commit("second part");
        vi.advanceTimersByTime(1000);

        expect(onUtterance).toHaveBeenCalledExactlyOnceWith("first part second part");
    });

    it("reports the live transcript", () => {
        const onTranscript = vi.fn<(text: string) => void>();
        const detector = createUtteranceDetector({ onTranscript, onUtterance: vi.fn() });

        detector.partial("hel");
        detector.commit("hello");
        detector.partial("wor");

        expect(onTranscript.mock.calls.map(([text]) => text)).toStrictEqual(["hel", "hello", "hello wor"]);
    });

    it("never fires an empty utterance", () => {
        const onUtterance = vi.fn<(text: string) => void>();
        const detector = createUtteranceDetector({ graceMs: 100, onUtterance });

        detector.commit(" ".repeat(3));
        vi.advanceTimersByTime(1000);
        detector.flush();

        expect(onUtterance).not.toHaveBeenCalled();
    });

    it("flush ends it at once with the partial text included, and only once", () => {
        const onUtterance = vi.fn<(text: string) => void>();
        const detector = createUtteranceDetector({ graceMs: 1000, onUtterance });

        detector.commit("one");
        detector.partial("two");
        detector.flush();
        detector.flush();
        vi.advanceTimersByTime(5000);

        expect(onUtterance).toHaveBeenCalledExactlyOnceWith("one two");
    });

    it("fires nothing after dispose", () => {
        const onUtterance = vi.fn<(text: string) => void>();
        const detector = createUtteranceDetector({ graceMs: 100, onUtterance });

        detector.commit("hello");
        detector.dispose();
        vi.advanceTimersByTime(1000);
        detector.commit("more");
        detector.flush();

        expect(onUtterance).not.toHaveBeenCalled();
    });
});
