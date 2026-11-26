import { describe, expect, it, vi } from "vitest";

import { readUntilAnswered, REREAD_RETRIES, REREAD_RETRY_MS, watchGrantEnd } from "./grant-end";

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

describe(readUntilAnswered, () => {
    it("tries a failed read again a bounded number of times, and hands the answer with its read's start", async () => {
        const waits: { ms: number; run: () => void }[] = [];
        const clock = { at: 1000 };
        const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("server error")).mockResolvedValueOnce("renewed");
        const onAnswer = vi.fn();

        readUntilAnswered({
            after: (ms, run) => {
                waits.push({ ms, run });

                return () => {};
            },
            now: () => clock.at,
            onAnswer,
            read,
        });

        await vi.waitFor(() => expect(waits).toHaveLength(1));
        expect(waits[0]?.ms).toBe(REREAD_RETRY_MS);

        clock.at = 6000;
        waits[0]?.run();
        await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith("renewed", 6000));
    });

    it("gives up after its retries, and answers nothing once cancelled", async () => {
        const waits: (() => void)[] = [];
        const read = vi.fn(async () => {
            throw new Error("down");
        });
        const onAnswer = vi.fn();
        const stop = readUntilAnswered({
            after: (_ms, run) => {
                waits.push(run);

                return () => {};
            },
            onAnswer,
            read,
        });

        const retry = async (index: number): Promise<void> => {
            if (index >= REREAD_RETRIES) {
                return;
            }

            await vi.waitFor(() => expect(waits).toHaveLength(index + 1));
            waits[index]?.();
            await retry(index + 1);
        };

        await retry(0);

        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(REREAD_RETRIES + 1));
        expect(waits).toHaveLength(REREAD_RETRIES);

        stop();
        expect(onAnswer).not.toHaveBeenCalled();
    });
});
