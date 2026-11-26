import { describe, expect, it, vi } from "vitest";

import { FRAME_MIN_GAP_MS, FRAME_REFRESH_MS, startFrameReader } from "./frame-reader";

const setup = () => {
    const clock = { at: 100_000 };
    const ticks: (() => void)[] = [];
    const waits: { ms: number; run: () => void }[] = [];
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
            waits.push({ ms, run });

            return () => {};
        },
        every: (ms, run) => {
            expect(ms).toBe(FRAME_REFRESH_MS);
            ticks.push(run);

            return cancel;
        },
        now: () => clock.at,
        onAnswer,
        onFailure,
        read,
    });

    return { cancel, clock, onAnswer, onFailure, pending, read, reader, tick: () => ticks.at(-1)?.(), waits };
};

describe(startFrameReader, () => {
    it("reads at once, then on every interval, and stops the timer when stopped", async () => {
        const { cancel, onAnswer, pending, read, reader, tick } = setup();

        expect(read).toHaveBeenCalledTimes(1);
        pending[0]?.resolve("first");
        await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith("first"));

        tick();
        expect(read).toHaveBeenCalledTimes(2);

        reader.stop();
        expect(cancel).toHaveBeenCalled();
    });

    it("never replaces a read still out: a read slower than the interval still paints, and the next starts after it", async () => {
        const { onAnswer, pending, read, tick } = setup();

        tick();
        expect(read).toHaveBeenCalledTimes(1);

        pending[0]?.resolve("slow");
        await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith("slow"));

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
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        // The read out was not thrown away for the newer one.
        expect(onAnswer).toHaveBeenCalledWith("first");
    });

    it("waits out the gap for a request made just after a read, then reads", async () => {
        const { clock, pending, read, reader, waits } = setup();

        pending[0]?.resolve("first");
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        await Promise.resolve();

        clock.at += 1000;
        reader.request();
        expect(read).toHaveBeenCalledTimes(1);
        expect(waits[0]?.ms).toBe(FRAME_MIN_GAP_MS - 1000);

        waits[0]?.run();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it("drops a read that answers or fails after the reader stopped, and hands a failure to its handler otherwise", async () => {
        const first = setup();

        first.reader.stop();
        first.pending[0]?.reject(new Error("late"));
        await Promise.resolve();
        expect(first.onAnswer).not.toHaveBeenCalled();
        expect(first.onFailure).not.toHaveBeenCalled();

        const second = setup();
        const error = new TypeError("Network request failed");

        second.pending[0]?.reject(error);
        await vi.waitFor(() => expect(second.onFailure).toHaveBeenCalledWith(error));
    });
});
