/**
 * Refunding a round (`account.ts`): one unit back to each named limit, and only while the window the charge came from is still current,
 * since the limiter's refund names no window and would otherwise credit a later one.
 */
import { describe, expect, it, vi } from "vitest";

const { refunded } = vi.hoisted(() => {
    return { refunded: [] as string[] };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        createRatelimit: (key: string) => {
            return {
                getRemaining: async () => {
                    return { remaining: 5, reset: key.startsWith("chat/") ? 5000 : 7000 };
                },
                refund: async () => {
                    refunded.push(key);
                },
            };
        },
    };
});

const { refundRoundKeys, roundWindowEnds } = await import("./account");

const KEYS = ["chat/dailyText:free", "tasks/dailyRuns:free"];
const CTX = { db: {} } as never;

describe("refundRoundKeys", () => {
    it("refunds a limit whose charged window is still current", async () => {
        refunded.length = 0;
        await refundRoundKeys(CTX, "u", KEYS, [9000, 9000], 1000);

        expect(refunded).toEqual(KEYS);
    });

    it("does not credit a window that ended after the charge, for the limits whose window ended only", async () => {
        refunded.length = 0;
        // After a rollover the first limit's window is gone (ended at 500), the second's is still current: only it is refunded.
        await refundRoundKeys(CTX, "u", KEYS, [500, 9000], 1000);

        expect(refunded).toEqual(["tasks/dailyRuns:free"]);
    });

    it("refunds as before when the window ends are not known", async () => {
        refunded.length = 0;
        await refundRoundKeys(CTX, "u", KEYS);

        expect(refunded).toEqual(KEYS);
    });
});

describe("roundWindowEnds", () => {
    it("reads the end of each limit's current window, in the order of the keys", async () => {
        expect(await roundWindowEnds(CTX, "u", KEYS)).toEqual([5000, 7000]);
    });
});
