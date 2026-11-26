import { describe, expect, it, vi } from "vitest";

import { watchGrantEnd } from "./grant-end";

const setup = (endsAt: number, rereadAt?: number) => {
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
        ...rereadAt !== undefined && { rereadAt },
    });

    return { cancel, onEnd, reread, scheduled, stop };
};

describe(watchGrantEnd, () => {
    it("hides the page at the grant's end, then reads the status once to learn of a renewal", () => {
        const { onEnd, reread, scheduled } = setup(61_000);

        expect(scheduled.map((wait) => wait.ms)).toStrictEqual([60_000, 60_000]);
        scheduled[0]?.run();
        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(reread).not.toHaveBeenCalled();

        scheduled[1]?.run();
        expect(reread).toHaveBeenCalledTimes(1);
    });

    it("hides the page early but reads again only at the real end, so a read never answers the grant again", () => {
        const { scheduled } = setup(59_000, 61_000);

        expect(scheduled.map((wait) => wait.ms)).toStrictEqual([58_000, 60_000]);
    });

    it("ends at once for a grant whose end has already passed", () => {
        const { scheduled } = setup(500);

        expect(scheduled[0]?.ms).toBe(0);
    });

    it("cancels both waits when the screen stops watching this answer", () => {
        const { cancel, stop } = setup(61_000);

        stop();

        expect(cancel).toHaveBeenCalledTimes(2);
    });
});
