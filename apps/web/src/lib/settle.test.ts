import { describe, expect, it, vi } from "vitest";

import settle from "./settle";

describe(settle, () => {
    it("returns the task's result and settles after it", async () => {
        const order: string[] = [];

        const result = await settle(
            async () => {
                order.push("task");

                return 42;
            },
            () => {
                order.push("settled");
            },
        );

        expect(result).toBe(42);
        expect(order).toStrictEqual(["task", "settled"]);
    });

    it("settles and rethrows when the task fails", async () => {
        const onSettled = vi.fn();

        await expect(
            settle(async () => {
                throw new Error("failed");
            }, onSettled),
        ).rejects.toThrow("failed");
        expect(onSettled).toHaveBeenCalledOnce();
    });
});
