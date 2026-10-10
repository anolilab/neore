/**
 * `chargeDailyUnit` charges background work (a group turn's extra replies, a
 * messenger transcription) to the same daily keys the HTTP routes use, at the
 * user's tier.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRatelimit } from "../lib/rate-limiter";
import schema from "../schema";
import { chargeDailyUnit } from "./daily-charge";

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

const charge = async (args: { kind: "Audio" | "Text"; organizationId?: string; userId: string }): Promise<boolean> =>
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
});
