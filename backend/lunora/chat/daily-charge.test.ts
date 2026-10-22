/**
 * `chargeDailyUnit` charges background work (a group turn's extra replies, a
 * messenger transcription) to the same daily keys the HTTP routes use, at the
 * user's tier.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimKey } from "../lib/claim-once";
import { createRatelimit } from "../lib/rate-limiter";
import schema from "../schema";
import { chargeDailyUnit, DAILY_CHARGE_SCOPE } from "./daily-charge";

const { orgs, users } = vi.hoisted(() => {
    return {
        orgs: new Map<string, { baseTier?: string; members: string[] }>(),
        users: new Map<string, { isAnonymous?: boolean; plan?: string; role?: string }>(),
    };
});

// `user`, `member` and `organization` are `.global()` (D1) tables the harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getMembersByUserId: async (_ctx: unknown, userId: string) =>
            [...orgs.entries()]
                .filter(([, org]) => org.members.includes(userId))
                .map(([organizationId]) => {
                    return { organizationId, userId };
                }),
        getOrganization: async (_ctx: unknown, organizationId: string) =>
            orgs.has(organizationId) ? { _id: organizationId, ...orgs.get(organizationId) } : null,
        getUser: async (_ctx: unknown, userId: string) => (users.has(userId) ? { _id: userId, ...users.get(userId) } : null),
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const charge = async (args: { count?: number; kind: "Audio" | "Text"; organizationId?: string; requestId?: string; userId: string }): Promise<boolean> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(chargeDailyUnit, args));

const remaining = async (key: string, userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { remaining: left } = await createRatelimit(key, ctx.db as never).getRemaining(userId);

        return left;
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    users.clear();
    orgs.clear();
});

describe("chargeDailyUnit", () => {
    it("charges a free user's daily text quota by one", async () => {
        users.set("u1", {});

        const before = await remaining("chat/dailyText:free", "u1");

        await expect(charge({ kind: "Text", userId: "u1" })).resolves.toBe(true);
        expect(await remaining("chat/dailyText:free", "u1")).toBe(before - 1);
    });

    it("takes a multi-unit charge all or nothing: one that does not fit consumes none", async () => {
        users.set("u1", {});

        const before = await remaining("chat/dailyText:free", "u1");

        await expect(charge({ count: before + 1, kind: "Text", userId: "u1" })).resolves.toBe(false);
        expect(await remaining("chat/dailyText:free", "u1")).toBe(before);

        await expect(charge({ count: before, kind: "Text", userId: "u1" })).resolves.toBe(true);
        expect(await remaining("chat/dailyText:free", "u1")).toBe(0);
    });

    it("charges the premium key inside a paid organization the user belongs to, and not one they left", async () => {
        users.set("u1", {});
        orgs.set("paid", { baseTier: "pro", members: ["u1"] });
        orgs.set("left", { baseTier: "pro", members: [] });

        const premium = await remaining("chat/dailyAudio:premium", "u1");
        const free = await remaining("chat/dailyAudio:free", "u1");

        await charge({ kind: "Audio", organizationId: "paid", userId: "u1" });
        await charge({ kind: "Audio", organizationId: "left", userId: "u1" });

        expect(await remaining("chat/dailyAudio:premium", "u1")).toBe(premium - 1);
        expect(await remaining("chat/dailyAudio:free", "u1")).toBe(free - 1);
    });

    it("refuses a user who no longer exists, and exempts an admin", async () => {
        users.set("admin", { role: "admin" });

        await expect(charge({ kind: "Text", userId: "gone" })).resolves.toBe(false);
        await expect(charge({ kind: "Text", userId: "admin" })).resolves.toBe(true);
    });

    it("takes one unit per request: a retry of the same request is not charged again, and a new request is", async () => {
        users.set("u1", {});

        const before = await remaining("chat/dailyText:free", "u1");

        await expect(charge({ kind: "Text", requestId: "run-1:node-1", userId: "u1" })).resolves.toBe(true);
        await expect(charge({ kind: "Text", requestId: "run-1:node-1", userId: "u1" })).resolves.toBe(true);
        expect(await remaining("chat/dailyText:free", "u1")).toBe(before - 1);

        await expect(charge({ kind: "Text", requestId: "run-2:node-1", userId: "u1" })).resolves.toBe(true);
        expect(await remaining("chat/dailyText:free", "u1")).toBe(before - 2);
    });

    it("releases a refused request's claim, so its retry is refused again rather than passing for free", async () => {
        users.set("u1", {});

        // Spend the free text quota with unkeyed charges until the limiter refuses one.
        let spent = false;

        for (let attempt = 0; attempt < 500 && !spent; attempt += 1) {
            spent = !(await charge({ kind: "Text", userId: "u1" }));
        }

        expect(spent).toBe(true);
        await expect(charge({ kind: "Text", requestId: "run-3:node-1", userId: "u1" })).resolves.toBe(false);

        // Nothing holds the refused request's key: a later attempt of it is not a replay of a taken unit.
        const claimedBefore = await harness.run(
            async (ctx: any) => await ctx.runMutation(claimKey, { key: "run-3:node-1", scope: DAILY_CHARGE_SCOPE, ttlMs: 60_000 }),
        );

        expect(claimedBefore).toBe(true);
    });
});
