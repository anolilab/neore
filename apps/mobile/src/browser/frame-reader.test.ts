import { describe, expect, it, vi } from "vitest";

import { drainMicrotasks } from "@/lib/drain-microtasks";

import { FRAME_MIN_GAP_MS, FRAME_REFRESH_MS, startFrameReader } from "./frame-reader";

const setup = (lastRead?: { at: number }) => {
    const clock = { at: 100_000 };
    const ticks: (() => void)[] = [];
    const waits: { cancel: ReturnType<typeof vi.fn>; ms: number; run: () => void }[] = [];
    const cancel = vi.fn();
    const pending: { reject: (error: unknown) => void; resolve: (value: string) => void }[] = [];
    const read = vi.fn(
        async () =>
            await new Promise<string>((resolve, reject) => {
                pending.push({ reject, resolve });
            }),
    );
    const onAnswer = vi.fn();
    const onFailure = vi.fn();
    const reader = startFrameReader({
        after: (ms, run) => {
            const wait = { cancel: vi.fn(), ms, run };

            waits.push(wait);

            return wait.cancel;
        },
        every: (ms, run) => {
            expect(ms).toBe(FRAME_REFRESH_MS);
            ticks.push(run);

            return cancel;
        },
        lastRead,
        now: () => clock.at,
        onAnswer,
        onFailure,
        read,
    });

    return { cancel, clock, onAnswer, onFailure, pending, read, reader, tick: () => ticks.at(-1)?.(), waits };
};

describe(startFrameReader, () => {
    it("reads at once, then on every interval, and stops the timer when stopped", async () => {
        const { cancel, clock, onAnswer, pending, read, reader, tick } = setup();

        expect(read).toHaveBeenCalledTimes(1);
        pending[0]?.resolve("first");
        await drainMicrotasks();
        expect(onAnswer).toHaveBeenCalledWith("first");

        clock.at += FRAME_REFRESH_MS;
        tick();
        expect(read).toHaveBeenCalledTimes(2);

        reader.stop();
        expect(cancel).toHaveBeenCalled();
    });

    it("never replaces a read still out: a read slower than the interval still paints, and the next starts after it", async () => {
        const { clock, onAnswer, pending, read, tick } = setup();

        clock.at += FRAME_REFRESH_MS;
        tick();
        expect(read).toHaveBeenCalledTimes(1);

        pending[0]?.resolve("slow");
        await drainMicrotasks();
        expect(onAnswer).toHaveBeenCalledWith("slow");

        clock.at += FRAME_REFRESH_MS;
        tick();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it("keeps an agent action's request made while a read is out, and reads once it answered", async () => {
        const { clock, onAnswer, pending, read, reader } = setup();

        reader.request();
        reader.request();
        expect(read).toHaveBeenCalledTimes(1);

        clock.at += FRAME_MIN_GAP_MS;
        pending[0]?.resolve("first");
        await drainMicrotasks();
        expect(read).toHaveBeenCalledTimes(2);
        // The read out was not thrown away for the newer one.
        expect(onAnswer).toHaveBeenCalledWith("first");
    });

    it("waits out the gap for a request made just after a read, then reads", async () => {
        const { clock, pending, read, reader, waits } = setup();

        pending[0]?.resolve("first");
        await drainMicrotasks();

        clock.at += 1000;
        reader.request();
        expect(read).toHaveBeenCalledTimes(1);
        expect(waits[0]?.ms).toBe(FRAME_MIN_GAP_MS - 1000);

        clock.at += FRAME_MIN_GAP_MS - 1000;
        waits[0]?.run();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it("checks the gap again when its timer fires, and drops an armed timer once a read starts", async () => {
        const { clock, pending, read, reader, waits } = setup();

        pending[0]?.resolve("first");
        await drainMicrotasks();

        clock.at += 1000;
        reader.request();

        // A timer that fires early still finds the gap open: it waits again, and reads nothing yet.
        waits[0]?.run();
        expect(read).toHaveBeenCalledTimes(1);
        expect(waits[1]?.ms).toBe(FRAME_MIN_GAP_MS - 1000);

        // Past the gap, a request reads at once, and the timer still armed is dropped: it cannot start a second read.
        clock.at += FRAME_MIN_GAP_MS;
        reader.request();
        expect(read).toHaveBeenCalledTimes(2);
        expect(waits[1]?.cancel).toHaveBeenCalled();
    });

    it("drops a read that fails after the reader stopped, and hands a failure to its handler otherwise", async () => {
        const first = setup();

        first.reader.stop();
        first.pending[0]?.reject(new Error("late"));
        await drainMicrotasks();
        expect(first.onAnswer).not.toHaveBeenCalled();
        expect(first.onFailure).not.toHaveBeenCalled();

        const second = setup();
        const error = new TypeError("Network request failed");

        second.pending[0]?.reject(error);
        await drainMicrotasks();
        expect(second.onFailure).toHaveBeenCalledWith(error);
    });

    it("drops a read that answers after the reader stopped", async () => {
        const { onAnswer, pending, reader } = setup();

        reader.stop();
        pending[0]?.resolve("late");
        await drainMicrotasks();
        expect(onAnswer).not.toHaveBeenCalled();
    });

    it("holds the gap for the timer too: a tick just after a read waits", async () => {
        const { clock, pending, read, tick, waits } = setup();

        pending[0]?.resolve("first");
        await drainMicrotasks();

        clock.at += 1000;
        tick();
        expect(read).toHaveBeenCalledTimes(1);
        expect(waits.at(-1)?.ms).toBe(FRAME_MIN_GAP_MS - 1000);
    });

    it("holds the gap across readers: one started just after another's read waits it out, and shares its read time", () => {
        const lastRead = { at: 100_000 - 1000 };
        const { clock, read, waits } = setup(lastRead);

        // The screen came back to the front a second after the last reader read: no read yet.
        expect(read).not.toHaveBeenCalled();
        expect(waits[0]?.ms).toBe(FRAME_MIN_GAP_MS - 1000);

        clock.at += FRAME_MIN_GAP_MS - 1000;
        waits[0]?.run();
        expect(read).toHaveBeenCalledTimes(1);
        expect(lastRead.at).toBe(clock.at);
    });
});
