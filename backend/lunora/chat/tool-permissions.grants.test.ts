/**
 * Time-boxed allows against the real schema: what an answer stores, what the
 * settings page lists, that revoking works and that the sweep drops lapsed ones.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getToolPermissionSettings, pruneExpiredToolPermissionGrants, recordApprovalPreference, revokeToolPermissionGrant } from "./tool-permissions";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: null,
                      email: `${context.auth.userId}@example.com`,
                      id: context.auth.userId,
                      isAdmin: false,
                      name: context.auth.userId,
                      userId: context.auth.userId,
                  }
                : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const USER = "grant-user";
const KEY = "mcp:Files:delete";
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

let harness: ReturnType<typeof lunoraTest>;

const as = () => harness.withIdentity({ userId: USER } as never);

const record = async (decision: "always" | "approve" | "deny" | "hour" | "today", key: string | undefined, now = NOW): Promise<void> =>
    await harness.run(async (ctx: any) => await recordApprovalPreference({ db: ctx.db, now, user: { userId: USER } } as never, decision, key));

const grantsOf = async (): Promise<Record<string, number> | undefined> => {
    const row = await stored();

    return row?.toolPermissionGrants;
};

const stored = async (): Promise<{ toolPermissionGrants?: Record<string, number>; toolPermissions?: Record<string, string> } | null> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("aiUserPreferences")
                .withIndex("by_userId", (q: any) => q.eq("userId", USER))
                .unique(),
    );

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("recordApprovalPreference", () => {
    it("stores an hour grant without touching the override", async () => {
        await record("hour", KEY);

        const row = await stored();

        expect(row?.toolPermissionGrants).toStrictEqual({ [KEY]: NOW + 3_600_000 });
        expect(row?.toolPermissions).toBeUndefined();
    });

    it("ends a 'today' grant at the user's local midnight", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { timezone: "America/New_York", userId: USER }));
        await record("today", KEY);

        expect(await grantsOf()).toStrictEqual({ [KEY]: Date.UTC(2026, 9, 31, 4, 0) });
    });

    it("stores nothing for a plain approval, a denial or a snapshot without a key", async () => {
        await record("approve", KEY);
        await record("deny", KEY);
        await record("hour", undefined);

        expect(await stored()).toBeNull();
    });

    it("refuses a device tool, shell_run and the question tool", async () => {
        for (const key of ["device:dev-1:shell_run", "device:dev-1:fs_write", "device:dev-1:fs_read", "builtin:askUser"]) {
            await expect(record("hour", key)).rejects.toMatchObject({ code: "BAD_REQUEST" });
            await expect(record("today", key)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        }

        expect(await stored()).toBeNull();
    });

    it("prunes lapsed entries when it writes a new one", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { toolPermissionGrants: { "mcp:Old:t": NOW - 1 }, userId: USER }));
        await record("hour", KEY);

        expect(await grantsOf()).toStrictEqual({ [KEY]: NOW + 3_600_000 });
    });
});

describe("getToolPermissionSettings", () => {
    it("lists the grants still in force, with their expiry", async () => {
        const expiresAt = Date.now() + 3_600_000;

        await harness.run(
            async (ctx: any) => await ctx.db.insert("aiUserPreferences", { toolPermissionGrants: { [KEY]: expiresAt, "mcp:Old:t": 1 }, userId: USER }),
        );

        const settings: any = await as().query(getToolPermissionSettings as never, {} as never);

        expect(settings.grants).toEqual({ [KEY]: expiresAt });
    });
});

describe("revokeToolPermissionGrant", () => {
    it("ends one grant early and leaves the others", async () => {
        const later = Date.now() + 3_600_000;

        await harness.run(
            async (ctx: any) => await ctx.db.insert("aiUserPreferences", { toolPermissionGrants: { [KEY]: later, "mcp:Other:t": later }, userId: USER }),
        );
        await as().mutation(revokeToolPermissionGrant as never, { key: KEY } as never);

        expect(await grantsOf()).toStrictEqual({ "mcp:Other:t": later });
    });
});

describe("pruneExpiredToolPermissionGrants", () => {
    it("drops lapsed grants and keeps the ones in force", async () => {
        const later = Date.now() + 3_600_000;

        await harness.run(
            async (ctx: any) => await ctx.db.insert("aiUserPreferences", { toolPermissionGrants: { [KEY]: later, "mcp:Old:t": 1 }, userId: USER }),
        );
        await harness.run(async (ctx: any) => await ctx.runMutation(pruneExpiredToolPermissionGrants, {}));

        expect(await grantsOf()).toStrictEqual({ [KEY]: later });
    });
});
