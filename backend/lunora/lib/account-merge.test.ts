/**
 * A converting guest's rows move from the guest's shard to the new account's
 * (`account-merge.ts`). The unit harness is one database for every shard, so
 * the end-to-end merges run the real procedures on one harness per store
 * ("mergeGuestInto on real shard procedures"). The in-memory `fakeShards`
 * caller stays for what a real store cannot stage: a failing or lapsing store
 * probe, the follows round cap, a follow written after the last page.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { deleteMergedGuest } from "../auth/hooks";
import { FOLLOW_MERGE_PAGE_SIZE } from "../chat/follows/follow-writes";
import { requireOwnCollectionId } from "../knowledge/documents-shared";
import type { MergeReferences, ShardCall } from "./account-merge";
import { deleteShardRows, importShardRows, listShardRowIds, listShardRowsPage, MERGE_PAGE_SIZE, shardOwnerField } from "./account-merge";
import {
    GLOBAL_USER_COLUMNS,
    GLOBAL_USER_TABLES_NOT_REASSIGNED,
    mergeGuestInto,
    reassignGlobalRows,
    reassignThreadFollowsPage,
    rewriteOwner,
    shardLocalTables,
} from "./account-merge";
import { claimHeld, claimKey, releaseKey } from "./claim-once";
import { schemaWithShardedTables } from "./test-schema";

const ref = (name: string) => {
    return { __lunoraRef: `lib_account_merge:${name}` };
};

const REFERENCES: MergeReferences = {
    deleteGuest: { __lunoraRef: "auth_hooks:deleteMergedGuest" },
    deleteRows: ref("deleteShardRows"),
    importRows: ref("importShardRows"),
    list: ref("listShardRowsPage"),
    listIds: ref("listShardRowIds"),
    markProbe: { __lunoraRef: "lib_claim_once:claimKey" },
    probeHeld: { __lunoraRef: "lib_claim_once:claimHeld" },
    reassignFollows: ref("reassignThreadFollowsPage"),
    reassignGlobal: ref("reassignGlobalRows"),
    releaseProbe: { __lunoraRef: "lib_claim_once:releaseKey" },
};

type Row = Record<string, unknown> & { _id: string };

/** What a failed store probe throws: its own message, or the shard call's error passed through. */
const PROBE_FAILURE = /probe|shard unavailable/;

/**
 * Two shards as `shardKey → table → rows`, and a caller that plays the procedures against them. `follows` is how many
 * follow rows the guest holds (`pageSize` move per call); `followsRemain` is what the guest deletion reports. With
 * `sameStore`, the new account's key serves the guest's store, as local routing can.
 */
const fakeShards = (
    seed: Record<string, Record<string, Row[]>>,
    pageSize = 2,
    {
        follows = 0,
        followsRemain = false,
        probe = {},
        sameStore = false,
    }: {
        follows?: number;
        followsRemain?: boolean;
        /** Overrides of the store probe: what the marker write answers, what the read answers or throws, and markers already there. */
        probe?: { held?: () => unknown; stale?: string[]; written?: unknown };
        sameStore?: boolean;
    } = {},
) => {
    let followsLeft = follows;
    let followPageCalls = 0;
    const shards = new Map(Object.entries(seed).map(([key, tables]) => [key, new Map(Object.entries(tables).map(([table, rows]) => [table, [...rows]]))]));
    const probes = new Map<Map<string, Row[]>, Set<string>>();

    if (sameStore) {
        shards.set("user", shards.get("guest") ?? new Map<string, Row[]>());
    }

    const probeKeys: string[] = [];
    const releasedProbes: string[] = [];

    if (probe.stale !== undefined) {
        const store = shards.get("guest") ?? new Map<string, Row[]>();

        shards.set("guest", store);
        probes.set(store, new Set(probe.stale));
    }

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
            case "claimHeld": {
                if (probe.held !== undefined) {
                    return probe.held() as never;
                }

                const store = shards.get(shardKey);

                return (store !== undefined && (probes.get(store)?.has(args.key as string) ?? false)) as never;
            }
            case "claimKey": {
                const store = shards.get(shardKey) ?? new Map<string, Row[]>();

                shards.set(shardKey, store);
                probeKeys.push(args.key as string);

                if (probe.written !== undefined) {
                    return probe.written as never;
                }

                probes.set(store, (probes.get(store) ?? new Set()).add(args.key as string));

                return true as never;
            }
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

                shard.set(
                    table,
                    (shard.get(table) ?? []).filter((row) => !(args.ids as string[]).includes(row._id)),
                );

                return null as never;
            }
            case "importShardRows": {
                const target = tableOf(shardKey, table);

                for (const row of args.rows as Row[]) {
                    const existing = target.find((candidate) => candidate._id === row._id);
                    const guestOwned = row.userId === args.from;

                    if (existing === undefined) {
                        target.push((guestOwned ? rewriteOwner(row, args.from as string, args.to as string) : row) as Row);
                    } else if (existing.userId === args.from) {
                        existing.userId = args.to;
                    }
                }

                return { imported: 0 } as never;
            }
            case "listShardRowIds": {
                // A table with no owner column is listed whole, as the procedure once did: the merge must not ask for one.
                return tableOf(shardKey, table)
                    .filter((row) => args.ownedBy === undefined || shardOwnerField(table) === undefined || row.userId === args.ownedBy)
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
            case "releaseKey": {
                releasedProbes.push(args.key as string);
                probes.get(shards.get(shardKey) ?? new Map())?.delete(args.key as string);

                return null as never;
            }
            default: {
                throw new Error(`unexpected ${String(name)}`);
            }
        }
    };

    return { call, deletedGuests, followPageCalls: () => followPageCalls, probeKeys, reassigned, releasedProbes, shards };
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

    it("deletes nothing and fails for the queue to redeliver when the round cap leaves rows uncopied", async () => {
        const threads: Row[] = Array.from({ length: 2002 }, (_, index) => ({ _id: `t${index}`, userId: "guest" }));
        const { call, deletedGuests, shards } = fakeShards({ guest: { threads } }, 2);

        await expect(mergeGuestInto(call, REFERENCES, "guest", "user")).rejects.toThrow("round cap");

        expect(deletedGuests).toStrictEqual([]);
        expect(shards.get("guest")?.get("threads")).toHaveLength(2002);
    });

    it("fails, for the queue to redeliver, when a follow still names the guest at its deletion", async () => {
        const { call } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, { followsRemain: true });

        await expect(mergeGuestInto(call, REFERENCES, "guest", "user")).rejects.toThrow("thread follows");
    });

    it("clears a collaborator's row an earlier, interrupted run already copied", async () => {
        const collaboratorRow: Row = { _id: "c2", body: "a collaborator's", userId: "collaborator" };
        const { call, shards } = fakeShards({ guest: { threads: [collaboratorRow] }, user: { threads: [{ ...collaboratorRow }] } });

        await mergeGuestInto(call, REFERENCES, "guest", "user");

        expect(shards.get("user")?.get("threads")).toStrictEqual([collaboratorRow]);
        expect(shards.get("guest")?.get("threads")).toStrictEqual([]);
    });

    it("probes with a key of its own on every attempt and releases it, so an earlier attempt's marker is never the one read", async () => {
        const { call, probeKeys, releasedProbes } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });

        await mergeGuestInto(call, REFERENCES, "guest", "user");
        await mergeGuestInto(call, REFERENCES, "guest", "user");

        expect(new Set(probeKeys).size).toBe(2);
        expect(releasedProbes).toStrictEqual(probeKeys);
    });

    it("keeps collaborators' rows when the store is shared, even with an earlier attempt's marker about to lapse", async () => {
        // An earlier attempt's marker under the old fixed key; a retry that reused it would read whatever is left of it.
        const { call, shards } = fakeShards({ guest: { threads: [{ _id: "c2", userId: "collaborator" }] } }, 2, {
            probe: { stale: ["guest:user"] },
            sameStore: true,
        });

        await mergeGuestInto(call, REFERENCES, "guest", "user");

        expect(shards.get("guest")?.get("threads")).toStrictEqual([{ _id: "c2", userId: "collaborator" }]);
    });

    it.each([
        { name: "the marker write takes no fresh claim", probe: { written: false } },
        {
            name: "the read fails",
            probe: {
                held: () => {
                    throw new Error("shard unavailable");
                },
            },
        },
        { name: "the read gives no answer", probe: { held: () => undefined } },
    ])("fails the merge and clears nothing when $name", async ({ probe }) => {
        const rows: Row[] = [
            { _id: "c1", userId: "guest" },
            { _id: "c2", userId: "collaborator" },
        ];
        const { call, deletedGuests, shards } = fakeShards({ guest: { threads: rows } }, 2, { probe });

        await expect(mergeGuestInto(call, REFERENCES, "guest", "user")).rejects.toThrow(PROBE_FAILURE);

        expect(shards.get("guest")?.get("threads")).toStrictEqual(rows);
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

describe("importShardRows for runWebhooks", () => {
    const webhook = (fields: Record<string, unknown>) => {
        return { createdAt: 1, enabled: true, secretCiphertext: "v1:cipher", updatedAt: 1, url: "https://example.com/hook", ...fields };
    };

    const run = async (guestRows: Record<string, unknown>[], seed?: Record<string, unknown>) => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            return await harness.run(async (context: any) => {
                if (seed) {
                    await context.db.insert("runWebhooks", seed);
                }

                await context.runMutation(importShardRows, { from: "guest", rows: guestRows, table: "runWebhooks", to: "user" });

                const stored = await context.db.query("runWebhooks").take(MERGE_PAGE_SIZE);

                return stored.filter((row: Record<string, unknown>) => row.userId === "user");
            });
        } finally {
            harness.close();
        }
    };

    it("copies the guest's webhook across when the new account has none", async () => {
        const rows = await run([webhook({ _id: "g1", url: "https://example.com/guest", userId: "guest" })]);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ url: "https://example.com/guest", userId: "user" });
    });

    it("re-owns the guest's row in place on a shard that already holds it, under the same id", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const result = await harness.run(async (context: any) => {
                const guestId = await context.db.insert("runWebhooks", webhook({ url: "https://example.com/guest", userId: "guest" }));

                await context.runMutation(importShardRows, {
                    from: "guest",
                    rows: [{ ...webhook({ url: "https://example.com/guest", userId: "guest" }), _id: guestId }],
                    table: "runWebhooks",
                    to: "user",
                });

                const stored = await context.db.query("runWebhooks").take(MERGE_PAGE_SIZE);

                return { guestId, stored };
            });

            expect(result.stored).toHaveLength(1);
            expect(result.stored[0]).toMatchObject({ _id: result.guestId, url: "https://example.com/guest", userId: "user" });
        } finally {
            harness.close();
        }
    });

    it("keeps the new account's own webhook and copies no second one beside it", async () => {
        const rows = await run(
            [webhook({ _id: "g1", url: "https://example.com/guest", userId: "guest" })],
            webhook({ url: "https://example.com/own", userId: "user" }),
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ url: "https://example.com/own" });
    });

    it("stops the merge, and leaves the row alone, when another user's webhook holds the guest webhook's id", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const stored = await harness.run(async (context: any) => {
                const strangerId = await context.db.insert("runWebhooks", webhook({ url: "https://example.com/stranger", userId: "stranger" }));

                await expect(
                    context.runMutation(importShardRows, {
                        from: "guest",
                        rows: [webhook({ _id: strangerId, url: "https://example.com/guest", userId: "guest" })],
                        table: "runWebhooks",
                        to: "user",
                    }),
                ).rejects.toThrow("already exists on the new account's shard");

                return context.db.query("runWebhooks").take(MERGE_PAGE_SIZE);
            });

            expect(stored).toHaveLength(1);
            expect(stored[0]).toMatchObject({ url: "https://example.com/stranger", userId: "stranger" });
        } finally {
            harness.close();
        }
    });
});

describe("importShardRows on an id another user's row holds", () => {
    it("stops the merge instead of skipping the guest's row, so the clear pass cannot delete it", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                const strangerId = await context.db.insert("threads", { title: "stranger chat", userId: "stranger" });

                await expect(
                    context.runMutation(importShardRows, {
                        from: "guest",
                        rows: [{ _id: strangerId, title: "guest chat", userId: "guest" }],
                        table: "threads",
                        to: "user",
                    }),
                ).rejects.toThrow("already exists on the new account's shard");
            });
        } finally {
            harness.close();
        }
    });
});

describe("a shard that holds both accounts' rows", () => {
    it("clears only the guest's threads, keeping the new account's", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const result = await harness.run(async (context: any) => {
                const guestId = await context.db.insert("threads", { title: "guest chat", userId: "guest" });

                await context.db.insert("threads", { title: "own chat", userId: "user" });

                const ids = await context.runQuery(listShardRowIds, { ownedBy: "guest", table: "threads" });

                return { guestId, ids };
            });

            expect(result.ids).toEqual([result.guestId]);
        } finally {
            harness.close();
        }
    });

    it("re-owns the guest's thread in place under its id, and leaves the new account's row as it is", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const result = await harness.run(async (context: any) => {
                const guestId = await context.db.insert("threads", { title: "guest chat", userId: "guest" });
                const ownId = await context.db.insert("threads", { title: "own chat", userId: "user" });

                await context.runMutation(importShardRows, {
                    from: "guest",
                    rows: [
                        { _id: guestId, title: "guest chat", userId: "guest" },
                        { _id: ownId, title: "own chat", userId: "user" },
                    ],
                    table: "threads",
                    to: "user",
                });

                const stored = await context.db.query("threads").take(MERGE_PAGE_SIZE);

                return { guestId, ownId, stored };
            });

            expect(result.stored).toHaveLength(2);
            expect(result.stored.filter((row: Record<string, unknown>) => row.userId === "guest")).toHaveLength(0);
            expect(result.stored.find((row: Record<string, unknown>) => row._id === result.guestId)).toMatchObject({
                title: "guest chat",
                userId: "user",
            });
            expect(result.stored.find((row: Record<string, unknown>) => row._id === result.ownId)).toMatchObject({ userId: "user" });
        } finally {
            harness.close();
        }
    });

    it("leaves another user's comment alone when the guest resolved it, on a shared shard", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const result = await harness.run(async (context: any) => {
                const pageId = await context.db.insert("pages", {
                    contentRevision: 0,
                    createdAt: 0,
                    order: 0,
                    revision: 0,
                    title: "Plan",
                    updatedAt: 0,
                    userId: "user",
                });
                const ownId = await context.db.insert("pageComments", {
                    authorName: "New",
                    body: "theirs",
                    commentId: "c-own",
                    createdAt: 0,
                    pageId,
                    resolvedBy: "guest",
                    status: "resolved",
                    userId: "user",
                });

                await context.runMutation(importShardRows, {
                    from: "guest",
                    rows: [
                        {
                            _id: ownId,
                            authorName: "New",
                            body: "theirs",
                            commentId: "c-own",
                            createdAt: 0,
                            pageId,
                            resolvedBy: "guest",
                            status: "resolved",
                            userId: "user",
                        },
                    ],
                    table: "pageComments",
                    to: "user",
                });

                return { ownId, stored: await context.db.get("pageComments", ownId) };
            });

            expect(result.stored).toMatchObject({ resolvedBy: "guest", userId: "user" });
        } finally {
            harness.close();
        }
    });

    it("moves a collaborator's comment on the guest's page with the page, still owned by the collaborator", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const result = await harness.run(async (context: any) => {
                const pageId = await context.db.insert("pages", {
                    contentRevision: 0,
                    createdAt: 0,
                    order: 0,
                    revision: 0,
                    title: "Plan",
                    updatedAt: 0,
                    userId: "guest",
                });
                // Inserted then removed, so the new shard does not already hold the row when the guest's shard sends it over.
                const commentId = await context.db.insert("pageComments", {
                    authorName: "Collaborator",
                    body: "from a collaborator",
                    commentId: "c-collab",
                    createdAt: 0,
                    pageId,
                    status: "open",
                    userId: "collab",
                });
                const sent = await context.db.get("pageComments", commentId);

                await context.db.delete("pageComments", commentId);

                await context.runMutation(importShardRows, {
                    from: "guest",
                    rows: [sent],
                    table: "pageComments",
                    to: "user",
                });

                return { stored: await context.db.get("pageComments", commentId) };
            });

            expect(result.stored).toMatchObject({ body: "from a collaborator", userId: "collab" });
        } finally {
            harness.close();
        }
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

    it("lists none of a table without an owner column when asked for one user's rows, never the whole table", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const result = await harness.run(async (context: any) => {
                const row = { createdAt: 1, lastMessageId: "m1", suggestions: ["next"], updatedAt: 1 };

                await context.db.insert("followupSuggestions", { ...row, threadId: "t-guest" });
                await context.db.insert("followupSuggestions", { ...row, threadId: "t-other-user" });

                return {
                    owned: await context.runQuery(listShardRowIds, { ownedBy: "guest", table: "followupSuggestions" }),
                    whole: await context.runQuery(listShardRowIds, { table: "followupSuggestions" }),
                };
            });

            expect(result.owned).toEqual([]);
            expect(result.whole).toHaveLength(2);
        } finally {
            harness.close();
        }
    });

    it.each([
        { expectedThreads: { table: "threads" }, sameStore: false },
        { expectedThreads: { ownedBy: "guest", table: "threads" }, sameStore: true },
    ])(
        "asks for the guest's rows alone when it clears the tables the new account keeps its own row of (one store: $sameStore)",
        async ({ expectedThreads, sameStore }) => {
            const { call } = fakeShards({ guest: { userSettings: [{ _id: "g1", userId: "guest" }] } }, 2, { sameStore });
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
            expect(listIdCalls.find((args) => args.table === "runWebhooks")).toEqual({ ownedBy: "guest", table: "runWebhooks" });
            expect(listIdCalls.find((args) => args.table === "threads")).toEqual(expectedThreads);
        },
    );
});

/**
 * `mergeGuestInto` against the REAL shard procedures: each shard key is a `lunoraTest` harness, and the caller runs the
 * referenced procedure (the probe's `claimKey`/`claimHeld`/`releaseKey` included) on the harness behind that key. Two
 * harnesses stand for separate stores; one harness behind both keys for a shared store (shard routing off). The harness
 * also holds the `.global()` tables as shard tables (`test/setup-harness.ts`), so the merge walks those too; the
 * assertions are about the shard-local tables.
 */
describe("mergeGuestInto on real shard procedures", () => {
    type Harness = ReturnType<typeof lunoraTest>;
    type Method = "runMutation" | "runQuery";

    const PROCEDURES: Record<string, [procedure: unknown, method: Method]> = {
        "auth_hooks:deleteMergedGuest": [deleteMergedGuest, "runMutation"],
        "lib_account_merge:deleteShardRows": [deleteShardRows, "runMutation"],
        "lib_account_merge:importShardRows": [importShardRows, "runMutation"],
        "lib_account_merge:listShardRowIds": [listShardRowIds, "runQuery"],
        "lib_account_merge:listShardRowsPage": [listShardRowsPage, "runQuery"],
        "lib_account_merge:reassignGlobalRows": [reassignGlobalRows, "runMutation"],
        "lib_account_merge:reassignThreadFollowsPage": [reassignThreadFollowsPage, "runMutation"],
        "lib_claim_once:claimHeld": [claimHeld, "runQuery"],
        "lib_claim_once:claimKey": [claimKey, "runMutation"],
        "lib_claim_once:releaseKey": [releaseKey, "runMutation"],
    };

    /** A shard caller over `stores` (shard key → harness). Before each delete on the guest's shard, `beforeDelete` sees it. */
    const realShards =
        (stores: Record<string, Harness>, beforeDelete?: (table: string, ids: string[]) => Promise<void>): ShardCall =>
        async (reference, args, shardKey) => {
            const entry = PROCEDURES[reference.__lunoraRef];
            const harness = stores[shardKey];

            if (entry === undefined || harness === undefined) {
                throw new Error(`no procedure ${reference.__lunoraRef} on shard ${shardKey}`);
            }

            if (reference.__lunoraRef.endsWith(":deleteShardRows") && beforeDelete !== undefined) {
                await beforeDelete(args.table as string, args.ids as string[]);
            }

            const [procedure, method] = entry;

            return (await harness.run(async (context: any) => await context[method](procedure, args))) as never;
        };

    const insert = async (harness: Harness, table: string, row: Record<string, unknown>): Promise<string> =>
        (await harness.run(async (context: any) => await context.db.insert(table, row))) as string;

    /** A row under an id of the caller's choosing, as a copy from another shard is written. */
    const insertWithId = async (harness: Harness, table: string, row: Record<string, unknown>): Promise<void> => {
        await harness.run(async (context: any) => await context.db.insert(table, row, { allowExplicitId: true }));
    };

    const get = async (harness: Harness, table: string, id: string): Promise<Record<string, unknown> | null> =>
        (await harness.run(async (context: any) => await context.db.get(table, id))) as Record<string, unknown> | null;

    const all = async (harness: Harness, table: string): Promise<Record<string, unknown>[]> =>
        (await harness.run(async (context: any) => await context.db.query(table).take(MERGE_PAGE_SIZE))) as Record<string, unknown>[];

    const ownersOf = async (harness: Harness, table: string): Promise<Record<string, unknown>> => {
        const rows = await all(harness, table);

        return Object.fromEntries(rows.map((row) => [row._id as string, row.userId]));
    };

    const rowsOf = async (harness: Harness, table: string, userId: string): Promise<Record<string, unknown>[]> => {
        const rows = await all(harness, table);

        return rows.filter((row) => row.userId === userId);
    };

    const guestUser = async (harness: Harness): Promise<string> =>
        await insert(harness, "user", { createdAt: 0, email: "guest@example.com", emailVerified: false, isAnonymous: true, name: "Guest", updatedAt: 0 });

    const webhook = (url: string, userId: string) => {
        return { createdAt: 1, enabled: true, secretCiphertext: "v1:cipher", updatedAt: 1, url, userId };
    };

    const suggestion = (threadId: string) => {
        return { createdAt: 1, lastMessageId: "m", suggestions: ["next"], threadId, updatedAt: 1 };
    };

    it("separate stores: moves the guest's and collaborators' rows, keeps everyone else's, and deletes nothing before it is copied", async () => {
        const guestStore = lunoraTest(schemaWithShardedTables([]) as never);
        const userStore = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const guest = await guestUser(guestStore);
            const thread = await insert(guestStore, "threads", { title: "guest chat", userId: guest });
            const message = await insert(guestStore, "messages", { threadId: thread, userId: guest });
            const page = await insert(guestStore, "pages", {
                contentRevision: 0,
                createdAt: 0,
                order: 0,
                revision: 0,
                title: "Plan",
                updatedAt: 0,
                userId: guest,
            });
            const comment = await insert(guestStore, "pageComments", {
                authorName: "Collaborator",
                body: "from a collaborator",
                commentId: "c-collab",
                createdAt: 0,
                pageId: page,
                status: "open",
                userId: "collab",
            });
            const guestSuggestion = await insert(guestStore, "followupSuggestions", suggestion(thread));
            const strangerSettings = await insert(guestStore, "userSettings", { language: "fr-FR", userId: "stranger" });

            await insert(guestStore, "userSettings", { setupStepsSkipped: ["ssh"], userId: guest });

            const ownThread = await insert(userStore, "threads", { title: "own chat", userId: "user" });
            const strangerThread = await insert(userStore, "threads", { title: "stranger chat", userId: "stranger" });
            const strangerSuggestion = await insert(userStore, "followupSuggestions", suggestion("t-stranger"));

            await insert(userStore, "userSettings", { language: "de-DE", userId: "user" });

            const notYetCopied: string[] = [];
            const call = realShards({ [guest]: guestStore, user: userStore }, async (table, ids) => {
                for (const id of ids) {
                    // Every guest-shard row the clear pass deletes is already on the new shard.
                    if (
                        (await get(guestStore, table, id)) !== null &&
                        (await get(userStore, table, id)) === null &&
                        !["runWebhooks", "userSettings"].includes(table)
                    ) {
                        notYetCopied.push(`${table}:${id}`);
                    }
                }
            });

            await mergeGuestInto(call, REFERENCES, guest, "user");

            expect(notYetCopied).toStrictEqual([]);
            // The guest's own rows, re-owned under their ids; the reference between them still holds.
            expect(await get(userStore, "threads", thread)).toMatchObject({ title: "guest chat", userId: "user" });
            expect(await get(userStore, "messages", message)).toMatchObject({ threadId: thread, userId: "user" });
            expect(await get(userStore, "pages", page)).toMatchObject({ userId: "user" });
            // The collaborator's comment moves with the page, still the collaborator's.
            expect(await get(userStore, "pageComments", comment)).toMatchObject({ pageId: page, userId: "collab" });
            // A table without an owner column moves whole from a store that held only the guest's key.
            expect(await get(userStore, "followupSuggestions", guestSuggestion)).toMatchObject({ threadId: thread });
            // Everyone else's rows on the new shard are as they were.
            expect(await ownersOf(userStore, "threads")).toStrictEqual({ [ownThread]: "user", [strangerThread]: "stranger", [thread]: "user" });
            expect(await get(userStore, "followupSuggestions", strangerSuggestion)).toMatchObject({ threadId: "t-stranger" });
            // The new account keeps its own settings, with the guest's skipped step added.
            expect(await rowsOf(userStore, "userSettings", "user")).toStrictEqual([expect.objectContaining({ language: "de-DE", setupStepsSkipped: ["ssh"] })]);

            // The guest's shard is emptied of what moved; another user's settings, copied for the guest alone, stay there.
            for (const table of ["threads", "messages", "pages", "pageComments", "followupSuggestions"]) {
                expect(await all(guestStore, table)).toStrictEqual([]);
            }

            expect(await all(guestStore, "userSettings")).toStrictEqual([expect.objectContaining({ _id: strangerSettings, userId: "stranger" })]);
            expect(await all(guestStore, "idempotencyClaims")).toStrictEqual([]);
            expect(await all(userStore, "idempotencyClaims")).toStrictEqual([]);
        } finally {
            guestStore.close();
            userStore.close();
        }
    });

    it("shared store: re-owns only the guest's rows in place, clears no ownerless table, and keeps everyone else's", async () => {
        const store = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const guest = await guestUser(store);
            const guestThread = await insert(store, "threads", { title: "guest chat", userId: guest });
            const ownThread = await insert(store, "threads", { title: "own chat", userId: "user" });
            const strangerThread = await insert(store, "threads", { title: "stranger chat", userId: "stranger" });
            const suggestions = [
                await insert(store, "followupSuggestions", suggestion(guestThread)),
                await insert(store, "followupSuggestions", suggestion(strangerThread)),
            ];
            const ownSettings = await insert(store, "userSettings", { language: "de-DE", userId: "user" });
            const strangerSettings = await insert(store, "userSettings", { language: "fr-FR", userId: "stranger" });

            await insert(store, "userSettings", { setupStepsSkipped: ["agent"], userId: guest });

            await mergeGuestInto(realShards({ [guest]: store, user: store }), REFERENCES, guest, "user");

            expect(await ownersOf(store, "threads")).toStrictEqual({ [guestThread]: "user", [ownThread]: "user", [strangerThread]: "stranger" });
            const keptSuggestions = await all(store, "followupSuggestions");

            expect(keptSuggestions.map((row) => row._id as string).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
                suggestions.toSorted((a, b) => a.localeCompare(b)),
            );
            expect(await ownersOf(store, "userSettings")).toStrictEqual({ [ownSettings]: "user", [strangerSettings]: "stranger" });
            expect(await get(store, "userSettings", ownSettings)).toMatchObject({ language: "de-DE", setupStepsSkipped: ["agent"] });
            // Nothing of the guest's is left, so the guest itself goes.
            expect(await get(store, "user", guest)).toBeNull();
            expect(await all(store, "idempotencyClaims")).toStrictEqual([]);
        } finally {
            store.close();
        }
    });

    it("stops before clearing anything when the real import refuses a row partway through the copy", async () => {
        const guestStore = lunoraTest(schemaWithShardedTables([]) as never);
        const userStore = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const guest = await guestUser(guestStore);
            // A stranger's thread on the new shard holds the id of one of the guest's threads.
            const clash = await insert(userStore, "threads", { title: "stranger chat", userId: "stranger" });

            await insertWithId(guestStore, "threads", { _id: clash, title: "guest chat", userId: guest });

            // `messages` is copied before `threads`, so the copy has started when it is refused.
            const message = await insert(guestStore, "messages", { threadId: clash, userId: guest });
            const before = { messages: await all(guestStore, "messages"), threads: await all(guestStore, "threads") };

            await expect(mergeGuestInto(realShards({ [guest]: guestStore, user: userStore }), REFERENCES, guest, "user")).rejects.toThrow(
                "already exists on the new account's shard",
            );

            expect(await get(userStore, "messages", message)).toMatchObject({ userId: "user" });
            expect(await all(guestStore, "messages")).toStrictEqual(before.messages);
            expect(await all(guestStore, "threads")).toStrictEqual(before.threads);
            expect(await get(guestStore, "user", guest)).toMatchObject({ isAnonymous: true });
            expect(await get(userStore, "threads", clash)).toMatchObject({ title: "stranger chat", userId: "stranger" });
        } finally {
            guestStore.close();
            userStore.close();
        }
    });

    it.each([{ sameStore: false }, { sameStore: true }])(
        "drops the guest's webhook where the new account already has one, and touches nobody else's (one store: $sameStore)",
        async ({ sameStore }) => {
            const guestStore = lunoraTest(schemaWithShardedTables([]) as never);
            const userStore = sameStore ? guestStore : lunoraTest(schemaWithShardedTables([]) as never);

            try {
                const guest = await guestUser(guestStore);
                const guestHook = await insert(guestStore, "runWebhooks", webhook("https://example.com/guest", guest));
                const strangerOnGuest = await insert(guestStore, "runWebhooks", webhook("https://example.com/stranger-a", "stranger"));
                const ownHook = await insert(userStore, "runWebhooks", webhook("https://example.com/own", "user"));
                const strangerOnUser = await insert(userStore, "runWebhooks", webhook("https://example.com/stranger-b", "stranger"));

                await mergeGuestInto(realShards({ [guest]: guestStore, user: userStore }), REFERENCES, guest, "user");

                expect(await rowsOf(userStore, "runWebhooks", "user")).toStrictEqual([
                    expect.objectContaining({ _id: ownHook, url: "https://example.com/own" }),
                ]);
                expect(await get(guestStore, "runWebhooks", guestHook)).toBeNull();
                expect(await get(userStore, "runWebhooks", guestHook)).toBeNull();
                expect(await get(guestStore, "runWebhooks", strangerOnGuest)).toMatchObject({ url: "https://example.com/stranger-a", userId: "stranger" });
                expect(await get(userStore, "runWebhooks", strangerOnUser)).toMatchObject({ url: "https://example.com/stranger-b", userId: "stranger" });
            } finally {
                guestStore.close();

                if (!sameStore) {
                    userStore.close();
                }
            }
        },
    );
});
