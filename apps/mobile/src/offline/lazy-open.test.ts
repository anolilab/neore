import { describe, expect, it } from "vitest";

import { createLazyOpen } from "./lazy-open";

describe("createLazyOpen", () => {
    it("opens once and shares the connection", async () => {
        let opens = 0;
        const get = createLazyOpen(async () => {
            opens += 1;

            return { id: opens };
        });

        expect(await get()).toBe(await get());
        expect(opens).toBe(1);
    });

    it("tries again after a failed open instead of keeping the rejection", async () => {
        let opens = 0;
        const get = createLazyOpen(async () => {
            opens += 1;

            if (opens === 1) {
                throw new Error("disk busy");
            }

            return { id: opens };
        });

        await expect(get()).rejects.toThrow("disk busy");
        expect(await get()).toEqual({ id: 2 });
        expect(opens).toBe(2);
    });
});
