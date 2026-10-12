/**
 * `consumeRateLimit` is the one place the gateway spends a rate-limit budget.
 * It must refuse to guess: a limit with no binding returns `null` (the caller
 * answers 503), never an allowed request.
 */
import { describe, expect, it } from "vitest";

import { consumeRateLimit, RATE_LIMIT_VALUES, secondsUntilNextMinute } from "./native-rate-limit.js";

const binding = (isAllowed: boolean) => {
    return {
        limit: async () => {
            return { success: isAllowed };
        },
    };
};

describe("consumeRateLimit", () => {
    it("passes the key to the binding for the requested limit", async () => {
        const seen: string[] = [];
        const env = {
            RATE_LIMIT_20: {
                limit: async ({ key }: { key: string }) => {
                    seen.push(key);

                    return { success: true };
                },
            },
        };

        await expect(consumeRateLimit(env as never, 20, "chat:user-a")).resolves.toBe(true);
        expect(seen).toStrictEqual(["chat:user-a"]);
    });

    it("reports a refusal from the binding", async () => {
        await expect(consumeRateLimit({ RATE_LIMIT_5: binding(false) } as never, 5, "exp:user-a")).resolves.toBe(false);
    });

    it("fails closed when the limit has no binding in the env", async () => {
        await expect(consumeRateLimit({} as never, 20, "chat:user-a")).resolves.toBeNull();
    });

    it("fails closed for a limit the gateway does not declare", async () => {
        await expect(consumeRateLimit({ RATE_LIMIT_7: binding(true) } as never, 7, "chat:user-a")).resolves.toBeNull();
    });
});

describe("RATE_LIMIT_VALUES", () => {
    it("covers every limit the middleware computes from its tables", () => {
        // Chat: free 20, pro 120, enterprise 600, default 60.
        // Expensive: 5 / 30 / 120, and with tierMultiplier 0.5: 2 / 15 / 60.
        const computed = [20, 120, 600, 60, 5, 30, 2, 15];

        for (const limit of computed) {
            expect(RATE_LIMIT_VALUES).toContain(limit);
        }
    });
});

describe("secondsUntilNextMinute", () => {
    it("is always within one minute", () => {
        const seconds = secondsUntilNextMinute();

        expect(seconds).toBeGreaterThanOrEqual(1);
        expect(seconds).toBeLessThanOrEqual(60);
    });
});
