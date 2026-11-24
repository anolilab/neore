import { describe, expect, it, vi } from "vitest";

import { HAND_OVER_RECORD_TRIES, handOverGuestMerge } from "./guest-merge-hand-over";

describe("handOverGuestMerge", () => {
    it("writes the record, then queues the job", async () => {
        const order: string[] = [];

        await handOverGuestMerge(
            async () => {
                order.push("record");
            },
            async () => {
                order.push("queue");
            },
        );

        expect(order).toStrictEqual(["record", "queue"]);
    });

    it("tries the record again once, and goes on when that try works", async () => {
        const record = vi.fn().mockRejectedValueOnce(new Error("shard unavailable")).mockResolvedValueOnce(null);
        const queue = vi.fn(async () => {});

        await handOverGuestMerge(record, queue);

        expect(record).toHaveBeenCalledTimes(2);
        expect(queue).toHaveBeenCalledOnce();
    });

    it("still queues the job when the record cannot be written, then fails the hand-over so its caller keeps it", async () => {
        const failure = new Error("shard unavailable");
        const record = vi.fn(async () => {
            throw failure;
        });
        const queue = vi.fn(async () => {});

        await expect(handOverGuestMerge(record, queue)).rejects.toBe(failure);
        expect(record).toHaveBeenCalledTimes(HAND_OVER_RECORD_TRIES);
        expect(queue).toHaveBeenCalledOnce();
    });

    it("fails when the job cannot be queued, whatever the record did", async () => {
        await expect(
            handOverGuestMerge(
                async () => {},
                async () => {
                    throw new Error("queue unavailable");
                },
            ),
        ).rejects.toThrow("queue unavailable");
    });
});
