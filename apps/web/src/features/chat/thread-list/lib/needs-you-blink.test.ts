import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimBlinkWindow, NEEDS_YOU_BLINK_MS, releaseBlinkWindow, resetBlinkWindows } from "./needs-you-blink";

describe("needs-you blink window", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetBlinkWindows();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("grants the full window on first sight and counts down from it", () => {
        expect(claimBlinkWindow("t1", "approval", Date.now())).toBe(NEEDS_YOU_BLINK_MS);
        vi.advanceTimersByTime(2000);
        expect(claimBlinkWindow("t1", "approval", Date.now())).toBe(NEEDS_YOU_BLINK_MS - 2000);
    });

    it("does not restart when the row remounts after the window", () => {
        claimBlinkWindow("t1", "question", Date.now());
        vi.advanceTimersByTime(NEEDS_YOU_BLINK_MS + 1);
        expect(claimBlinkWindow("t1", "question", Date.now())).toBe(0);
    });

    it("tracks each thread and state on its own", () => {
        claimBlinkWindow("t1", "approval", Date.now());
        vi.advanceTimersByTime(NEEDS_YOU_BLINK_MS);
        expect(claimBlinkWindow("t2", "approval", Date.now())).toBe(NEEDS_YOU_BLINK_MS);
        expect(claimBlinkWindow("t1", "question", Date.now())).toBe(NEEDS_YOU_BLINK_MS);
    });

    it("blinks again after the state went away and came back", () => {
        claimBlinkWindow("t1", "approval", Date.now());
        vi.advanceTimersByTime(NEEDS_YOU_BLINK_MS + 1);
        releaseBlinkWindow("t1");
        expect(claimBlinkWindow("t1", "approval", Date.now())).toBe(NEEDS_YOU_BLINK_MS);
    });

    it("stays bounded by dropping the oldest sightings", () => {
        claimBlinkWindow("first", "approval", Date.now());
        vi.advanceTimersByTime(NEEDS_YOU_BLINK_MS + 1);

        for (let index = 0; index < 200; index += 1) {
            claimBlinkWindow(`t${index}`, "approval", Date.now());
        }

        expect(claimBlinkWindow("first", "approval", Date.now())).toBe(NEEDS_YOU_BLINK_MS);
    });
});
