/**
 * Retired memories in Memory settings: the list shows only the caller's own retired rows, newest retirement first, a page
 * at a time, with the replacing row's text; "Bring back" makes one current again and schedules its re-embed.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../_generated/dataModel";
import { memoryLogger } from "../lib/logger";
import schema from "../schema";
import { applyReflectionOps } from "./reflection";
import { bringBackMemory, BROUGHT_BACK_CONFIDENCE, listRetiredMemories } from "./retired";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
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

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

const OWNER = "owner-user";
const OTHER = "other-user";

let harness: ReturnType<typeof lunoraTest>;

type Ctx = Parameters<Parameters<ReturnType<typeof lunoraTest>["run"]>[0]>[0];
type RetiredPage = { continueCursor: string | null; isDone: boolean; page: { _id: string; memory: string; retiredReason?: string; successor?: string }[] };

const run = <T>(body: (ctx: Ctx) => Promise<T>): Promise<T> => harness.run(body);
const as = (userId: string) => harness.withIdentity({ userId } as never);
const rowOf = async (id: Id<"memories">) => await run(async (ctx) => await ctx.db.get("memories", id));
const reembedJobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("regenerateMemoryEmbedding") === true);

const active = async (memory: string, userId = OWNER): Promise<Id<"memories">> =>
    await run(async (ctx) => await ctx.db.insert("memories", { memory, type: "preference", updatedAt: 1, userId }));

/** A row retired at `retiredAt`, by `by` (itself when omitted). */
const retired = async (
    memory: string,
    retiredAt: number,
    options: { by?: Id<"memories">; confidence?: number; reason?: "decayed" | "expired" | "revised"; userId?: string; validUntil?: string } = {},
): Promise<Id<"memories">> =>
    await run(async (ctx) => {
        const id = await ctx.db.insert("memories", {
            confidence: options.confidence,
            memory,
            retiredAt,
            retiredReason: options.reason,
            type: "preference",
            updatedAt: retiredAt,
            userId: options.userId ?? OWNER,
            validUntil: options.validUntil,
        });

        await ctx.db.patch("memories", id, { supersededBy: options.by ?? id });

        return id;
    });

const list = async (userId = OWNER, cursor: string | null = null, numberItems = 25): Promise<RetiredPage> =>
    (await as(userId).query(listRetiredMemories as never, { paginationOpts: { cursor, numItems: numberItems } } as never)) as RetiredPage;

beforeEach(() => {
    harness = lunoraTest(schema as never);
    vi.spyOn(memoryLogger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
});

describe("listRetiredMemories", () => {
    it("lists only the caller's retired rows, newest retirement first, past the first page", async () => {
        for (let index = 0; index < 30; index += 1) {
            await retired(`old fact ${String(index)}`, 1000 + index);
            await active(`current fact ${String(index)}`);
        }

        await retired("someone else's fact", 5000, { userId: OTHER });

        const first = await list(OWNER, null, 20);

        expect(first.page.map((row) => row.memory)).toStrictEqual(Array.from({ length: 20 }, (_, index) => `old fact ${String(29 - index)}`));
        expect(first.isDone).toBe(false);

        const second = await list(OWNER, first.continueCursor, 20);

        expect(second.page.map((row) => row.memory)).toStrictEqual(Array.from({ length: 10 }, (_, index) => `old fact ${String(9 - index)}`));
        expect(second.isDone).toBe(true);
        const { page: theirs } = await list(OTHER);

        expect(theirs.map((row) => row.memory)).toStrictEqual(["someone else's fact"]);
    });

    it("gives the reason and the replacing row's text, and no reason for a row retired before reasons were kept", async () => {
        const next = await active("likes green tea");

        await retired("likes tea", 2000, { by: next, reason: "revised" });
        await retired("has a cold", 1000);

        const { page } = await list();
        const [revised, legacy] = page;

        expect(revised).toMatchObject({ memory: "likes tea", retiredReason: "revised", successor: "likes green tea" });
        expect(legacy?.memory).toBe("has a cold");
        expect(legacy?.retiredReason).toBeUndefined();
        expect(legacy?.successor).toBeUndefined();
    });
});

describe("bringBackMemory", () => {
    it("makes a retired row current, confirmed now, and schedules its re-embed; the replacing row stays", async () => {
        const next = await active("likes green tea");
        const old = await retired("likes tea", 2000, { by: next, confidence: 20, reason: "decayed" });

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: old } as never);

        const row = await rowOf(old);

        expect(row?.supersededBy).toBeUndefined();
        expect(row?.retiredAt).toBeUndefined();
        expect(row?.retiredReason).toBeUndefined();
        expect(row?.confidence).toBe(BROUGHT_BACK_CONFIDENCE);
        expect(row?.lastConfirmedAt).toBeGreaterThan(2000);
        const successor = await rowOf(next);

        expect(successor?.supersededBy).toBeUndefined();
        expect(reembedJobs().map((job) => job.args)).toStrictEqual([{ memoryId: old, userId: OWNER }]);
        const { page } = await list();

        expect(page).toHaveLength(0);
    });

    it("drops a past end date, so the next reflection does not expire it again", async () => {
        const old = await retired("in Lisbon this week", 2000, { reason: "expired", validUntil: "2020-01-01" });

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: old } as never);

        const broughtBack = await rowOf(old);

        expect(broughtBack?.validUntil).toBeUndefined();

        await run(
            async (ctx) =>
                await ctx.runMutation(
                    applyReflectionOps as never,
                    { ops: [{ byMemoryId: old, expiredOn: "2026-11-28", kind: "supersede", memoryId: old }], userId: OWNER } as never,
                ),
        );

        const afterReflection = await rowOf(old);

        expect(afterReflection?.supersededBy).toBeUndefined();
    });

    it("refuses another user's row, a deleted id and an active row", async () => {
        const theirs = await retired("their fact", 2000, { userId: OTHER });
        const gone = await retired("deleted fact", 2000);
        const current = await active("current fact");

        await run(async (ctx) => {
            await ctx.db.delete("memories", gone);
        });

        // Row-level security hides another user's row, so it reads as not there at all.
        await expect(as(OWNER).mutation(bringBackMemory as never, { memoryId: theirs } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(as(OWNER).mutation(bringBackMemory as never, { memoryId: gone } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(as(OWNER).mutation(bringBackMemory as never, { memoryId: current } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        const untouched = await rowOf(theirs);

        expect(untouched?.supersededBy).toBe(theirs);
        expect(reembedJobs()).toHaveLength(0);
    });
});
