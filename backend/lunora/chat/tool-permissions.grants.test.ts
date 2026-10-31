/**
 * Time-boxed allows against the real schema: what an answer stores, what the
 * settings page lists, that revoking works and that the sweep drops lapsed ones.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { MAX_TOOL_GRANTS } from "./lib/tool-permission-grants";
import {
    consumeLowRiskCheck,
    getLowRiskApprovalContext,
    getToolPermissionSettings,
    pruneExpiredToolPermissionGrants,
    recordApprovalPreference,
    revokeToolPermissionGrant,
    setAutoApproveLowRisk,
    setToolPermission,
} from "./tool-permissions";

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

    it("ends a running time-boxed allow when the user picks Always", async () => {
        await record("hour", KEY);
        await record("always", KEY);

        const row = await stored();

        expect(row?.toolPermissions).toStrictEqual({ [KEY]: "auto" });
        expect(row?.toolPermissionGrants).toStrictEqual({});
    });

    it("stores nothing for a plain approval or a denial", async () => {
        await record("approve", KEY);
        await record("deny", KEY);

        expect(await stored()).toBeNull();
    });

    it("refuses a time-boxed allow for a snapshot without a key, rather than approving once in silence", async () => {
        await expect(record("hour", undefined)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(record("today", undefined)).rejects.toMatchObject({ code: "BAD_REQUEST" });

        expect(await stored()).toBeNull();
    });

    it("makes room at the cap by dropping the allow that ends soonest, instead of failing the approval", async () => {
        const full = Object.fromEntries(Array.from({ length: MAX_TOOL_GRANTS }, (_, index) => [`mcp:S${index}:t`, NOW + 60_000 + index]));

        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { toolPermissionGrants: full, userId: USER }));
        await record("hour", KEY);

        const grants = await grantsOf();

        expect(Object.keys(grants ?? {})).toHaveLength(MAX_TOOL_GRANTS);
        expect(grants?.[KEY]).toBe(NOW + 3_600_000);
        expect(grants?.["mcp:S0:t"]).toBeUndefined();
        expect(grants?.["mcp:S1:t"]).toBe(NOW + 60_001);
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

describe("setToolPermission", () => {
    it("ends the tool's time-boxed allow, so picking Ask in settings asks again", async () => {
        const later = Date.now() + 3_600_000;

        await harness.run(
            async (ctx: any) => await ctx.db.insert("aiUserPreferences", { toolPermissionGrants: { [KEY]: later, "mcp:Other:t": later }, userId: USER }),
        );
        await as().mutation(setToolPermission as never, { key: KEY, mode: "ask" } as never);

        const row = await stored();

        expect(row?.toolPermissionGrants).toStrictEqual({ "mcp:Other:t": later });
        expect(row?.toolPermissions).toStrictEqual({ [KEY]: "ask" });
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

describe("the quick check setting", () => {
    it("is off until the user turns it on, and off again when they turn it off", async () => {
        const read = async (): Promise<boolean> => {
            const settings: any = await as().query(getToolPermissionSettings as never, {} as never);

            return settings.autoApproveLowRisk;
        };

        expect(await read()).toBe(false);

        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);
        expect(await read()).toBe(true);

        await as().mutation(setAutoApproveLowRisk as never, { enabled: false } as never);
        expect(await read()).toBe(false);
    });

    it("does not touch the tool permissions or time-boxed allows", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { toolPermissions: { [KEY]: "ask" }, userId: USER }));
        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);

        const row = await stored();

        expect(row?.toolPermissions).toStrictEqual({ [KEY]: "ask" });
    });
});

describe("getLowRiskApprovalContext", () => {
    const THREAD_ARGS = async (extra: Record<string, unknown> = {}) =>
        await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "t", userId: USER, ...extra }));
    const ask = async (threadId: unknown): Promise<boolean> =>
        await harness.run(async (ctx: any) => await ctx.runQuery(getLowRiskApprovalContext, { threadId, userId: USER }));

    it("is false while the setting is off, even for the user's own thread", async () => {
        expect(await ask(await THREAD_ARGS())).toBe(false);
    });

    it("is true for the user's own thread once it is on", async () => {
        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);

        expect(await ask(await THREAD_ARGS())).toBe(true);
    });

    it("stays false in a thread someone else can write to or read publicly", async () => {
        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);

        expect(await ask(await THREAD_ARGS({ isPublic: true }))).toBe(false);
        expect(await ask(await THREAD_ARGS({ deleted: true }))).toBe(false);
        expect(await ask(await THREAD_ARGS({ userId: "someone-else" }))).toBe(false);
    });

    it("is false once a context summary of the thread folded in untrusted content", async () => {
        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);

        const threadId = await THREAD_ARGS();
        const summary = async (taintedBy: string[]) =>
            await harness.run(async (ctx: any) => {
                const message = await ctx.db.insert("messages", {
                    message: { content: "hi", role: "user" },
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    userId: USER,
                });

                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 1,
                    coveredUpToMessageId: message,
                    createdAt: 1,
                    summary: "s",
                    taintedBy,
                    threadId,
                    userId: USER,
                });
            });

        await summary([]);
        expect(await ask(threadId)).toBe(true);

        await summary(["web"]);
        expect(await ask(threadId)).toBe(false);
    });
});

describe("consumeLowRiskCheck", () => {
    const THREAD = async (extra: Record<string, unknown> = {}) =>
        await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "t", userId: USER, ...extra }));
    const consume = async (threadId: unknown): Promise<boolean> =>
        await harness.run(async (ctx: any) => await ctx.runMutation(consumeLowRiskCheck, { threadId, userId: USER }));

    it("spends one unit while the setting is on and the thread is the user's alone", async () => {
        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);

        expect(await consume(await THREAD())).toBe(true);
    });

    it("takes effect on the next call when the setting is switched off mid-run, and spends nothing", async () => {
        const threadId = await THREAD();

        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);
        expect(await consume(threadId)).toBe(true);

        await as().mutation(setAutoApproveLowRisk as never, { enabled: false } as never);

        // Far more refusals than the bucket holds: a refusal that spent a unit would empty it.
        for (let call = 0; call < 40; call += 1) {
            expect(await consume(threadId)).toBe(false);
        }

        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);
        expect(await consume(threadId)).toBe(true);
    });

    it("takes effect on the next call when the thread is shared mid-run", async () => {
        const threadId = await THREAD();

        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);
        expect(await consume(threadId)).toBe(true);

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadAccess", {
                    grantedAt: NOW,
                    grantedBy: USER,
                    ownerId: USER,
                    permission: "write",
                    threadId,
                    userId: "collaborator",
                } as never),
        );

        expect(await consume(threadId)).toBe(false);
    });

    it("answers false once the user's budget is spent", async () => {
        await as().mutation(setAutoApproveLowRisk as never, { enabled: true } as never);

        const threadId = await THREAD();
        const answers: boolean[] = [];

        for (let call = 0; call < 40; call += 1) {
            answers.push(await consume(threadId));
        }

        expect(answers.filter(Boolean).length).toBeGreaterThan(0);
        expect(answers.at(-1)).toBe(false);
    });
});
