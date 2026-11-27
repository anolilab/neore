import { describe, expect, it, vi } from "vitest";

import { withCatch, withFinally } from "./guarded";

describe(withFinally, () => {
    it("settles after a task that succeeds and passes its result through", async () => {
        const onSettled = vi.fn();

        await expect(withFinally(async () => 7, onSettled)).resolves.toBe(7);
        expect(onSettled).toHaveBeenCalledOnce();
    });

    it("settles after a task that fails and passes its failure through", async () => {
        const onSettled = vi.fn();
        const failure = new Error("boom");

        await expect(withFinally(async () => {
            throw failure;
        }, onSettled)).rejects.toBe(failure);
        expect(onSettled).toHaveBeenCalledOnce();
    });

    it("settles only once the task has ended", async () => {
        const order: string[] = [];

        await withFinally(
            async () => {
                await Promise.resolve();
                order.push("task");
            },
            () => {
                order.push("settled");
            },
        );

        expect(order).toStrictEqual(["task", "settled"]);
    });
});

describe(withCatch, () => {
    it("returns the task's result when it succeeds", async () => {
        const onError = vi.fn();

        await expect(withCatch(async () => "rows", onError)).resolves.toBe("rows");
        expect(onError).not.toHaveBeenCalled();
    });

    it("hands a failure to onError and returns its result instead", async () => {
        const failure = new Error("offline");

        const failing = async () => {
            throw failure;
        };
        const fallback = (error: unknown) => {
            if (error === failure) {
                return "fallback";
            }

            return "other";
        };

        await expect(withCatch(failing, fallback)).resolves.toBe("fallback");
    });
});
