/**
 * A converting guest's rows move from the guest's shard to the new account's
 * (`account-merge.ts`). The unit harness is one database for every shard, so
 * the shards here are two in-memory maps behind a fake shard caller.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { deleteMergedGuest } from "../auth/hooks";
import { FOLLOW_MERGE_PAGE_SIZE } from "../chat/follows/follow-writes";
import { requireOwnCollectionId } from "../knowledge/documents-shared";
import type { MergeProgress, MergeReferences, ShardCall } from "./account-merge";
import {
    canonicalValue,
    deleteShardRows,
    dropImportMarkersPage,
    importShardRows,
    listShardRowsPage,
    listShardRowsToClear,
    MERGE_CALLS_PER_RUN,
    MERGE_PAGE_SIZE,
} from "./account-merge";
import {
    GLOBAL_USER_COLUMNS,
    GLOBAL_USER_TABLES_NOT_REASSIGNED,
    mergeGuestInto,
    reassignGlobalRows,
    reassignThreadFollowsPage,
    rewriteOwner,
    runGuestMerge,
    shardLocalTables,
} from "./account-merge";
import { schemaWithShardedTables } from "./test-schema";
import { listSharedPinRoutesForExport } from "../chat/pins/functions";

// The action's own query runs in the harness, which takes the registered procedure; every other reference stays plain.
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi } = await import("../../test/registered-api");

    return registeredApi(await importOriginal(), registry);
});

/** The shard the action reaches across to, and the jobs it queues: set per test. */
const transport: { call?: ShardCall; queued: { args: Record<string, unknown>; options: unknown; ref: { __lunoraRef: string } }[] } = { queued: [] };

vi.mock("./cross-shard", () => {
    return {
        callOnShard: async (reference: { __lunoraRef: string }, args: Record<string, unknown>, options: { shardKey: string }) =>
            await transport.call!(reference, args, options.shardKey),
    };
});

vi.mock("./job-queue", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./job-queue")>()),
        enqueueJob: async (ref: { __lunoraRef: string }, args: Record<string, unknown>, options: unknown) => {
            transport.queued.push({ args, options, ref });
        },
    };
});

const ref = (name: string) => {
    return { __lunoraRef: `lib_account_merge:${name}` };
};

const REFERENCES: MergeReferences = {
    deleteGuest: { __lunoraRef: "auth_hooks:deleteMergedGuest" },
    deleteRows: ref("deleteShardRows"),
    dropMarkers: ref("dropImportMarkersPage"),
    importRows: ref("importShardRows"),
    list: ref("listShardRowsPage"),
    listClear: ref("listShardRowsToClear"),
    reassignFollows: ref("reassignThreadFollowsPage"),
    reassignGlobal: ref("reassignGlobalRows"),
};

type Row = Record<string, unknown> & { _id: string };

/** Every run of a merge, as the queue would chain them: each from where the last stopped, until one says it is done. */
const mergeToEnd = async (
    call: ShardCall,
    from: string,
    to: string,
    options: { budget?: number; maxRuns?: number } = {},
): Promise<{ moved: number; runs: MergeProgress[] }> => {
    const runs: MergeProgress[] = [];
    let resume: MergeProgress | undefined;

    for (;;) {
        const { moved, next } = await mergeGuestInto(call, REFERENCES, from, to, { ...options, ...(resume !== undefined && { resume }) });

        if (next === null) {
            return { moved, runs };
        }

        runs.push(next);
        resume = next;
    }
};

/**
 * Two shards as `shardKey → table → rows`, and a caller that plays the procedures against them. `follows` is how many
 * follow rows the guest holds (`pageSize` move per call); `followsRemain` is what the guest deletion reports.
 */
const fakeShards = (
    seed: Record<string, Record<string, Row[]>>,
    pageSize = 2,
    { follows = 0, followsRemain = false }: { follows?: number; followsRemain?: boolean } = {},
) => {
    let followsLeft = follows;
    let followPageCalls = 0;
    const shards = new Map(Object.entries(seed).map(([key, tables]) => [key, new Map(Object.entries(tables).map(([table, rows]) => [table, [...rows]]))]));
    const reassigned: { from: string; to: string }[] = [];
    /** Each guest deletion, with how many rows the guest's shard still held at that moment. */
    const deletedGuests: { left: number; shardKey: string; userId: string }[] = [];
    const tableOf = (shardKey: string, table: string): Row[] => {
        const shard = shards.get(shardKey) ?? new Map<string, Row[]>();

        shards.set(shardKey, shard);

        if (!shard.has(table)) {
            shard.set(table, []);
        }

        return shard.get(table)!;
    };

    const call: ShardCall = async (reference, args, shardKey) => {
        const name = reference.__lunoraRef.split(":", 2)[1];
        const table = args.table as string;

        switch (name) {
            case "deleteMergedGuest": {
                if (followsRemain) {
                    return { deleted: false, followsRemain: true } as never;
                }

                const left = [...(shards.get(shardKey)?.values() ?? [])].reduce((count, rows) => count + rows.length, 0);

                deletedGuests.push({ left, shardKey, userId: args.userId as string });

                return { deleted: true } as never;
            }
            case "deleteShardRows": {
                const shard = shards.get(shardKey) ?? new Map<string, Row[]>();

                const ids = new Set((args.rows as { id: string }[]).map((row) => row.id));

                shard.set(
                    table,
                    (shard.get(table) ?? []).filter((row) => !ids.has(row._id)),
                );

                return null as never;
            }
            case "dropImportMarkersPage": {
                return { hasMore: false } as never;
            }
            case "importShardRows": {
                const target = tableOf(shardKey, table);

                for (const row of args.rows as Row[]) {
                    const reowned = rewriteOwner(row, args.from as string, args.to as string) as Row;
                    const at = target.findIndex((existing) => existing._id === row._id);

                    if (at === -1) {
                        target.push(reowned);
                    } else {
                        target[at] = reowned;
                    }
                }

                return { imported: 0, present: (args.rows as Row[]).map((row) => row._id) } as never;
            }
            case "listShardRowsPage": {
                const rows = tableOf(shardKey, table);
                const start = Number(args.cursor ?? 0);
                const page = rows.slice(start, start + pageSize);
                const next = start + pageSize;

                return { continueCursor: next < rows.length ? String(next) : null, isDone: next >= rows.length, page } as never;
            }
            case "listShardRowsToClear": {
                const rows = tableOf(shardKey, table).slice(0, pageSize);

                return { digests: rows.map(() => ""), rows } as never;
            }
            case "reassignGlobalRows": {
                reassigned.push({ from: args.from as string, to: args.to as string });

                return { done: true, reassigned: 0 } as never;
            }
            case "reassignThreadFollowsPage": {
                const moved = Math.min(pageSize, followsLeft);

                followPageCalls += 1;
                followsLeft -= moved;

                return { hasMore: followsLeft > 0, moved } as never;
            }
            default: {
                throw new Error(`unexpected ${String(name)}`);
            }
        }
    };

    return { call, deletedGuests, followPageCalls: () => followPageCalls, reassigned, shards };
};

describe("canonicalValue", () => {
    it("tells apart what JSON cannot: the bytes of binary, and a bigint from its digits", () => {
        expect(canonicalValue({ a: new Uint8Array([1]).buffer })).not.toBe(canonicalValue({ a: new Uint8Array([2]).buffer }));
        expect(canonicalValue({ a: 5n })).not.toBe(canonicalValue({ a: "5" }));
        expect(canonicalValue({ a: 1, b: [2] })).toBe(canonicalValue({ a: 1, b: [2] }));
    });
});

describe("rewriteOwner", () => {
    it("re-points every top-level field naming the guest, and nothing else", () => {
        expect(rewriteOwner({ _id: "t1", grantedBy: "guest", title: "guest notes", userId: "guest" }, "guest", "user")).toStrictEqual({
            _id: "t1",
            grantedBy: "user",
            title: "guest notes",
            userId: "user",
        });
    });
});

describe("shardLocalTables", () => {
    it("moves every shard-local table and no `.global()` or bookkeeping one", async () => {
        // The REAL tiers: `test/setup-harness.ts` re-declares `.global()` tables for the harness.
        const { default: schema } = await vi.importActual<typeof import("../schema")>("../schema");
        const tables = shardLocalTables(schema);

        expect(tables).toContain("threads");
        expect(tables).toContain("messages");
        expect(tables).toContain("memories");
        expect(tables).not.toContain("user");
        expect(tables).not.toContain("prompts");
        expect(tables).not.toContain("rateLimits");
        expect(tables).not.toContain("cronRuns");
    });
});

describe("mergeGuestInto", () => {
    it("copies every row to the new shard under the same id, re-owned, then empties the guest's shard", async () => {
        const threads: Row[] = [
            { _id: "t1", title: "a", userId: "guest" },
            { _id: "t2", title: "b", userId: "guest" },
            { _id: "t3", title: "c", userId: "guest" },
        ];
        const messages: Row[] = [{ _id: "m1", threadId: "t1", userId: "guest" }];
        const { call, reassigned, shards } = fakeShards({ guest: { messages, threads }, user: { threads: [{ _id: "own", title: "mine", userId: "user" }] } });

        const { moved } = await mergeToEnd(call, "guest", "user");

        expect(moved).toBe(4);
        expect(
            shards
                .get("user")
                ?.get("threads")
                ?.map((row) => [row._id, row.userId]),
        ).toStrictEqual([
            ["own", "user"],
            ["t1", "user"],
            ["t2", "user"],
            ["t3", "user"],
        ]);
        // The reference between rows survives: the message still names its thread.
        expect(shards.get("user")?.get("messages")).toStrictEqual([{ _id: "m1", threadId: "t1", userId: "user" }]);
        expect(shards.get("guest")?.get("threads")).toStrictEqual([]);
        expect(shards.get("guest")?.get("messages")).toStrictEqual([]);
        expect(reassigned).toStrictEqual([{ from: "guest", to: "user" }]);
    });

    it("deletes the guest once its shard is empty, on the guest's shard", async () => {
        const { call, deletedGuests } = fakeShards({
            guest: {
                threads: [
                    { _id: "t1", userId: "guest" },
                    { _id: "t2", userId: "guest" },
                    { _id: "t3", userId: "guest" },
                ],
            },
        });

        await mergeToEnd(call, "guest", "user");

        expect(deletedGuests).toStrictEqual([{ left: 0, shardKey: "guest", userId: "guest" }]);
    });

    it("moves the guest's thread follows a page per call until none are left", async () => {
        const { call, deletedGuests, followPageCalls } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, { follows: 5 });

        const { moved } = await mergeToEnd(call, "guest", "user");

        expect(followPageCalls()).toBe(3);
        expect(moved).toBe(1 + 5);
        expect(deletedGuests).toStrictEqual([{ left: 0, shardKey: "guest", userId: "guest" }]);
    });

    it("keeps the guest and fails once the run cap leaves thread follows behind", async () => {
        const { call, deletedGuests, followPageCalls } = fakeShards({ guest: {} }, 2, { follows: Infinity });

        await expect(mergeToEnd(call, "guest", "user", { maxRuns: 20 })).rejects.toThrow("did not finish in 20 runs");

        expect(followPageCalls()).toBeGreaterThan(1);
        expect(deletedGuests).toStrictEqual([]);
    });

    it("moves the follows again when one still names the guest at its deletion, and keeps the guest while one does", async () => {
        const { call, deletedGuests, followPageCalls } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, { followsRemain: true });

        await expect(mergeToEnd(call, "guest", "user", { maxRuns: 20 })).rejects.toThrow("did not finish in 20 runs");

        expect(followPageCalls()).toBeGreaterThan(1);
        expect(deletedGuests).toStrictEqual([]);
    });

    it("never clears, and keeps the guest, when the copy of a table does not end within the run cap", async () => {
        const { call, deletedGuests } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        const clears: unknown[] = [];

        await expect(
            mergeToEnd(
                async (reference, args, shardKey) => {
                    if (reference.__lunoraRef.endsWith(":listShardRowsToClear") || reference.__lunoraRef.endsWith(":deleteShardRows")) {
                        clears.push(args);
                    }

                    // A page that never ends.
                    if (reference.__lunoraRef.endsWith(":listShardRowsPage") && args.table === "threads") {
                        return { continueCursor: "next", isDone: false, page: [{ _id: "t1", userId: "guest" }] } as never;
                    }

                    return await call(reference, args, shardKey);
                },
                "guest",
                "user",
                { maxRuns: 5 },
            ),
        ).rejects.toThrow("did not finish in 5 runs");

        expect(clears).toStrictEqual([]);
        expect(deletedGuests).toStrictEqual([]);
    });

    it("resumes a copy across runs from the cursor it stopped at, and clears only after every table is copied", async () => {
        const threads = Array.from({ length: 9 }, (_, index) => {
            return { _id: `t${String(index)}`, userId: "guest" };
        });
        const { call, shards } = fakeShards({ guest: { threads } });
        const log: string[] = [];

        const { runs } = await mergeToEnd(
            async (reference, args, shardKey) => {
                const name = reference.__lunoraRef.split(":", 2)[1]!;

                if (name === "listShardRowsPage" && args.table === "threads") {
                    log.push(`copy ${String(args.cursor)}`);
                }

                if (name === "deleteShardRows") {
                    log.push("delete");
                }

                return await call(reference, args, shardKey);
            },
            "guest",
            "user",
            { budget: 3 },
        );

        // Five pages of two, each read once: no run starts the table over.
        expect(log.filter((entry) => entry.startsWith("copy"))).toStrictEqual(["copy null", "copy 2", "copy 4", "copy 6", "copy 8"]);
        expect(log.indexOf("delete")).toBeGreaterThan(log.lastIndexOf("copy 8"));
        expect(runs.some((run) => run.phase === "copy" && run.table === "threads" && run.cursor !== null)).toBe(true);
        expect(shards.get("user")?.get("threads")).toHaveLength(9);
        expect(shards.get("guest")?.get("threads")).toStrictEqual([]);
    });

    it("queues the clear's next run when a table needs more clear pages than one run's calls, and deletes the guest only once it is empty", async () => {
        const threads = Array.from({ length: 30 }, (_, index) => {
            return { _id: `t${String(index)}`, userId: "guest" };
        });
        const { call, deletedGuests, shards } = fakeShards({ guest: { threads } });
        const calls: number[] = [];
        let resume: MergeProgress | undefined;
        let clearStops = 0;

        for (;;) {
            let made = 0;
            const { next } = await mergeGuestInto(
                async (reference, args, shardKey) => {
                    made += 1;

                    return await call(reference, args, shardKey);
                },
                REFERENCES,
                "guest",
                "user",
                { budget: 10, ...(resume !== undefined && { resume }) },
            );

            calls.push(made);

            if (next === null) {
                break;
            }

            if (next.phase === "clear" && next.table === "threads") {
                clearStops += 1;
                // Stopped mid-clear: the guest stays.
                expect(deletedGuests).toStrictEqual([]);
            }

            resume = next;
        }

        expect(clearStops).toBeGreaterThan(1);
        expect(Math.max(...calls)).toBeLessThanOrEqual(10);
        expect(shards.get("user")?.get("threads")).toHaveLength(30);
        expect(deletedGuests).toStrictEqual([{ left: 0, shardKey: "guest", userId: "guest" }]);
    });

    it("makes no more cross-shard calls in a run than the Free plan's subrequests allow", async () => {
        const { call } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        let made = 0;

        const { next } = await mergeGuestInto(
            async (reference, args, shardKey) => {
                made += 1;

                return await call(reference, args, shardKey);
            },
            REFERENCES,
            "guest",
            "user",
        );

        expect(next).not.toBeNull();
        expect(made).toBeLessThanOrEqual(MERGE_CALLS_PER_RUN);
        expect(MERGE_CALLS_PER_RUN).toBeLessThan(50);
    });

    it("queues its next run, from where it stopped, before a run that did not finish returns", async () => {
        const { call, deletedGuests } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        const harness = lunoraTest(schemaWithShardedTables(["sharedPinRoutes"]) as never);

        registry.set("chat_pins_functions:listSharedPinRoutesForExport", listSharedPinRoutesForExport);
        transport.call = call;
        transport.queued = [];

        try {
            const result = await harness.action(async (context: any) => await context.runAction(runGuestMerge, { from: "guest", to: "user" }));

            expect(result).toMatchObject({ done: false });
            expect(transport.queued).toHaveLength(1);
            expect(transport.queued[0]).toMatchObject({
                args: { from: "guest", resume: { run: 1 }, to: "user" },
                options: { shardKey: "user" },
                ref: { __lunoraRef: expect.stringContaining("runGuestMerge") },
            });
            expect(deletedGuests).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("is safe to run twice", async () => {
        const { call, shards } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });

        await mergeToEnd(call, "guest", "user");
        await mergeToEnd(call, "guest", "user");

        expect(shards.get("user")?.get("threads")).toStrictEqual([{ _id: "t1", userId: "user" }]);
    });
});

describe("reassignGlobalRows", () => {
    it("decides every `.global()` table with a `userId`: re-pointed, or left alone for a stated reason", async () => {
        const { default: schema } = await vi.importActual<typeof import("../schema")>("../schema");
        const { tables } = schema as unknown as { tables: Record<string, { shape?: Record<string, unknown>; shardMode?: { kind?: string } }> };
        const undecided = Object.entries(tables)
            .filter(([, table]) => table.shardMode?.kind === "global" && Object.keys(table.shape ?? {}).includes("userId"))
            .map(([name]) => name)
            .filter((name) => !(name in GLOBAL_USER_COLUMNS) && !(name in GLOBAL_USER_TABLES_NOT_REASSIGNED));

        expect(undecided).toStrictEqual([]);
    });

    it("re-points every row, well past one page of a facade read", async () => {
        const harness = lunoraTest(schemaWithShardedTables([...Object.keys(GLOBAL_USER_COLUMNS), "shardActivity"]) as never);
        const rows = 60;

        try {
            for (let index = 0; index < rows; index += 1) {
                await harness.run(
                    async (context: any) =>
                        await context.db.insert("knowledgeCollections", {
                            createdAt: index,
                            name: `Notes ${String(index)}`,
                            updatedAt: index,
                            userId: "guest",
                        }),
                );
            }

            // A guest's project repositories follow the same way, so the new account's export and lookup (by `userId`) find them.
            await harness.run(async (context: any) => {
                for (let index = 0; index < rows; index += 1) {
                    await context.db.insert("projectRepositories", {
                        createdAt: index,
                        projectId: `project-${String(index)}`,
                        url: `u${String(index)}`,
                        userId: "guest",
                    });
                }
            });

            const { reassigned } = await harness.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", to: "user" }));
            const left = await harness.run(async (context: any) => await context.db.knowledgeCollections.findMany({ where: { userId: "guest" } }));
            const leftRepositories = await harness.run(async (context: any) => await context.db.projectRepositories.findMany({ where: { userId: "guest" } }));
            const movedRepositories = await harness.run(async (context: any) => await context.db.projectRepositories.findMany({ where: { userId: "user" } }));

            expect(reassigned).toBe(rows * 2);
            expect(left.page).toStrictEqual([]);
            expect(leftRepositories.page).toStrictEqual([]);
            expect(movedRepositories.page).toHaveLength(rows);
        } finally {
            harness.close();
        }
    });

    it("moves a guest's rule-file rows a few per call, each read charged whole, until all are the new account's", async () => {
        const harness = lunoraTest(schemaWithShardedTables([...Object.keys(GLOBAL_USER_COLUMNS), "shardActivity"]) as never);

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < 10; index += 1) {
                    await context.db.insert("projectRuleFiles", { files: [], projectId: `project-${String(index)}`, updatedAt: 0, userId: "guest" });
                }
            });

            const first = await harness.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", to: "user" }));

            expect(first).toStrictEqual({ done: false, reassigned: 8 });

            const second = await harness.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", to: "user" }));
            const moved = await harness.run(async (context: any) => await context.db.projectRuleFiles.findMany({ where: { userId: "user" } }));

            expect(second).toMatchObject({ done: true, reassigned: 2 });
            expect(moved.page).toHaveLength(10);
        } finally {
            harness.close();
        }
    });

    it("hands a guest's knowledge collection to the new account, so its moved files can still be filed into it", async () => {
        const harness = lunoraTest(schemaWithShardedTables([...Object.keys(GLOBAL_USER_COLUMNS), "shardActivity"]) as never);

        try {
            const collectionId = (await harness.run(
                async (context: any) => await context.db.insert("knowledgeCollections", { createdAt: 0, name: "Guest notes", updatedAt: 0, userId: "guest" }),
            )) as string;

            await harness.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", to: "user" }));

            await harness.run(async (context: any) => {
                await expect(requireOwnCollectionId(context.db, collectionId as never, "user")).resolves.toBeUndefined();
                await expect(requireOwnCollectionId(context.db, collectionId as never, "guest")).rejects.toThrow();
            });
        } finally {
            harness.close();
        }
    });
});

describe("reassignThreadFollowsPage", () => {
    const followsHarness = () => lunoraTest(schemaWithShardedTables([...Object.keys(GLOBAL_USER_COLUMNS), "threadFollows", "shardActivity"]) as never);

    it("moves a guest's follow row, and keeps the new account's own row where both follow a thread", async () => {
        const harness = followsHarness();

        try {
            const seeded = await harness.run(async (context: any) => {
                const thread = async (title: string) =>
                    (await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title, userId: "owner" })) as string;
                const follow = async (userId: string, threadId: string, state: string) =>
                    (await context.db.insert("threadFollows", { createdAt: 1, state, threadId, updatedAt: 1, userId })) as string;
                const both = await thread("Both follow");
                const guestOnly = await thread("Guest follows");

                return {
                    both,
                    guestBoth: await follow("guest", both, "muted"),
                    guestOnly,
                    guestOnlyRow: await follow("guest", guestOnly, "on"),
                    userBoth: await follow("user", both, "on"),
                };
            });

            const result = await harness.run(async (context: any) => await context.runMutation(reassignThreadFollowsPage, { from: "guest", to: "user" }));
            const rows = await harness.run(async (context: any) => {
                const { page } = await context.db.threadFollows.findMany({ where: {} });

                return page.map((row: Record<string, unknown>) => {
                    return { _id: row._id, state: row.state, threadId: row.threadId, userId: row.userId };
                });
            });

            expect(result).toStrictEqual({ hasMore: false, moved: 1 });
            expect(rows.toSorted((a: { _id: string }, b: { _id: string }) => a._id.localeCompare(b._id))).toStrictEqual(
                [
                    { _id: seeded.userBoth, state: "on", threadId: seeded.both, userId: "user" },
                    { _id: seeded.guestOnlyRow, state: "on", threadId: seeded.guestOnly, userId: "user" },
                ].toSorted((a, b) => a._id.localeCompare(b._id)),
            );
            expect(rows.some((row: { _id: string }) => row._id === seeded.guestBoth)).toBe(false);
        } finally {
            harness.close();
        }
    });

    it("moves at most one page per call and says whether rows remain", async () => {
        const harness = followsHarness();
        const follows = FOLLOW_MERGE_PAGE_SIZE + 1;

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < follows; index += 1) {
                    const threadId = await context.db.insert("threads", {
                        mode: "text",
                        model: "gpt-4o",
                        status: "active",
                        title: `T${String(index)}`,
                        userId: "owner",
                    });

                    await context.db.insert("threadFollows", { createdAt: 1, state: "on", threadId, updatedAt: 1, userId: "guest" });
                }
            });

            const page = async () =>
                await harness.run(async (context: any) => await context.runMutation(reassignThreadFollowsPage, { from: "guest", to: "user" }));
            const left = async () =>
                await harness.run(async (context: any) => {
                    const { page: rows } = await context.db.threadFollows.findMany({ where: { userId: "guest" } });

                    return rows.length;
                });

            await expect(page()).resolves.toStrictEqual({ hasMore: true, moved: FOLLOW_MERGE_PAGE_SIZE });
            await expect(left()).resolves.toBe(1);
            await expect(page()).resolves.toStrictEqual({ hasMore: false, moved: 1 });
            await expect(left()).resolves.toBe(0);
        } finally {
            harness.close();
        }
    });

    it("is no longer part of reassignGlobalRows, which would run every page in one mutation", async () => {
        const harness = followsHarness();

        try {
            await harness.run(async (context: any) => {
                const threadId = await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "T", userId: "owner" });

                await context.db.insert("threadFollows", { createdAt: 1, state: "on", threadId, updatedAt: 1, userId: "guest" });
            });

            await harness.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", to: "user" }));
            const left = await harness.run(async (context: any) => await context.db.threadFollows.findMany({ where: { userId: "guest" } }));

            expect(left.page).toHaveLength(1);
        } finally {
            harness.close();
        }
    });
});

describe("deleteMergedGuest", () => {
    const harnessWithUsers = () =>
        lunoraTest(
            schemaWithShardedTables(["user", "session", "account", "member", "twoFactor", "passkey", "shardRoutes", "shardActivity", "threadFollows"]) as never,
        );

    const insertUser = async (harness: ReturnType<typeof harnessWithUsers>, isAnonymous: boolean) =>
        (await harness.run(
            async (context: any) =>
                await context.db.insert("user", {
                    createdAt: 0,
                    email: `${String(Math.random())}@example.com`,
                    emailVerified: false,
                    isAnonymous,
                    name: "U",
                    updatedAt: 0,
                }),
        )) as string;

    const userExists = async (harness: ReturnType<typeof harnessWithUsers>, id: string) =>
        await harness.run(async (context: any) => (await context.db.user.findFirst({ where: { _id: id } })) !== null);

    it("deletes a guest and its sessions", async () => {
        const harness = harnessWithUsers();

        try {
            const guest = await insertUser(harness, true);

            await harness.run(
                async (context: any) =>
                    await context.db.insert("session", { createdAt: 0, expiresAt: Date.now() + 60_000, token: "t", updatedAt: 0, userId: guest }),
            );

            const result = await harness.run(async (context: any) => await context.runMutation(deleteMergedGuest, { userId: guest }));

            expect(result).toStrictEqual({ deleted: true });
            await expect(userExists(harness, guest)).resolves.toBe(false);
            const sessions = await harness.run(async (context: any) => await context.db.session.findMany({ where: { userId: guest } }));

            expect(sessions.page).toStrictEqual([]);
            // A second run (queue redelivery) finds nothing to do.
            await expect(harness.run(async (context: any) => await context.runMutation(deleteMergedGuest, { userId: guest }))).resolves.toStrictEqual({
                deleted: false,
            });
        } finally {
            harness.close();
        }
    });

    it("keeps a guest that a thread follow still names, and says so", async () => {
        const harness = harnessWithUsers();

        try {
            const guest = await insertUser(harness, true);

            await harness.run(async (context: any) => {
                const threadId = await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "T", userId: "owner" });

                await context.db.insert("threadFollows", { createdAt: 1, state: "on", threadId, updatedAt: 1, userId: guest });
            });

            const result = await harness.run(async (context: any) => await context.runMutation(deleteMergedGuest, { userId: guest }));

            expect(result).toStrictEqual({ deleted: false, followsRemain: true });
            await expect(userExists(harness, guest)).resolves.toBe(true);
        } finally {
            harness.close();
        }
    });

    it("never deletes an account that is not a guest", async () => {
        const harness = harnessWithUsers();

        try {
            const member = await insertUser(harness, false);
            const result = await harness.run(async (context: any) => await context.runMutation(deleteMergedGuest, { userId: member }));

            expect(result).toStrictEqual({ deleted: false });
            await expect(userExists(harness, member)).resolves.toBe(true);
        } finally {
            harness.close();
        }
    });
});

describe("importShardRows for userSettings", () => {
    const run = async (guestRows: Record<string, unknown>[], seed?: Record<string, unknown>, crowd: Record<string, unknown>[] = []) => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            return await harness.run(async (context: any) => {
                for (const other of crowd) {
                    await context.db.insert("userSettings", other);
                }

                if (seed) {
                    await context.db.insert("userSettings", seed);
                }

                await context.runMutation(importShardRows, { from: "guest", rows: guestRows, table: "userSettings", to: "user" });

                const stored = await context.db.query("userSettings").take(MERGE_PAGE_SIZE + 50);

                return stored.filter((row: Record<string, unknown>) => row.userId === "user");
            });
        } finally {
            harness.close();
        }
    };

    it("adds a guest's skipped steps to the new account's settings and changes nothing else", async () => {
        const rows = await run([{ _id: "g1", language: "fr-FR", setupStepsSkipped: ["ssh", "agent"], userId: "guest" }], {
            language: "de-DE",
            setupStepsSkipped: ["pair", "ssh"],
            userId: "user",
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ language: "de-DE", setupStepsSkipped: ["agent", "pair", "ssh"] });
    });

    it("keeps the new account's own steps when the merged list passes the cap", async () => {
        const own = ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8"];
        const rows = await run([{ _id: "g1", setupStepsSkipped: ["g1", "g2", "g3"], userId: "guest" }], { setupStepsSkipped: own, userId: "user" });

        expect(rows[0]?.setupStepsSkipped).toEqual(own);
    });

    it("takes only the converting guest's own row from a page that holds another user's too", async () => {
        const rows = await run(
            [
                { _id: "o1", setupStepsSkipped: ["pair"], userId: "someone-else" },
                { _id: "g1", setupStepsSkipped: ["ssh"], userId: "guest" },
            ],
            { userId: "user" },
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]?.setupStepsSkipped).toEqual(["ssh"]);
    });

    it("finds the new account's row among more settings rows than a merge page holds, and adds no second one", async () => {
        const others = Array.from({ length: MERGE_PAGE_SIZE + 20 }, (_, index) => {
            return { userId: `other-${index}` };
        });
        const rows = await run([{ _id: "g1", setupStepsSkipped: ["agent"], userId: "guest" }], { language: "de-DE", userId: "user" }, others);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ language: "de-DE", setupStepsSkipped: ["agent"] });
    });

    it("leaves the new account's settings alone when the guest skipped nothing", async () => {
        const rows = await run([{ _id: "g1", language: "fr-FR", userId: "guest" }], { language: "de-DE", userId: "user" });

        expect(rows[0]).toMatchObject({ language: "de-DE" });
        expect(rows[0]?.setupStepsSkipped).toBeUndefined();
    });
});

describe("clearing the guest's settings", () => {
    it("lists only the guest's own settings rows, so a shard that also holds the new account's keeps it", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const result = await harness.run(async (context: any) => {
                const guestId = await context.db.insert("userSettings", { setupStepsSkipped: ["ssh"], userId: "guest" });

                await context.db.insert("userSettings", { language: "de-DE", userId: "user" });

                const { rows } = await context.runQuery(listShardRowsToClear, { ownedBy: "guest", table: "userSettings" });

                return { guestId, ids: rows.map((row: Row) => row._id) };
            });

            expect(result.ids).toEqual([result.guestId]);
        } finally {
            harness.close();
        }
    });

    it("asks for the guest's rows alone when it clears the tables the new account keeps its own row of", async () => {
        const { call } = fakeShards({ guest: { userSettings: [{ _id: "g1", userId: "guest" }] } });
        const listClearCalls: Record<string, unknown>[] = [];

        await mergeToEnd(
            async (reference, args, shardKey) => {
                if (reference.__lunoraRef.endsWith(":listShardRowsToClear")) {
                    listClearCalls.push(args);
                }

                return await call(reference, args, shardKey);
            },
            "guest",
            "user",
        );

        expect(listClearCalls.find((args) => args.table === "userSettings")).toEqual({ ownedBy: "guest", table: "userSettings" });
        expect(listClearCalls.find((args) => args.table === "threads")).toEqual({ table: "threads" });
    });
});

/**
 * The guest's shard and the new account's as two harnesses, each running the real row procedures; the steps around
 * them (global rows, follows, the guest's deletion) are stubbed. `beforeClear` runs once, after the copy and before the
 * first clear call, on the guest's harness.
 */
describe("mergeGuestInto across two real shards", () => {
    const PROCEDURES: Record<string, { fn: unknown; kind: "mutation" | "query" }> = {
        deleteShardRows: { fn: deleteShardRows, kind: "mutation" },
        dropImportMarkersPage: { fn: dropImportMarkersPage, kind: "mutation" },
        importShardRows: { fn: importShardRows, kind: "mutation" },
        listShardRowsPage: { fn: listShardRowsPage, kind: "query" },
        listShardRowsToClear: { fn: listShardRowsToClear, kind: "query" },
    };

    const thread = (title: string, userId = "guest") => {
        return { mode: "text", model: "gpt-4o", status: "active", title, updatedAt: 1, userId };
    };

    const byId = (a: { _id: unknown }, b: { _id: unknown }) => String(a._id).localeCompare(String(b._id));

    const twoShards = () => {
        const shards = { guest: lunoraTest(schemaWithShardedTables([]) as never), user: lunoraTest(schemaWithShardedTables([]) as never) };
        let before: { hook: () => Promise<void>; name: string } | undefined;
        let failOnce: ((name: string, args: Record<string, unknown>) => boolean) | undefined;

        const call: ShardCall = async (reference, args, shardKey) => {
            const name = reference.__lunoraRef.split(":", 2)[1]!;

            if (before?.name === name) {
                const { hook } = before;

                before = undefined;
                await hook();
            }

            if (failOnce?.(name, args)) {
                failOnce = undefined;

                throw new Error("the merge job was cut off");
            }

            switch (name) {
                case "deleteMergedGuest": {
                    return { deleted: true } as never;
                }
                case "reassignGlobalRows": {
                    return { done: true, reassigned: 0 } as never;
                }
                case "reassignThreadFollowsPage": {
                    return { hasMore: false, moved: 0 } as never;
                }
                default: {
                    const procedure = PROCEDURES[name]!;
                    const harness = shards[shardKey as keyof typeof shards];

                    return (await harness.run(async (context: any) =>
                        procedure.kind === "query" ? await context.runQuery(procedure.fn, args) : await context.runMutation(procedure.fn, args),
                    )) as never;
                }
            }
        };

        /** The shard's threads, by id. */
        const threadsOn = async (shardKey: keyof typeof shards) => {
            const rows = (await shards[shardKey].run(async (context: any) => await context.db.query("threads").take(50))) as Row[];

            return rows
                .map((row) => {
                    return { _id: row._id, title: row.title, userId: row.userId };
                })
                .toSorted(byId);
        };

        return {
            call,
            close: () => {
                shards.guest.close();
                shards.user.close();
            },
            /** Runs `hook` once, just before the first call of procedure `name`. */
            onceBefore: (name: string, hook: () => Promise<void>) => {
                before = { hook, name };
            },
            onceFail: (predicate: typeof failOnce) => {
                failOnce = predicate;
            },
            shards,
            threadsOn,
        };
    };

    it("moves a row written on the guest's shard after its table was copied, instead of deleting it uncopied", async () => {
        const merge = twoShards();

        try {
            const copied = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("before")))) as string;
            let late = "";

            merge.onceBefore("listShardRowsToClear", async () => {
                late = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("written during the merge")))) as string;
            });

            await mergeToEnd(merge.call, "guest", "user");

            expect(await merge.threadsOn("user")).toStrictEqual(
                [
                    { _id: copied, title: "before", userId: "user" },
                    { _id: late, title: "written during the merge", userId: "user" },
                ].toSorted(byId),
            );
            expect(await merge.threadsOn("guest")).toStrictEqual([]);
        } finally {
            merge.close();
        }
    });

    it("brings a row edited on the guest's shard after its copy over with the edit", async () => {
        const merge = twoShards();

        try {
            const id = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("first title")))) as string;

            merge.onceBefore("listShardRowsToClear", async () => {
                await merge.shards.guest.run(async (context: any) => await context.db.patch("threads", id, { title: "edited during the merge", updatedAt: 2 }));
            });

            await mergeToEnd(merge.call, "guest", "user");

            expect(await merge.threadsOn("user")).toStrictEqual([{ _id: id, title: "edited during the merge", userId: "user" }]);
            expect(await merge.threadsOn("guest")).toStrictEqual([]);
        } finally {
            merge.close();
        }
    });

    it("keeps a row edited between the clear's import and its delete, and moves it with the edit", async () => {
        const merge = twoShards();

        try {
            const id = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("first title")))) as string;

            merge.onceBefore("deleteShardRows", async () => {
                await merge.shards.guest.run(
                    async (context: any) => await context.db.patch("threads", id, { title: "edited at the last moment", updatedAt: 2 }),
                );
            });

            await mergeToEnd(merge.call, "guest", "user");

            expect(await merge.threadsOn("user")).toStrictEqual([{ _id: id, title: "edited at the last moment", userId: "user" }]);
            expect(await merge.threadsOn("guest")).toStrictEqual([]);
        } finally {
            merge.close();
        }
    });

    it("loses nothing when a clear is cut off halfway and the job runs again", async () => {
        const merge = twoShards();

        try {
            const ids = (await merge.shards.guest.run(
                async (context: any) => [await context.db.insert("threads", thread("one")), await context.db.insert("threads", thread("two"))] as string[],
            )) as string[];

            // The re-import of the clear landed; the job dies before the guest's rows are deleted.
            merge.onceFail((name, args) => name === "deleteShardRows" && args.table === "threads");

            await expect(mergeToEnd(merge.call, "guest", "user")).rejects.toThrow("cut off");

            // Written before the redelivery, and an edit to a row already copied.
            const late = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("three")))) as string;

            await merge.shards.guest.run(async (context: any) => await context.db.patch("threads", ids[0], { title: "one, edited", updatedAt: 2 }));

            await mergeToEnd(merge.call, "guest", "user");

            expect(await merge.threadsOn("user")).toStrictEqual(
                [
                    { _id: ids[0], title: "one, edited", userId: "user" },
                    { _id: ids[1], title: "two", userId: "user" },
                    { _id: late, title: "three", userId: "user" },
                ].toSorted(byId),
            );
            expect(await merge.threadsOn("guest")).toStrictEqual([]);
        } finally {
            merge.close();
        }
    });

    /** A document (a table without `updatedAt`) in a thread, on the guest's shard; its id. */
    const guestDocument = async (merge: ReturnType<typeof twoShards>, contentJson?: unknown) =>
        (await merge.shards.guest.run(async (context: any) => {
            const threadId = await context.db.insert("threads", thread("with a document"));

            return await context.db.insert("documents", {
                kind: "text",
                threadId,
                title: "guest draft",
                userId: "guest",
                version: 1,
                ...(contentJson !== undefined && { contentJson }),
            });
        })) as string;

    const documentOn = async (merge: ReturnType<typeof twoShards>, shardKey: "guest" | "user", id: string) =>
        (await merge.shards[shardKey].run(async (context: any) => await context.db.get("documents", id))) as Record<string, unknown> | null;

    it("keeps the new account's edit to a row without updatedAt through a redelivered merge and its clear, and drops its markers", async () => {
        const merge = twoShards();

        try {
            const id = await guestDocument(merge);

            // The clear's re-import landed; the job dies before the guest's rows are deleted.
            merge.onceFail((name, args) => name === "deleteShardRows" && args.table === "documents");
            await expect(mergeToEnd(merge.call, "guest", "user")).rejects.toThrow("cut off");

            await merge.shards.user.run(async (context: any) => await context.db.patch("documents", id, { title: "renamed by the account" }));

            // The redelivery copies everything again, then clears.
            await mergeToEnd(merge.call, "guest", "user");

            expect(await documentOn(merge, "user", id)).toMatchObject({ title: "renamed by the account", userId: "user" });
            expect(await documentOn(merge, "guest", id)).toBeNull();

            const markers = await merge.shards.user.run(
                async (context: any) =>
                    await context.db
                        .query("idempotencyClaims")
                        .withIndex("by_scope_key", (q: any) => q.eq("scope", "guest-merge-row"))
                        .take(10),
            );

            expect(markers).toStrictEqual([]);
        } finally {
            merge.close();
        }
    });

    it("does not bring back a moved row the new account deleted before the clear", async () => {
        const merge = twoShards();

        try {
            const id = await guestDocument(merge);

            merge.onceBefore("listShardRowsToClear", async () => {
                await merge.shards.user.run(async (context: any) => await context.db.delete("documents", id));
            });

            await mergeToEnd(merge.call, "guest", "user");

            expect(await documentOn(merge, "user", id)).toBeNull();
            expect(await documentOn(merge, "guest", id)).toBeNull();
        } finally {
            merge.close();
        }
    });

    it("keeps a row whose binary changed between the clear's import and its delete, and moves it with its bigint and new bytes", async () => {
        const merge = twoShards();

        try {
            const id = await guestDocument(merge, { blob: new Uint8Array([1, 2, 3]).buffer, count: 5n });

            merge.onceBefore("deleteShardRows", async () => {
                await merge.shards.guest.run(
                    async (context: any) => await context.db.patch("documents", id, { contentJson: { blob: new Uint8Array([9, 9, 9]).buffer, count: 5n } }),
                );
            });

            await mergeToEnd(merge.call, "guest", "user");

            const moved = (await documentOn(merge, "user", id))!.contentJson as { blob: ArrayBuffer; count: bigint };

            expect([...new Uint8Array(moved.blob)]).toStrictEqual([9, 9, 9]);
            expect(moved.count).toBe(5n);
            expect(await documentOn(merge, "guest", id)).toBeNull();
        } finally {
            merge.close();
        }
    });

    it("keeps the new account's own later edit to a moved row over the guest's older one", async () => {
        const merge = twoShards();

        try {
            const id = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("guest title")))) as string;

            merge.onceBefore("listShardRowsToClear", async () => {
                await merge.shards.user.run(async (context: any) => await context.db.patch("threads", id, { title: "renamed by the account", updatedAt: 5 }));
            });

            await mergeToEnd(merge.call, "guest", "user");

            expect(await merge.threadsOn("user")).toStrictEqual([{ _id: id, title: "renamed by the account", userId: "user" }]);
        } finally {
            merge.close();
        }
    });
});
