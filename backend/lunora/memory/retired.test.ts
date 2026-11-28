/**
 * Retired memories in Memory settings: the list shows only the caller's own retired rows, newest retirement first, a page
 * at a time, with the replacing row's text; "Bring back" makes one current again and schedules its re-embed.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../_generated/dataModel";
import { memoryLogger } from "../lib/logger";
import schema from "../schema";
import { getThreadMemoriesForCompression } from "./compress";
import { saveMemoryBatch } from "./functions";
import { applyReflectionOps, loadReflectionInputs } from "./reflection";
import { planReflection, type ReflectionMemory, RESTORED_PROTECTION_MS, splitExpired } from "./reflection-logic";
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
type RetiredPage = {
    continueCursor: string | null;
    isDone: boolean;
    page: { _id: string; memory: string; replacesCurrent: boolean; retiredReason?: string; successor?: string }[];
};
type Reason = "brought_back_over" | "compressed" | "contradicted" | "decayed" | "duplicate" | "expired" | "merged" | "revised";

const run = <T>(body: (ctx: Ctx) => Promise<T>): Promise<T> => harness.run(body);
const as = (userId: string) => harness.withIdentity({ userId } as never);
const rowOf = async (id: Id<"memories">) => await run(async (ctx) => await ctx.db.get("memories", id));
const reembedJobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("regenerateMemoryEmbedding") === true);

const active = async (memory: string, userId = OWNER, pinned?: boolean): Promise<Id<"memories">> =>
    await run(async (ctx) => await ctx.db.insert("memories", { memory, pinned, type: "preference", updatedAt: 1, userId }));

/** Whether a nightly reflection planned over the scope as it is read now would change `id`, as a merge's survivor too. */
const reflectionTouches = async (id: Id<"memories">, now: number): Promise<boolean> => {
    const { memories } = (await run(async (ctx) => await ctx.runQuery(loadReflectionInputs as never, { now, userId: OWNER } as never))) as {
        memories: ReflectionMemory[];
    };
    const { expire, live } = splitExpired(memories, "2026-11-28");
    const plan = planReflection(live, now);

    return [
        ...expire,
        ...plan.retire,
        ...plan.decay.map((entry) => entry.memoryId),
        ...plan.merges.flatMap((merge) => [merge.survivorId, ...merge.absorbedIds]),
        ...plan.promotions.flatMap((promotion) => promotion.sourceIds),
        ...plan.contradictions.flatMap((pair) => [pair.olderId, pair.newerId]),
    ].includes(id);
};

/** A row retired at `retiredAt`, by `by` (itself when omitted). */
const retired = async (
    memory: string,
    retiredAt: number,
    options: { by?: Id<"memories">; confidence?: number; reason?: Reason; userId?: string; validUntil?: string } = {},
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
    it("swaps a revised memory back: the newer version is retired in the same write, and reflection leaves the pair alone", async () => {
        const next = await active("prefers spaces for indentation in code");
        const old = await retired("prefers tabs for indentation in code", 2000, { by: next, confidence: 20, reason: "revised" });

        const offered = await list();

        expect(offered.page[0]).toMatchObject({ replacesCurrent: true, successor: "prefers spaces for indentation in code" });

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: old } as never);

        const row = await rowOf(old);
        const successor = await rowOf(next);

        expect(row?.supersededBy).toBeUndefined();
        expect(row?.retiredAt).toBeUndefined();
        expect(row?.retiredReason).toBeUndefined();
        expect(row?.restoredAt).toBeTypeOf("number");
        expect(row?.confidence).toBe(BROUGHT_BACK_CONFIDENCE);
        expect(row?.lastConfirmedAt).toBeGreaterThan(2000);
        expect(successor).toMatchObject({ retiredReason: "brought_back_over", supersededBy: old });
        expect(reembedJobs().map((job) => job.args)).toStrictEqual([{ memoryId: old, userId: OWNER }]);

        const { page } = await list();

        // The newer version can be brought back in turn, swapping the two again.
        expect(page).toMatchObject([
            { _id: next, replacesCurrent: true, retiredReason: "brought_back_over", successor: "prefers tabs for indentation in code" },
        ]);
        expect(await reflectionTouches(old, Date.now())).toBe(false);
    });

    it("keeps a pinned newer version active, and does not offer to replace it", async () => {
        const next = await active("prefers spaces for indentation in code", OWNER, true);
        const old = await retired("prefers tabs for indentation in code", 2000, { by: next, reason: "contradicted" });

        const offered = await list();

        expect(offered.page[0]?.replacesCurrent).toBe(false);

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: old } as never);

        const successor = await rowOf(next);

        expect(successor?.supersededBy).toBeUndefined();
        expect(await reflectionTouches(old, Date.now())).toBe(false);
    });

    it("protects a compressed memory it brings back: the merged row stays, and reflection leaves the restored one alone for 30 days", async () => {
        const merged = await active("likes hot drinks, tea and coffee");
        const old = await retired("likes hot drinks, tea and coffee every day", 2000, { reason: "compressed" });

        const offered = await list();

        expect(offered.page[0]?.replacesCurrent).toBe(false);

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: old } as never);

        const kept = await rowOf(merged);
        const restored = await rowOf(old);
        const restoredAt = typeof restored?.restoredAt === "number" ? restored.restoredAt : 0;

        expect(kept?.supersededBy).toBeUndefined();
        // A near-duplicate of the merged row: without the protection the next reflection would merge one into the other.
        expect(await reflectionTouches(old, restoredAt + RESTORED_PROTECTION_MS - 1)).toBe(false);
        expect(await reflectionTouches(old, restoredAt + RESTORED_PROTECTION_MS)).toBe(true);
    });

    it("keeps a restored memory out of the next compression of its chat, and out of one planned before it came back", async () => {
        const threadId = await run(async (ctx) => await ctx.db.insert("threads", { userId: OWNER } as never));
        const old = await retired("likes tea", 2000, { reason: "compressed" });

        await run(async (ctx) => {
            await ctx.db.patch("memories", old, { source: "auto", threadId });
        });
        await as(OWNER).mutation(bringBackMemory as never, { memoryId: old } as never);

        const rows = (await run(async (ctx) => await ctx.runQuery(getThreadMemoriesForCompression as never, { threadId, userId: OWNER } as never))) as {
            _id: string;
            pinned?: boolean;
        }[];

        expect(rows).toStrictEqual([]);

        // A compression that read the row before it came back saves its summary, but does not retire the row.
        await run(
            async (ctx) =>
                await ctx.runMutation(
                    saveMemoryBatch as never,
                    { compressedFrom: [old], memories: [{ memory: "likes hot drinks", type: "preference", userId: OWNER }] } as never,
                ),
        );

        const kept = await rowOf(old);

        expect(kept?.supersededBy).toBeUndefined();
    });

    it("leaves a brought-back row alone when a reflection planned before the bring-back applies", async () => {
        const old = await retired("runs on Mondays", 2000, { confidence: 30, reason: "decayed" });
        const other = await active("runs on Mondays and Fridays");

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: old } as never);

        const before = await rowOf(old);

        // Ops planned while the row still read as it did: a decay, a merge into another row, and a retirement.
        await run(
            async (ctx) =>
                await ctx.runMutation(
                    applyReflectionOps as never,
                    {
                        ops: [
                            { confidence: 10, kind: "patch", memoryId: old },
                            { byMemoryId: other, kind: "supersede", memoryId: old, merge: true },
                            { byMemoryId: old, kind: "supersede", memoryId: old },
                            { confidence: 90, kind: "patch", lastConfirmedAt: 1, memory: "runs twice a week", memoryId: old, readText: "runs on Mondays" },
                        ],
                        userId: OWNER,
                    } as never,
                ),
        );

        const after = await rowOf(old);

        expect(after).toStrictEqual(before);
    });

    it("keeps a merged memory and the row it was merged into as they are at the next reflection", async () => {
        const survivor = await active("lives in Porto");
        const old = await retired("lives in porto city", 2000, { by: survivor, reason: "merged" });

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: old } as never);

        const kept = await rowOf(survivor);

        expect(kept?.supersededBy).toBeUndefined();
        expect(await reflectionTouches(old, Date.now())).toBe(false);
        expect(await reflectionTouches(survivor, Date.now())).toBe(false);
    });

    it("swaps back and forth: exactly one version is current after each bring-back", async () => {
        const first = await active("prefers tabs");
        const second = await active("prefers spaces");

        await run(async (ctx) => {
            await ctx.db.patch("memories", first, { retiredAt: 1000, retiredReason: "revised", supersededBy: second });
        });

        const current = async (): Promise<string[]> => {
            const rows = await Promise.all([first, second].map(async (id) => await rowOf(id)));

            return rows.filter((row) => row?.supersededBy === undefined).map((row) => String(row?.memory));
        };

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: first } as never);

        expect(await current()).toStrictEqual(["prefers tabs"]);

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: second } as never);

        expect(await current()).toStrictEqual(["prefers spaces"]);

        const back = await rowOf(first);

        expect(back).toMatchObject({ retiredReason: "brought_back_over", supersededBy: second });
    });

    it("follows the chain to the current version: A, revised to B, then to C, shows C, and bringing A back retires C", async () => {
        const c = await active("lives in Lisbon");
        const b = await retired("lives in Porto", 2000, { by: c, reason: "revised" });
        const a = await retired("lives in Braga", 1000, { by: b, reason: "revised" });

        const { page } = await list();
        const [forB, forA] = page;

        expect(forA).toMatchObject({ _id: a, replacesCurrent: true, successor: "lives in Lisbon" });
        expect(forB).toMatchObject({ _id: b, replacesCurrent: true, successor: "lives in Lisbon" });

        await as(OWNER).mutation(bringBackMemory as never, { memoryId: a } as never);

        const [rowC, rowB] = await Promise.all([rowOf(c), rowOf(b)]);

        expect(rowC).toMatchObject({ retiredReason: "brought_back_over", supersededBy: a });
        expect(rowB?.supersededBy).toBe(c);
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
