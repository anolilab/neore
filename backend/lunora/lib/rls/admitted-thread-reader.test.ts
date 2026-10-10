/**
 * `readerForAdmittedThread` reads past row-level security, so it enforces its
 * own limits: an admitted thread, a thread-scoped table, reads only, and every
 * read keyed on that thread. Each way out of those limits throws; the keyed
 * read works and costs only its page, as the guarded legacy read does since
 * `@lunora/server@alpha.145` (anolilab/lunora#822: before it, that read scanned
 * the whole index range).
 */
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureDb } from "../../../test/db-cost";
import schema from "../../schema";
import { query } from "../crpc";
import { admitThread, readerForAdmittedThread } from "./scope";

const OWNER = "user-owner";
const ROWS = 40;
const PAGE = 5;
const NOT_ADMITTED = /not admitted/u;
const NOT_KEYED = /must begin with|needs where\.threadId/u;
const NOT_THREAD_TABLE = /not a thread-scoped table/u;
const NOT_THREAD_INDEX = /not a threadId-first index/u;

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

/** A guarded procedure (the bare builder keys RLS on `ctx.auth.userId`), with `threadId` admitted when asked. */
const probe = query
    .input({ admit: v.boolean(), case: v.string(), otherThreadId: v.string(), threadId: v.string() })
    .output(v.any())
    .query(async ({ args, ctx }) => {
        if (args.admit) {
            admitThread(ctx, args.threadId, "read");
        }

        const reader = () => readerForAdmittedThread(ctx, args.threadId);
        const byThread = (q: any) => q.eq("threadId", args.threadId);
        const cases: Record<string, () => Promise<unknown>> = {
            "guarded-legacy": async () => {
                const rows = await ctx.db.query("messages").withIndex("by_threadId_order_stepOrder", byThread).take(PAGE);

                return rows.length;
            },
            "keyed-legacy": async () => {
                const rows = await reader().query("messages").withIndex("by_threadId_order_stepOrder", byThread).take(PAGE);

                return rows.length;
            },
            "keyed-orm": async () => {
                const result = await reader()
                    .table("messages")
                    .findMany({ limit: PAGE, where: { threadId: args.threadId as never } });

                return result.page.length;
            },
            "non-thread-index": async () =>
                await reader()
                    .query("messages")
                    .withIndex("embeddingId_threadId" as never, byThread)
                    .take(PAGE),
            "orm-write": async () => await (reader().table("messages") as any).insert({}),
            "other-table": async () => await (reader() as any).query("memories").withIndex("threadId", byThread).take(PAGE),
            "other-thread-legacy": async () =>
                await reader()
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", args.otherThreadId))
                    .take(PAGE),
            "other-thread-orm": async () =>
                await reader()
                    .table("messages")
                    .findMany({ where: { threadId: args.otherThreadId as never } }),
            "unkeyed-orm": async () => await reader().table("messages").findMany({ limit: PAGE }),
            "unkeyed-range": async () =>
                await reader()
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q)
                    .take(PAGE),
            write: async () => await (reader() as any).insert("messages", {}),
        };
        const run = cases[args.case];

        if (!run) {
            throw new Error(`unknown case ${args.case}`);
        }

        return await run();
    });

const call = async (caseName: string, options: { admit?: boolean; otherThreadId?: string; threadId: string }) =>
    await harness
        .withIdentity({ userId: OWNER } as never)
        .query(
            probe as never,
            { admit: options.admit ?? true, case: caseName, otherThreadId: options.otherThreadId ?? "", threadId: options.threadId } as never,
        );

const seed = async () =>
    await harness.run(async (context: any) => {
        const threadId = await context.db.insert("threads", { status: "active", title: "t", userId: OWNER });
        const otherThreadId = await context.db.insert("threads", { status: "active", title: "other", userId: OWNER });

        for (let order = 0; order < ROWS; order += 1) {
            await context.db.insert("messages", { order, status: "success", stepOrder: 0, threadId, tool: false, userId: OWNER });
        }

        return { otherThreadId: otherThreadId as string, threadId: threadId as string };
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("readerForAdmittedThread", () => {
    it("reads an admitted thread's page keyed on it, and only the page", async () => {
        const { threadId } = await seed();

        const keyed = await measureDb(async () => await call("keyed-legacy", { threadId }));
        const guarded = await measureDb(async () => await call("guarded-legacy", { threadId }));

        expect(keyed.result).toBe(PAGE);
        expect(guarded.result).toBe(PAGE);
        // Both read their page, not the thread's ROWS. The guarded one pins the
        // upstream fix for anolilab/lunora#822 (it read all of them before).
        expect(keyed.cost.rowsRead).toBeLessThanOrEqual(PAGE + 1);
        expect(guarded.cost.rowsRead).toBeLessThanOrEqual(PAGE + 1);

        expect(await call("keyed-orm", { threadId })).toBe(PAGE);
    });

    it("refuses a thread the request did not admit", async () => {
        const { threadId } = await seed();

        await expect(call("keyed-legacy", { admit: false, threadId })).rejects.toThrow(NOT_ADMITTED);
    });

    it("refuses any read not keyed on the admitted thread", async () => {
        const { otherThreadId, threadId } = await seed();

        await expect(call("other-thread-legacy", { otherThreadId, threadId })).rejects.toThrow(NOT_KEYED);
        await expect(call("other-thread-orm", { otherThreadId, threadId })).rejects.toThrow(NOT_KEYED);
        await expect(call("unkeyed-range", { threadId })).rejects.toThrow(NOT_KEYED);
        await expect(call("unkeyed-orm", { threadId })).rejects.toThrow(NOT_KEYED);
        await expect(call("non-thread-index", { threadId })).rejects.toThrow(NOT_THREAD_INDEX);
    });

    it("refuses other tables and every write", async () => {
        const { threadId } = await seed();

        await expect(call("other-table", { threadId })).rejects.toThrow(NOT_THREAD_TABLE);
        await expect(call("write", { threadId })).rejects.toThrow();
        await expect(call("orm-write", { threadId })).rejects.toThrow();
    });
});
