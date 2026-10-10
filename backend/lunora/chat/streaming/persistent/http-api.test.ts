import { describe, expect, it, vi } from "vitest";

import type { ChunkRead } from "./http-api";
import { CHUNKS_MAX_READS, CHUNKS_MAX_WAIT_MS, CHUNKS_WAIT_TICK_MS, readChunksWhenReady, toChunkWaitMs } from "./http-api";

const empty = (status: ChunkRead["status"] = "pending"): ChunkRead => {
    return { chunks: [], status, totalChunks: 0 };
};

/** A fake clock the fake `sleep` advances, so waits are counted, not slept. */
const fakeClock = () => {
    let time = 0;

    return {
        now: () => time,
        sleep: vi.fn(async (ms: number) => {
            time += ms;
        }),
    };
};

describe(readChunksWhenReady, () => {
    it("reads once and answers at once without a wait", async () => {
        const clock = fakeClock();
        const read = vi.fn(async () => empty());

        await expect(readChunksWhenReady(read, 0, clock)).resolves.toStrictEqual(empty());
        expect(read).toHaveBeenCalledTimes(1);
        expect(clock.sleep).not.toHaveBeenCalled();
    });

    it("holds until a chunk arrives, re-reading every tick", async () => {
        const clock = fakeClock();
        const withChunk: ChunkRead = { chunks: [{ text: "Hi" }], status: "streaming", totalChunks: 1 };
        const read = vi.fn(async () => (read.mock.calls.length < 4 ? empty() : withChunk));

        await expect(readChunksWhenReady(read, 5000, clock)).resolves.toBe(withChunk);
        expect(read).toHaveBeenCalledTimes(4);
        expect(clock.now()).toBe(3 * CHUNKS_WAIT_TICK_MS);
    });

    it("answers a finished stream at once, even with no new chunk", async () => {
        const clock = fakeClock();
        const read = vi.fn(async () => empty("done"));

        await expect(readChunksWhenReady(read, 5000, clock)).resolves.toStrictEqual(empty("done"));
        expect(read).toHaveBeenCalledTimes(1);
    });

    it("gives up after the wait with the last read", async () => {
        const clock = fakeClock();
        const read = vi.fn(async () => empty());

        await expect(readChunksWhenReady(read, 1000, clock)).resolves.toStrictEqual(empty());
        expect(clock.now()).toBeLessThanOrEqual(1000);
        // A read at 0, then one per tick up to the deadline.
        expect(read).toHaveBeenCalledTimes(1000 / CHUNKS_WAIT_TICK_MS + 1);
    });
});

describe(toChunkWaitMs, () => {
    it("clamps to the endpoint's limit and treats anything unusable as no wait", () => {
        expect(toChunkWaitMs(1000)).toBe(1000);
        expect(toChunkWaitMs(60_000)).toBe(CHUNKS_MAX_WAIT_MS);
        expect(toChunkWaitMs(undefined)).toBe(0);
        expect(toChunkWaitMs(-5)).toBe(0);
        expect(toChunkWaitMs("1000")).toBe(0);
        expect(toChunkWaitMs(NaN)).toBe(0);
    });
});

describe("the read budget of one /chat/chunks invocation", () => {
    // Each read is a Worker -> Durable Object subrequest; Workers cap those per
    // invocation at 50 on the Free plan. One more goes to the shard lookup.
    const FREE_PLAN_SUBREQUESTS = 50;

    it("never reads more than CHUNKS_MAX_READS times, whatever wait is asked for", async () => {
        const clock = fakeClock();
        const read = vi.fn(async () => empty());

        await readChunksWhenReady(read, Number.MAX_SAFE_INTEGER, clock);

        expect(read).toHaveBeenCalledTimes(CHUNKS_MAX_READS);
    });

    it("reads at most CHUNKS_MAX_READS times for the longest wait the endpoint accepts", async () => {
        const clock = fakeClock();
        const read = vi.fn(async () => empty());

        await readChunksWhenReady(read, toChunkWaitMs(60_000), clock);

        expect(read).toHaveBeenCalledTimes(CHUNKS_MAX_READS);
        expect(clock.now()).toBe(CHUNKS_MAX_WAIT_MS);
    });

    it("stays well under the Free plan's subrequest cap", () => {
        expect(CHUNKS_MAX_READS + 1).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS / 2);
    });
});
