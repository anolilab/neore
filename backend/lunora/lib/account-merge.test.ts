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
import type { MergeReferences, ShardCall } from "./account-merge";
import { ORGANIZATION_RECORD_LATE_MS } from "../usage/activity-logic";
import { reconcileOrganizationContributor } from "../usage/organization";
import { importShardRows, listShardRowIds, MERGE_PAGE_SIZE } from "./account-merge";
import {
    GLOBAL_USER_COLUMNS,
    GLOBAL_USER_TABLES_NOT_REASSIGNED,
    handOverOrganizationContributors,
    mergeGuestInto,
    reassignGlobalRows,
    reassignThreadFollowsPage,
    rewriteOwner,
    shardLocalTables,
} from "./account-merge";
import { schemaWithShardedTables } from "./test-schema";

const ref = (name: string) => {
    return { __lunoraRef: `lib_account_merge:${name}` };
};

const REFERENCES: MergeReferences = {
    deleteGuest: { __lunoraRef: "auth_hooks:deleteMergedGuest" },
    deleteRows: ref("deleteShardRows"),
    handOverContributors: ref("handOverOrganizationContributors"),
    importRows: ref("importShardRows"),
    list: ref("listShardRowsPage"),
    listIds: ref("listShardRowIds"),
    reassignFollows: ref("reassignThreadFollowsPage"),
    reassignGlobal: ref("reassignGlobalRows"),
};

type Row = Record<string, unknown> & { _id: string };

/**
 * Two shards as `shardKey → table → rows`, and a caller that plays the procedures against them. `follows` is how many
 * follow rows the guest holds (`pageSize` move per call); `followsRemain` is what the guest deletion reports.
 */
const fakeShards = (
    seed: Record<string, Record<string, Row[]>>,
    pageSize = 2,
    {
        follows = 0,
        followsRemain = false,
        handOverDone = true,
        stuck = false,
    }: { follows?: number; followsRemain?: boolean; handOverDone?: boolean; stuck?: boolean } = {},
) => {
    let followsLeft = follows;
    let followPageCalls = 0;
    const shards = new Map(Object.entries(seed).map(([key, tables]) => [key, new Map(Object.entries(tables).map(([table, rows]) => [table, [...rows]]))]));
    const reassigned: { from: string; to: string }[] = [];
    /** Every procedure called, in order. */
    const calls: string[] = [];
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

        calls.push(String(name));

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
                if (stuck) {
                    return null as never;
                }

                const shard = shards.get(shardKey) ?? new Map<string, Row[]>();

                shard.set(
                    table,
                    (shard.get(table) ?? []).filter((row) => !(args.ids as string[]).includes(row._id)),
                );

                return null as never;
            }
            case "handOverOrganizationContributors": {
                return { done: handOverDone } as never;
            }
            case "importShardRows": {
                const target = tableOf(shardKey, table);

                for (const row of args.rows as Row[]) {
                    if (target.every((existing) => existing._id !== row._id)) {
                        target.push(rewriteOwner(row, args.from as string, args.to as string) as Row);
                    }
                }

                return { imported: 0 } as never;
            }
            case "listShardRowIds": {
                return tableOf(shardKey, table)
                    .slice(0, pageSize)
                    .map((row) => row._id) as never;
            }
            case "listShardRowsPage": {
                const rows = tableOf(shardKey, table);
                const start = Number(args.cursor ?? 0);
                const page = rows.slice(start, start + pageSize);
                const next = start + pageSize;

                return { continueCursor: next < rows.length ? String(next) : null, isDone: next >= rows.length, page } as never;
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

    return { call, calls, deletedGuests, followPageCalls: () => followPageCalls, reassigned, shards };
};

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

        const { moved } = await mergeGuestInto(call, REFERENCES, "guest", "user");

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

    it("hands the guest's organization contributor entries over before it copies a row, so the copy knows where ledger rows belong", async () => {
        const { call, calls } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });

        await mergeGuestInto(call, REFERENCES, "guest", "user");

        expect(calls[0]).toBe("handOverOrganizationContributors");
        expect(calls.indexOf("importShardRows")).toBeGreaterThan(0);
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

        await mergeGuestInto(call, REFERENCES, "guest", "user");

        expect(deletedGuests).toStrictEqual([{ left: 0, shardKey: "guest", userId: "guest" }]);
    });

    it("moves the guest's thread follows a page per call until none are left", async () => {
        const { call, deletedGuests, followPageCalls } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, { follows: 5 });

        const { moved } = await mergeGuestInto(call, REFERENCES, "guest", "user");

        expect(followPageCalls()).toBe(3);
        expect(moved).toBe(1 + 5);
        expect(deletedGuests).toStrictEqual([{ left: 0, shardKey: "guest", userId: "guest" }]);
    });

    it("keeps the guest and fails for the queue to redeliver when the round cap leaves thread follows behind", async () => {
        const { call, deletedGuests, followPageCalls } = fakeShards({ guest: {} }, 2, { follows: Infinity });

        await expect(mergeGuestInto(call, REFERENCES, "guest", "user")).rejects.toThrow("round cap");

        expect(followPageCalls()).toBeGreaterThan(1);
        expect(deletedGuests).toStrictEqual([]);
    });

    it("fails, for the queue to redeliver, when a follow still names the guest at its deletion", async () => {
        const { call } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, { followsRemain: true });

        await expect(mergeGuestInto(call, REFERENCES, "guest", "user")).rejects.toThrow("thread follows");
    });

    it("fails before it copies a row when the hand-over's round cap leaves contributor entries, so the redelivery hands them over first", async () => {
        const { call, calls, deletedGuests } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, { handOverDone: false });

        await expect(mergeGuestInto(call, REFERENCES, "guest", "user")).rejects.toThrow("contributor entries");

        expect(calls).not.toContain("importShardRows");
        expect(deletedGuests).toStrictEqual([]);
    });

    it("keeps the guest and fails for the queue to redeliver when the clear's round cap leaves rows on the guest's shard", async () => {
        const { call, deletedGuests, followPageCalls, reassigned } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, {
            follows: 1,
            stuck: true,
        });

        await expect(mergeGuestInto(call, REFERENCES, "guest", "user")).rejects.toThrow("rows on its shard");

        // The thread follows still move first, so a run the queue gives up on has moved them.
        expect(followPageCalls()).toBe(1);

        // The marked contributor entries stay as they are for the redelivery to settle, never left marked by a run that returned.
        expect(reassigned).toStrictEqual([{ from: "guest", to: "user" }]);
        expect(deletedGuests).toStrictEqual([]);
    });

    it("is safe to run twice", async () => {
        const { call, shards } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });

        await mergeGuestInto(call, REFERENCES, "guest", "user");
        await mergeGuestInto(call, REFERENCES, "guest", "user");

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

                const ids = await context.runQuery(listShardRowIds, { ownedBy: "guest", table: "userSettings" });

                return { guestId, ids };
            });

            expect(result.ids).toEqual([result.guestId]);
        } finally {
            harness.close();
        }
    });

    it("asks for the guest's rows alone when it clears the tables the new account keeps its own row of", async () => {
        const { call } = fakeShards({ guest: { userSettings: [{ _id: "g1", userId: "guest" }] } });
        const listIdCalls: Record<string, unknown>[] = [];

        await mergeGuestInto(
            async (reference, args, shardKey) => {
                if (reference.__lunoraRef.endsWith(":listShardRowIds")) {
                    listIdCalls.push(args);
                }

                return await call(reference, args, shardKey);
            },
            REFERENCES,
            "guest",
            "user",
        );

        expect(listIdCalls.find((args) => args.table === "userSettings")).toEqual({ ownedBy: "guest", table: "userSettings" });
        expect(listIdCalls.find((args) => args.table === "threads")).toEqual({ table: "threads" });
    });
});

describe("importShardRows for the organization ledger", () => {
    it("moves every guest organization row, holding the older ones out of the view where the guest's entry did not become the new account's", async () => {
        const now = 10 * ORGANIZATION_RECORD_LATE_MS;
        const harness = lunoraTest(schemaWithShardedTables(["shardActivity"]) as never, { now } as never);
        const row = (id: string, at: number) => {
            return { _id: id, at, costMicrodollars: 100, organizationId: "org-1", projectKey: "p", replyKey: id, tokens: 1, userId: "guest" };
        };

        try {
            // No contributor entry for the guest yet (its reconcile has not run): before, the old row was skipped and deleted with the guest.
            const { moved, result } = await harness.run(async (context: any) => {
                const imported = await context.runMutation(importShardRows, {
                    from: "guest",
                    rows: [row("old", now - ORGANIZATION_RECORD_LATE_MS - 1), row("recent", now - ORGANIZATION_RECORD_LATE_MS)],
                    table: "usageOrganizationReplies",
                    to: "user",
                });

                return { moved: await context.db.query("usageOrganizationReplies").take(10), result: imported };
            });

            expect(moved.map((entry: { heldFrom?: string; replyKey: string; userId: string }) => [entry.replyKey, entry.userId, entry.heldFrom])).toEqual([
                ["old", "user", "guest"],
                ["recent", "user", undefined],
            ]);
            expect(result).toStrictEqual({ held: 1, imported: 2 });
        } finally {
            harness.close();
        }
    });
});

describe("merging a guest's organization usage", () => {
    const now = 10 * ORGANIZATION_RECORD_LATE_MS;
    const harness = () => lunoraTest(schemaWithShardedTables([...Object.keys(GLOBAL_USER_COLUMNS), "shardActivity"]) as never, { now } as never);
    const ledgerRow = (id: string, at: number) => {
        return { _id: id, at, costMicrodollars: 100, organizationId: "org-1", projectKey: "p", replyKey: id, tokens: 1, userId: "guest" };
    };
    const old = now - ORGANIZATION_RECORD_LATE_MS - 1;
    const recent = now - 1;

    /** Hand-over, the copy of the guest's ledger rows (passed in, as the guest's shard would page them), then the global re-point. */
    const merge = async (run: ReturnType<typeof harness>, rows: Record<string, unknown>[]) => {
        await run.run(async (context: any) => await context.runMutation(handOverOrganizationContributors, { from: "guest", to: "user" }));
        await run.run(
            async (context: any) => await context.runMutation(importShardRows, { from: "guest", rows, table: "usageOrganizationReplies", to: "user" }),
        );
        await run.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", to: "user" }));

        return await run.run(async (context: any) => {
            const entries = await context.db.usageOrganizationContributors.findMany({ where: { organizationId: "org-1" } });
            const ledger = await context.db.usageOrganizationReplies.findMany({ where: { organizationId: "org-1", userId: "user" } });

            return {
                entries: entries.page.map((entry: any) => [entry.userId, entry.cohort, entry.mergedFrom]),
                // A held row (`heldFrom`) is the account's record, outside the view.
                ledger: ledger.page
                    .map((row: any) => (typeof row.heldFrom === "string" ? `${String(row.replyKey)} (held)` : (row.replyKey as string)))
                    .toSorted((a: string, b: string) => a.localeCompare(b)),
            };
        });
    };

    it("keeps the guest's cohort and every ledger row with it, so a contributor is never left without the usage its weeks counted", async () => {
        const run = harness();

        try {
            await run.run(async (context: any) => {
                await context.db.insert("usageOrganizationContributors", { cohort: 2, createdAt: old, organizationId: "org-1", userId: "guest" });
            });

            // Only rows past the late window: before, none moved, and the new account sat in the guest's cohort with no activity.
            const after = await merge(run, [ledgerRow("closed-a", old), ledgerRow("closed-b", old - 1)]);

            expect(after.entries).toStrictEqual([["user", 2, undefined]]);
            expect(after.ledger).toStrictEqual(["closed-a", "closed-b"]);
        } finally {
            run.close();
        }
    });

    it("keeps the new account's own entry where both are contributors, and holds the guest's rows of weeks the view may show", async () => {
        const run = harness();

        try {
            await run.run(async (context: any) => {
                await context.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: old, organizationId: "org-1", userId: "guest" });
                await context.db.insert("usageOrganizationContributors", { cohort: 3, createdAt: old, organizationId: "org-1", userId: "user" });
            });

            const after = await merge(run, [ledgerRow("closed", old), ledgerRow("open", recent)]);

            // The new account's closed weeks stay in its cohort, and the guest's closed rows join none: no released cell changes by them.
            expect(after.entries).toStrictEqual([["user", 3, undefined]]);
            expect(after.ledger).toStrictEqual(["closed (held)", "open"]);
        } finally {
            run.close();
        }
    });

    it("drops the guest's entry where the new account has ledger rows under the organization but no entry yet", async () => {
        const run = harness();

        try {
            await run.run(async (context: any) => {
                await context.db.insert("usageOrganizationContributors", { cohort: 1, createdAt: old, organizationId: "org-1", userId: "guest" });
                await context.db.insert("usageOrganizationReplies", {
                    at: old,
                    costMicrodollars: 100,
                    organizationId: "org-1",
                    projectKey: "p",
                    replyKey: "own",
                    tokens: 1,
                    userId: "user",
                });
            });

            const after = await merge(run, [ledgerRow("closed", old)]);

            expect(after.entries).toStrictEqual([]);
            expect(after.ledger).toStrictEqual(["closed (held)", "own"]);
        } finally {
            run.close();
        }
    });

    it("is safe to run twice: the second hand-over finds nothing of the guest's, and the cohort keeps its rows", async () => {
        const run = harness();

        try {
            await run.run(async (context: any) => {
                await context.db.insert("usageOrganizationContributors", { cohort: 2, createdAt: old, organizationId: "org-1", userId: "guest" });
            });

            await merge(run, [ledgerRow("closed", old)]);
            const again = await merge(run, []);

            expect(again.entries).toStrictEqual([["user", 2, undefined]]);
            expect(again.ledger).toStrictEqual(["closed"]);
        } finally {
            run.close();
        }
    });
});

describe("an organization contributor entry handed over by a merge", () => {
    const now = 10 * ORGANIZATION_RECORD_LATE_MS;
    const harness = () => lunoraTest(schemaWithShardedTables([...Object.keys(GLOBAL_USER_COLUMNS), "shardActivity"]) as never, { now } as never);
    const entries = async (run: ReturnType<typeof harness>) =>
        await run.run(async (context: any) => {
            const { page } = await context.db.usageOrganizationContributors.findMany({ where: { organizationId: "org-1" } });

            return page.map((entry: any) => [entry.userId, entry.cohort, entry.mergedFrom]);
        });

    it("survives a reconcile while the copy has not brought its rows yet, and goes at the merge's end when none came", async () => {
        const run = harness();

        try {
            // A stale entry: the guest's rows are gone (pruned), and its reconcile has not run.
            await run.run(async (context: any) => {
                await context.db.insert("usageOrganizationContributors", { cohort: 2, createdAt: 1, organizationId: "org-1", userId: "guest" });
            });
            await run.run(async (context: any) => await context.runMutation(handOverOrganizationContributors, { from: "guest", to: "user" }));
            // A prune on the new account's shard between two copy pages reconciles it.
            await run.run(async (context: any) => await context.runMutation(reconcileOrganizationContributor, { organizationId: "org-1", userId: "user" }));

            expect(await entries(run)).toStrictEqual([["user", 2, "guest"]]);

            await run.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", to: "user" }));

            // No ledger row reached the new account: no member sits in the cohort with no usage.
            expect(await entries(run)).toStrictEqual([]);
        } finally {
            run.close();
        }
    });
});

describe("a guest entry the new account's own entry outranks", () => {
    const harness = () => lunoraTest(schemaWithShardedTables([...Object.keys(GLOBAL_USER_COLUMNS), "shardActivity"]) as never);
    const entries = async (run: ReturnType<typeof harness>) =>
        await run.run(async (context: any) => {
            const { page } = await context.db.usageOrganizationContributors.findMany({ where: { organizationId: "org-1" } });

            return page.map((entry: any) => [entry.userId, entry.cohort, entry.mergedFrom]).toSorted((a: string[], b: string[]) => a[0]!.localeCompare(b[0]!));
        });

    it("stays the guest's, marked, until the guest's shard is empty: their cohort is withheld and they are not booked again meanwhile", async () => {
        const run = harness();

        try {
            await run.run(async (context: any) => {
                await context.db.insert("usageOrganizationContributors", { cohort: 0, createdAt: 1, organizationId: "org-1", userId: "guest" });
                await context.db.insert("usageOrganizationContributors", { cohort: 3, createdAt: 1, organizationId: "org-1", userId: "user" });
            });
            await run.run(async (context: any) => await context.runMutation(handOverOrganizationContributors, { from: "guest", to: "user" }));

            expect(await entries(run)).toStrictEqual([
                ["guest", 0, "guest"],
                ["user", 3, undefined],
            ]);

            // Rows still on the guest's shard: the global step leaves the mark while the merge could not empty it.
            await run.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", guestDrained: false, to: "user" }));

            expect(await entries(run)).toHaveLength(2);

            await run.run(async (context: any) => await context.runMutation(reassignGlobalRows, { from: "guest", to: "user" }));

            expect(await entries(run)).toStrictEqual([["user", 3, undefined]]);
        } finally {
            run.close();
        }
    });
});
