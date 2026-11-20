/**
 * A send refused after its quota unit was taken (the file window closed before its save) gives the unit back: the daily window
 * is charged once for the send that succeeds, not for the refused attempt as well. The unit goes back only to the window it was
 * taken from, and only while that window is still current.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { createRatelimit } from "../lib/rate-limiter";
import { applyRateLimit } from "../lib/rate-limiter-mutations";
import { chargeDailyLimitOnce, refundDailyCharge } from "./daily-charge";

const KEY = "chat/dailyText:free";
const USER = "refund-user";
const FREE_TEXT_DAILY = 20;
const DAY_ONE = new Date("2026-11-20T12:00:00Z");
const DAY_TWO = new Date("2026-11-21T12:00:00Z");

let harness: ReturnType<typeof lunoraTest>;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const remaining = async (): Promise<number> => {
    const { remaining: left } = await run(async (ctx) => await createRatelimit(KEY, ctx.db as never).getRemaining(USER));

    return left;
};

/** Charges one unkeyed unit and returns the window it was taken from. */
const chargeUnkeyed = async (): Promise<number> => {
    const { windowStart } = (await run(async (ctx) => await ctx.runMutation(applyRateLimit as never, { count: 1, identifier: USER, key: KEY }))) as {
        windowStart: number;
    };

    return windowStart;
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("refunding a refused send's quota unit", () => {
    it("gives an unkeyed charge's unit back to its daily window", async () => {
        const windowStart = await chargeUnkeyed();

        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);

        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, { count: 1, identifier: USER, key: KEY, windowStart }));
        expect(await remaining()).toBe(FREE_TEXT_DAILY);
    });

    it("never raises the window above its rate", async () => {
        const windowStart = await chargeUnkeyed();
        const refund = { count: 1, identifier: USER, key: KEY, windowStart };

        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, refund));
        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, refund));

        expect(await remaining()).toBe(FREE_TEXT_DAILY);
    });

    it("gives nothing back without the window the unit was taken from", async () => {
        await chargeUnkeyed();

        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, { count: 1, identifier: USER, key: KEY }));
        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);
    });

    it("frees a keyed charge's claim, so the send's retry is charged again rather than found already charged", async () => {
        const charge = { chargeKey: "send-1", count: 1, identifier: USER, key: KEY };

        const { windowStart } = (await run(async (ctx) => await ctx.runMutation(chargeDailyLimitOnce as never, charge))) as { windowStart: number };

        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);

        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, { ...charge, windowStart }));
        expect(await remaining()).toBe(FREE_TEXT_DAILY);

        await run(async (ctx) => await ctx.runMutation(chargeDailyLimitOnce as never, charge));
        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);
    });

    it("does not credit a unit to a window that started after the charge (the window rolled over)", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        vi.setSystemTime(DAY_ONE);
        const dayOneWindow = await chargeUnkeyed();

        vi.setSystemTime(DAY_TWO);
        const dayTwoWindow = await chargeUnkeyed();

        expect(dayTwoWindow).not.toBe(dayOneWindow);
        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);

        // The refund for the day-one charge arrives in day two: the new window's own charge must stay charged.
        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, { count: 1, identifier: USER, key: KEY, windowStart: dayOneWindow }));
        expect(await remaining()).toBe(FREE_TEXT_DAILY - 1);

        // The same refund against the window it was taken from does give the unit back.
        await run(async (ctx) => await ctx.runMutation(refundDailyCharge as never, { count: 1, identifier: USER, key: KEY, windowStart: dayTwoWindow }));
        expect(await remaining()).toBe(FREE_TEXT_DAILY);
    });
});
