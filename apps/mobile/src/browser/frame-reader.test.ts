import { describe, expect, it, vi } from "vitest";

import { FRAME_MIN_GAP_MS, FRAME_REFRESH_MS, startFrameReader } from "./frame-reader";

const setup = (start = 100_000) => {
    const clock = { at: start };
    const ticks: (() => void)[] = [];
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
    const last = { at: -Infinity };
    const startReader = () =>
        startFrameReader({
            every: (ms, run) => {
                expect(ms).toBe(FRAME_REFRESH_MS);
                ticks.push(run);

                return cancel;
            },
            lastReadAt: last.at,
            now: () => clock.at,
            onAnswer,
            onFailure,
            onRead: (at) => {
                last.at = at;
            },
            read,
        });

    return { cancel, clock, last, onAnswer, onFailure, pending, read, start: startReader, tick: () => ticks.at(-1)?.() };
};

describe(startFrameReader, () => {
    it("reads at once, then on every interval, and stops the timer when stopped", async () => {
        const { cancel, onAnswer, pending, read, start, tick } = setup();
        const stop = start();

        expect(read).toHaveBeenCalledTimes(1);
        pending[0]?.resolve("first");
        await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith("first"));

        tick();
        expect(read).toHaveBeenCalledTimes(2);

        stop();
        expect(cancel).toHaveBeenCalled();
    });

    it("paints only the newest read: an older one that answers late is dropped", async () => {
        const { onAnswer, pending, start, tick } = setup();

        start();
        tick();
        pending[1]?.resolve("newer");
        pending[0]?.resolve("older");

        await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith("newer"));
        expect(onAnswer).not.toHaveBeenCalledWith("older");
    });

    it("drops a read that answers or fails after the reader stopped", async () => {
        const { onAnswer, onFailure, pending, start } = setup();
        const stop = start();

        stop();
        pending[0]?.reject(new Error("late"));
        await Promise.resolve();

        expect(onAnswer).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it("hands a failed read to its handler", async () => {
        const { onFailure, pending, start } = setup();
        const error = new TypeError("Network request failed");

        start();
        pending[0]?.reject(error);

        await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(error));
    });

    it("skips the first read of a reader started a moment after the last read (an agent action), but keeps the timer", () => {
        const { clock, read, start, tick } = setup();

        start()();
        clock.at += FRAME_MIN_GAP_MS - 1;
        start();
        expect(read).toHaveBeenCalledTimes(1);

        tick();
        expect(read).toHaveBeenCalledTimes(2);

        clock.at += FRAME_MIN_GAP_MS;
        start();
        expect(read).toHaveBeenCalledTimes(3);
    });
});
