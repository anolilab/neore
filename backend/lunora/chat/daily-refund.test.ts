/**
 * A send refused after its quota unit was taken (the file window closed before its save) gives the unit back: the daily window
 * is charged once for the send that succeeds, not for the refused attempt as well.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createRatelimit } from "../lib/rate-limiter";
import { applyRateLimit } from "../lib/rate-limiter-mutations";
import { chargeDailyLimitOnce, refundDailyCharge } from "./daily-charge";

const KEY = "chat/dailyText:free";
const USER = "refund-user";
const FREE_TEXT_DAILY = 20;

let harness: ReturnType<typeof lunoraTest>;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const remaining = async (): Promise<number> => {
    const { remaining: left } = await run(async (ctx) => await createRatelimit(KEY, ctx.db as never).getRemaining(USER));

    return left;
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

describe("refunding a refused send's quota unit", () => {
    it("gives an unkeyed charge's unit back to its daily window", async () => {
        await run(async (ctx) => await ctx.runMutation(applyRateLimit as never, { count: 1, identifier: USER, key: KEY }));
        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);

        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, { count: 1, identifier: USER, key: KEY }));
        expect(await remaining()).toBe(FREE_TEXT_DAILY);
    });

    it("never raises the window above its rate", async () => {
        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, { count: 1, identifier: USER, key: KEY }));

        expect(await remaining()).toBe(FREE_TEXT_DAILY);
    });

    it("frees a keyed charge's claim, so the send's retry is charged again rather than found already charged", async () => {
        const charge = { chargeKey: "send-1", count: 1, identifier: USER, key: KEY };

        await run(async (ctx) => await ctx.runMutation(chargeDailyLimitOnce as never, charge));
        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);

        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, { ...charge }));
        expect(await remaining()).toBe(FREE_TEXT_DAILY);

        await run(async (ctx) => await ctx.runMutation(chargeDailyLimitOnce as never, charge));
        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);
    });
});
