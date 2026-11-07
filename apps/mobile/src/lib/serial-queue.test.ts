import { describe, expect, it } from "vitest";

import { createSerialQueue } from "./serial-queue";

describe("createSerialQueue", () => {
    it("starts each task only after the one before it has finished", async () => {
        const enqueue = createSerialQueue();
        const order: string[] = [];

        const slow = enqueue(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 10);
            });
            order.push("first");
        });
        const fast = enqueue(async () => {
            order.push("second");
        });

        await Promise.all([slow, fast]);

        expect(order).toEqual(["first", "second"]);
    });

    it("keeps running after a task rejects, and hands the rejection to its caller", async () => {
        const enqueue = createSerialQueue();

        const failed = enqueue(() => Promise.reject(new Error("storage is unavailable")));
        const next = enqueue(async () => "still runs");

        await expect(failed).rejects.toThrow("storage is unavailable");
        await expect(next).resolves.toBe("still runs");
    });
});
