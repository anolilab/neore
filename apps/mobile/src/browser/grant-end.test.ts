import { describe, expect, it, vi } from "vitest";

import { watchGrantEnd } from "./grant-end";

const setup = (endsAt: number) => {
    const scheduled: { ms: number; run: () => void }[] = [];
    const cancel = vi.fn();
    const onEnd = vi.fn();
    const reread = vi.fn();
    const stop = watchGrantEnd({
        after: (ms, run) => {
            scheduled.push({ ms, run });

            return cancel;
        },
        endsAt,
        now: () => 1000,
        onEnd,
        reread,
    });

    return { cancel, onEnd, reread, scheduled, stop };
};

describe(watchGrantEnd, () => {
    it("hides the page at the grant's end, then reads the status once to learn of a renewal", () => {
        const { onEnd, reread, scheduled } = setup(61_000);

        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]?.ms).toBe(60_000);
        expect(onEnd).not.toHaveBeenCalled();

        scheduled[0]?.run();

        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(reread).toHaveBeenCalledTimes(1);
        expect(onEnd.mock.invocationCallOrder[0]).toBeLessThan(reread.mock.invocationCallOrder[0] ?? 0);
    });

    it("ends at once for a grant whose end has already passed", () => {
        const { scheduled } = setup(500);

        expect(scheduled[0]?.ms).toBe(0);
    });

    it("cancels the wait when the screen stops watching this answer", () => {
        const { cancel, stop } = setup(61_000);

        stop();

        expect(cancel).toHaveBeenCalledTimes(1);
    });
});
