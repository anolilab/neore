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
    abandonPinsLeft,
    acquireMergeLease,
    beginMergeRun,
    canonicalValue,
    deleteShardRows,
    dropImportMarkersPage,
    importShardRows,
    listShardRowsPage,
    listShardRowsToClear,
    MERGE_CALLS_PER_RUN,
    MERGE_FENCE_SCOPE,
    MERGE_GENERATION_SCOPE,
    MERGE_LEASE_CALLS,
    MERGE_LEASE_SCOPE,
    MERGE_PAGE_SIZE,
    MERGE_PROGRESS_SCOPE,
    MERGE_STALL_MS,
    noteMergeGeneration,
    recordGuestMerge,
    resumeStalledGuestMerges,
} from "./account-merge";
import {
    GLOBAL_USER_COLUMNS,
    GLOBAL_USER_TABLES_NOT_REASSIGNED,
    firstTableWithGuestRows,
    mergeGuestInto,
    NOT_USER_REFERENCE_FIELDS,
    reassignGlobalRows,
    reassignThreadFollowsPage,
    releaseMergeLease,
    rewriteOwner,
    runGuestMerge,
    shardLocalTables,
    USER_REFERENCE_FIELDS,
} from "./account-merge";
import { IMPORT_MARKER_EXPIRES_AT, IMPORT_MARKER_SCOPE, MERGE_PINS_LEFT_SCOPE, pinsLeftShard, resolvePinsLeft } from "./account-merge";
import { purgeExpiredClaims } from "./claim-once";
import { eraseWaitUntil } from "./account-moves";
import { runInShard } from "./shard-context";
import { schemaWithShardedTables } from "./test-schema";

// The action's own query runs in the harness, which takes the registered procedure; every other reference stays plain.
const registry = vi.hoisted(() => new Map<string, unknown>());

/**
 * New accounts that are gone (erased). The `user` table is `.global()`, which these harnesses do not hold, so whether a
 * merge's new account still exists is read from here; `isMergeDestination` itself is tested on a real `user` row below.
 */
const goneAccounts = vi.hoisted(() => new Set<string>());

vi.mock("../auth/lib/merge-destination", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../auth/lib/merge-destination")>();

    return {
        ...actual,
        isMergeDestination: async (_context: unknown, userId: string) => !goneAccounts.has(userId),
    };
});

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
    abandonPinsLeft: ref("abandonPinsLeft"),
    acquireLease: ref("acquireMergeLease"),
    beginRun: ref("beginMergeRun"),
    deleteGuest: { __lunoraRef: "auth_hooks:deleteMergedGuest" },
    deleteRows: ref("deleteShardRows"),
    dropMarkers: ref("dropImportMarkersPage"),
    importRows: ref("importShardRows"),
    list: ref("listShardRowsPage"),
    listClear: ref("listShardRowsToClear"),
    listPinRoutes: { __lunoraRef: "chat_pins_functions:listSharedPinRoutesForExport" },
    movePinRoute: ref("moveSharedPinRouteOf"),
    nextPinRoute: ref("nextSharedPinRoute"),
    noteGeneration: ref("noteMergeGeneration"),
    pinsLeft: ref("pinsLeftShard"),
    reassignFollows: ref("reassignThreadFollowsPage"),
    reassignGlobal: ref("reassignGlobalRows"),
    reassignPins: { __lunoraRef: "chat_pins_functions:reassignUserPinsOnThread" },
    releaseLease: ref("releaseMergeLease"),
    resolvePinsLeft: ref("resolvePinsLeft"),
    routeOwner: ref("sharedPinRouteOwner"),
    stopKeepingGuest: ref("stopMergeKeepingGuest"),
};

/** A guest's pin on a thread another user owns, and its `.global()` route, as the fake shards keep them. */
interface FakePin {
    ownerId: string;
    threadId: string;
    userId: string;
}

type Row = Record<string, unknown> & { _id: string };

/** Every run of a merge, as the queue would chain them: each from where the last stopped, until one says it is done. */
const mergeToEnd = async (
    call: ShardCall,
    from: string,
    to: string,
    { resume: start, ...options }: { budget?: number; maxRuns?: number; resume?: MergeProgress } = {},
): Promise<{ moved: number; runs: MergeProgress[] }> => {
    const runs: MergeProgress[] = [];
    let resume: MergeProgress | undefined = start;

    for (;;) {
        const { busyUntil, moved, next } = await mergeGuestInto(call, REFERENCES, from, to, { ...options, ...(resume !== undefined && { resume }) });

        if (busyUntil !== undefined) {
            throw new Error("the merge's lease is held by another delivery");
        }

        if (next === null) {
            return { moved, runs };
        }

        runs.push(next);
        resume = next;
    }
};

/**
 * Two shards as `shardKey → table → rows`, and a caller that plays the procedures against them. `follows` is how many
 * follow rows the guest holds (`pageSize` move per call); `followsRemain` is what the guest deletion reports. `pins` are
 * the guest's pins on other owners' threads, each with its route; `onGuestDeletion` runs before each guest deletion.
 */
const fakeShards = (
    seed: Record<string, Record<string, Row[]>>,
    pageSize = 2,
    {
        follows = 0,
        followsRemain = false,
        onGuestDeletion,
        pins = [],
    }: { follows?: number; followsRemain?: boolean; onGuestDeletion?: (pins: FakePin[], routes: FakePin[]) => void; pins?: FakePin[] } = {},
) => {
    let followsLeft = follows;
    /** Owner shards whose own merge's clear has moved their pins away (`pinsLeftShard`). */
    const pinsLeft = new Set<string>();
    /** Of those, the ones whose merge stopped before re-pointing their routes (`abandonPinsLeft`). */
    const abandoned = new Set<string>();
    /** Each merge that stopped and kept its guest (`stopMergeKeepingGuest`). */
    const keptGuests: string[] = [];
    const pinRows = pins.map((pin) => {
        return { ...pin };
    });
    const routes = pins.map((pin) => {
        return { ...pin };
    });
    /** Each route move, with how many of the guest's pins on that thread were left at that moment. */
    const routeMoves: { guestPinsLeft: number; threadId: string }[] = [];
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
            case "abandonPinsLeft": {
                if (pinsLeft.has(args.from as string)) {
                    abandoned.add(args.from as string);
                }

                return null as never;
            }
            case "acquireMergeLease": {
                return { generation: 1 } as never;
            }
            case "beginMergeRun": {
                return { finished: false, pinWritesUntil: null, stopped: false } as never;
            }
            case "deleteMergedGuest": {
                onGuestDeletion?.(pinRows, routes);

                if (followsRemain) {
                    return { deleted: false, followsRemain: true } as never;
                }

                if (routes.some((route) => route.userId === args.userId)) {
                    return { deleted: false, pinsRemain: true } as never;
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

                return { fenced: false } as never;
            }
            case "dropImportMarkersPage": {
                return { fenced: false, hasMore: false } as never;
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

                return { fenced: false, imported: 0, present: (args.rows as Row[]).map((row) => row._id) } as never;
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
            case "listSharedPinRoutesForExport": {
                const page = routes
                    .filter((route) => route.userId === args.userId)
                    .map((route) => {
                        return { ownerId: route.ownerId, threadId: route.threadId };
                    });

                return { continueCursor: null, isDone: true, page } as never;
            }
            case "moveSharedPinRouteOf": {
                const left = pinRows.filter((pin) => pin.userId === args.from && pin.threadId === args.threadId).length;

                routeMoves.push({ guestPinsLeft: left, threadId: args.threadId as string });

                for (const route of routes) {
                    if (route.userId === args.from && route.threadId === args.threadId) {
                        route.userId = args.to as string;
                    }
                }

                return null as never;
            }
            case "nextSharedPinRoute": {
                const route = routes.find((each) => each.userId === args.from);

                return (route === undefined ? null : { ownerId: route.ownerId, threadId: route.threadId }) as never;
            }
            case "noteMergeGeneration": {
                return { current: true } as never;
            }
            case "pinsLeftShard": {
                return { abandoned: abandoned.has(args.ownerId as string), left: pinsLeft.has(args.ownerId as string) } as never;
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
            case "reassignUserPinsOnThread": {
                // One pin per call, so a thread with several takes several steps.
                const pin = pinRows.find((each) => each.ownerId === shardKey && each.threadId === args.threadId && each.userId === args.from);

                if (pin !== undefined) {
                    pin.userId = args.to as string;
                }

                return { hasMore: pinRows.some((each) => each.ownerId === shardKey && each.threadId === args.threadId && each.userId === args.from) } as never;
            }
            case "releaseMergeLease": {
                return null as never;
            }
            case "resolvePinsLeft": {
                pinsLeft.delete(args.from as string);
                abandoned.delete(args.from as string);

                return { fenced: false } as never;
            }
            case "sharedPinRouteOwner": {
                return (routes.find((route) => route.userId === args.userId && route.threadId === args.threadId)?.ownerId ?? null) as never;
            }
            case "stopMergeKeepingGuest": {
                keptGuests.push(args.from as string);

                return { superseded: false } as never;
            }
            default: {
                throw new Error(`unexpected ${String(name)}`);
            }
        }
    };

    return { abandoned, call, deletedGuests, followPageCalls: () => followPageCalls, keptGuests, pinRows, pinsLeft, reassigned, routeMoves, routes, shards };
};

/** A class instance and a pattern: no Lunora column holds either. */
class Custom {
    public readonly kind = "custom";
}

const ANY_PATTERN = /x/u;

describe("canonicalValue", () => {
    it("tells apart what JSON cannot: the bytes of binary, and a bigint from its digits", () => {
        expect(canonicalValue({ a: new Uint8Array([1]).buffer })).not.toBe(canonicalValue({ a: new Uint8Array([2]).buffer }));
        expect(canonicalValue({ a: 5n })).not.toBe(canonicalValue({ a: "5" }));
        expect(canonicalValue({ a: 1, b: [2] })).toBe(canonicalValue({ a: 1, b: [2] }));
    });

    it("compares a Map and a Set the store gives back by content and order, which the storage codec keeps", () => {
        const entries: [unknown, unknown][] = [
            [1n, new Set([1, 2])],
            ["b", 2],
        ];

        expect(canonicalValue(new Map(entries))).toBe(canonicalValue(new Map(entries.map(([key, item]) => [key, item instanceof Set ? new Set(item) : item]))));
        // A change of order alone is a change: a row reordered after the clear read it is not deleted on the old digest.
        expect(canonicalValue(new Map(entries))).not.toBe(canonicalValue(new Map(entries.toReversed())));
        expect(canonicalValue(new Set([1, 2]))).not.toBe(canonicalValue(new Set([1, 2].toReversed())));
        expect(canonicalValue(new Map([["a", 1]]))).not.toBe(canonicalValue(new Map([["a", 2]])));
        expect(canonicalValue(new Set(["a"]))).not.toBe(canonicalValue(new Set(["b"])));
        // Not one another, nor the `{}` and array JSON would write for them.
        const texts = [new Map([["a", 1]]), { a: 1 }, new Set(["a"]), ["a"], new Map(), new Set(), {}].map((value) => canonicalValue(value));

        expect(new Set(texts).size).toBe(texts.length);
    });

    it("tells apart every other value the storage codec revives: a URL, an Error, and a typed array's type", () => {
        expect(canonicalValue(new URL("https://example.com/a"))).not.toBe(canonicalValue(new URL("https://example.com/b")));
        expect(canonicalValue(new URL("https://example.com/a"))).not.toBe(canonicalValue("https://example.com/a"));
        expect(canonicalValue(new TypeError("x"))).not.toBe(canonicalValue(new RangeError("x")));
        expect(canonicalValue(new Error("x", { cause: 1 }))).not.toBe(canonicalValue(new Error("x", { cause: 2 })));
        const buffer = new ArrayBuffer(4);

        new Float32Array(buffer).set([1]);
        expect(canonicalValue(new Float32Array(buffer))).not.toBe(canonicalValue(new Int32Array(buffer)));
    });

    it("tells apart the same bytes held as another binary type, which the storage codec keeps apart", () => {
        const bytes = [1, 2, 3, 4];
        const buffer = (): ArrayBuffer => {
            const copy = new ArrayBuffer(bytes.length);

            new Uint8Array(copy).set(bytes);

            return copy;
        };
        const texts = [
            buffer(),
            new Uint8Array(bytes),
            new Uint8ClampedArray(bytes),
            new Int8Array(bytes),
            new Uint16Array(buffer()),
            new DataView(buffer()),
        ].map((value) => canonicalValue({ a: value }));

        // A guest's edit that only changes a value's binary type changes the row's digest, so the clear imports it again.
        expect(new Set(texts).size).toBe(texts.length);
        expect(canonicalValue({ a: buffer() })).toBe(canonicalValue({ a: buffer() }));
        expect(canonicalValue({ a: new Uint8Array(bytes) })).toBe(canonicalValue({ a: new Uint8Array([0, ...bytes]).subarray(1) }));
    });

    it("still refuses a value the store cannot hold, so a row it cannot compare is never deleted", () => {
        expect(() => canonicalValue({ a: new Custom() })).toThrow(TypeError);
        expect(() => canonicalValue({ a: ANY_PATTERN })).toThrow(TypeError);
    });
});

/** A column name that may hold a user id: each one on a shard-local table is decided in `USER_REFERENCE_FIELDS` or not. */
const USER_LIKE_COLUMN = /user|owner|by$|author|actor|member|recipient|invitee|creator|sender|editor|requester|^referenceId$/iu;

describe("rewriteOwner", () => {
    it("re-points every user-reference field naming the guest, and nothing else", () => {
        expect(rewriteOwner({ _id: "t1", resolvedBy: "guest", title: "guest notes", userId: "guest" }, "guest", "user")).toStrictEqual({
            _id: "t1",
            resolvedBy: "user",
            title: "guest notes",
            userId: "user",
        });
    });

    it("keeps a content field whose value happens to be the guest's id", () => {
        expect(rewriteOwner({ _id: "t1", createdBy: "guest", note: "guest", title: "guest", userId: "guest" }, "guest", "user")).toStrictEqual({
            _id: "t1",
            createdBy: "user",
            note: "guest",
            title: "guest",
            userId: "user",
        });
    });

    it("decides every shard-local column with a user-like name: a user reference, or not one for a stated reason", async () => {
        const { default: schema } = await vi.importActual<typeof import("../schema")>("../schema");
        const { tables } = schema as unknown as { tables: Record<string, { shape: Record<string, unknown> }> };
        const userLike = USER_LIKE_COLUMN;
        const undecided = shardLocalTables(schema).flatMap((table) =>
            Object.keys(tables[table]!.shape)
                .filter((field) => userLike.test(field) && !USER_REFERENCE_FIELDS.has(field) && !(field in NOT_USER_REFERENCE_FIELDS))
                .map((field) => `${table}.${field}`),
        );

        expect(undecided).toStrictEqual([]);
        // Each listed one is a column somewhere: a stale entry would hide nothing, but says what is no longer true.
        const columns = new Set(shardLocalTables(schema).flatMap((table) => Object.keys(tables[table]!.shape)));

        expect([...USER_REFERENCE_FIELDS, ...Object.keys(NOT_USER_REFERENCE_FIELDS)].filter((field) => !columns.has(field))).toStrictEqual([]);
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
            // The run's own calls and one step of the costliest phase (the second pin pass's four calls), so every step fits.
            { budget: MERGE_LEASE_CALLS + 4 },
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
                { budget: 13, ...(resume !== undefined && { resume }) },
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
        expect(Math.max(...calls)).toBeLessThanOrEqual(13);
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
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

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

    it("queues itself again for when the lease lapses while another delivery holds it, and touches nothing meanwhile", async () => {
        const { call, shards } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const made: string[] = [];

        vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
        transport.call = async (reference, args, shardKey) => {
            made.push(reference.__lunoraRef);

            return reference.__lunoraRef.endsWith(":acquireMergeLease")
                ? ({ busyUntil: 1_000_000 + 90_000, generation: 4 } as never)
                : await call(reference, args, shardKey);
        };
        transport.queued = [];

        try {
            const resume: MergeProgress = { cursor: null, moved: 0, phase: "clear", run: 3, table: "threads" };
            const result = await harness.action(async (context: any) => await context.runAction(runGuestMerge, { from: "guest", resume, to: "user" }));

            expect(result).toStrictEqual({ done: false, moved: 0 });
            expect(made).toStrictEqual(["lib_account_merge:acquireMergeLease"]);
            expect(transport.queued).toStrictEqual([
                { args: { from: "guest", resume, to: "user" }, options: { delayMs: 90_000, shardKey: "user" }, ref: expect.objectContaining({}) },
            ]);
            expect(shards.get("guest")?.get("threads")).toHaveLength(1);
        } finally {
            vi.useRealTimers();
            harness.close();
        }
    });

    it("moves a pin the guest makes on a shared thread during the merge before its route, and keeps the guest until none is left", async () => {
        let late = true;
        const { call, deletedGuests, pinRows, routeMoves, routes } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, {
            onGuestDeletion: (pins, pinRoutes) => {
                // A pin made between the pin step and the guest's deletion, on a thread whose route already moved: it gets a route of its own.
                if (!late) {
                    return;
                }

                late = false;
                pins.push({ ownerId: "owner-b", threadId: "shared-2", userId: "guest" });
                pinRoutes.push({ ownerId: "owner-b", threadId: "shared-2", userId: "guest" });
            },
            pins: [
                { ownerId: "owner-a", threadId: "shared-1", userId: "guest" },
                { ownerId: "owner-a", threadId: "shared-1", userId: "guest" },
            ],
        });

        // A small budget, so the pin step spans runs and every later run is a resumed one.
        const { runs } = await mergeToEnd(call, "guest", "user", { budget: MERGE_LEASE_CALLS + 4 });

        expect(runs.length).toBeGreaterThan(1);
        expect(pinRows.every((pin) => pin.userId === "user")).toBe(true);
        expect(routes.every((route) => route.userId === "user")).toBe(true);
        expect(routeMoves).toStrictEqual([
            { guestPinsLeft: 0, threadId: "shared-1" },
            { guestPinsLeft: 0, threadId: "shared-2" },
        ]);
        expect(deletedGuests).toStrictEqual([{ left: 0, shardKey: "guest", userId: "guest" }]);
    });

    it("resumes the second pin pass at its route's thread, so a route deleted before it between runs skips nothing", async () => {
        const { call, pinRows, routes } = fakeShards({});

        routes.push(
            { ownerId: "owner-a", threadId: "shared-1", userId: "user" },
            { ownerId: "owner-a", threadId: "shared-2", userId: "user" },
            { ownerId: "owner-a", threadId: "shared-3", userId: "user" },
        );
        // A guest pin an owner's parallel merge moved behind the account's third route: only the second pass reaches it.
        pinRows.push({ ownerId: "owner-a", threadId: "shared-3", userId: "guest" });

        // A run stopped at the third route; the first one goes before the next run reads the page again.
        const resume: MergeProgress = { cursor: null, moved: 0, phase: "repins", route: 2, routeThread: "shared-3", run: 1, table: "" };

        routes.shift();

        await mergeToEnd(call, "guest", "user", { resume });

        expect(pinRows).toStrictEqual([{ ownerId: "owner-a", threadId: "shared-3", userId: "user" }]);
    });

    it("saves the thread of the route the second pin pass stopped at with its progress", async () => {
        const { call, pinRows, routes } = fakeShards({});

        routes.push({ ownerId: "owner-a", threadId: "shared-1", userId: "user" }, { ownerId: "owner-a", threadId: "shared-2", userId: "user" });
        // Two pins: the fake moves one a call, so the second route takes two steps.
        pinRows.push({ ownerId: "owner-a", threadId: "shared-2", userId: "guest" }, { ownerId: "owner-a", threadId: "shared-2", userId: "guest" });

        const resume: MergeProgress = { cursor: null, moved: 0, phase: "repins", run: 1, table: "" };
        // The lease calls and two of the pass's steps (two calls each): it stops inside the second route.
        const { next } = await mergeGuestInto(call, REFERENCES, "guest", "user", { budget: MERGE_LEASE_CALLS + 4, resume });

        expect(next).toMatchObject({ phase: "repins", route: 1, routeThread: "shared-2" });
    });

    it("follows a route the owner's merge re-points after the second pin pass read it, so the guest's pin is moved where it went", async () => {
        // The owner's merge copied the pin to its new shard and cleared it here, signalling so; its route still names this shard.
        const { call, deletedGuests, pinRows, pinsLeft, routes } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, {
            pins: [{ ownerId: "owner-a", threadId: "shared-1", userId: "guest" }],
        });

        pinRows[0]!.ownerId = "owner-n";
        pinsLeft.add("owner-a");

        let raced = false;

        await mergeToEnd(
            async (reference, args, shardKey) => {
                const name = reference.__lunoraRef.split(":", 2)[1]!;
                const result: never = await call(reference, args, shardKey);

                // Right after the pass read the route: the owner's `global` step re-points it, then drops its signal.
                if (name === "listSharedPinRoutesForExport" && !raced) {
                    raced = true;
                    routes[0]!.ownerId = "owner-n";
                    pinsLeft.delete("owner-a");
                }

                return result;
            },
            "guest",
            "user",
        );

        expect(raced).toBe(true);
        expect(pinRows).toStrictEqual([{ ownerId: "owner-n", threadId: "shared-1", userId: "user" }]);
        expect(deletedGuests).toHaveLength(1);
    });

    it("stops and keeps the guest when the owner's merge it waits on stopped before re-pointing its routes", async () => {
        const { abandoned, call, deletedGuests, keptGuests, pinRows, pinsLeft } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } }, 2, {
            pins: [{ ownerId: "owner-a", threadId: "shared-1", userId: "guest" }],
        });

        // Moved off the owner's shard by a merge that then stopped (an erasure, its run cap): no route will lead to it.
        pinRows[0]!.ownerId = "owner-n";
        pinsLeft.add("owner-a");
        abandoned.add("owner-a");

        const results: Awaited<ReturnType<typeof mergeGuestInto>>[] = [];
        let resume: MergeProgress | undefined;

        do {
            results.push(await mergeGuestInto(call, REFERENCES, "guest", "user", resume === undefined ? {} : { resume }));
            resume = results.at(-1)!.next ?? undefined;
        } while (resume !== undefined && results.length < 50);

        // It ends at the route it would have waited on, never deferring towards its run cap; the guest, whose pin nothing
        // leads to, is kept, and its stop reported.
        expect(results.at(-1)).toMatchObject({ next: null, stopped: true });
        expect(results.every((result) => result.delayMs === undefined)).toBe(true);
        expect(keptGuests).toStrictEqual(["guest"]);
        expect(deletedGuests).toStrictEqual([]);
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
            schemaWithShardedTables([
                "user",
                "session",
                "account",
                "member",
                "twoFactor",
                "passkey",
                "shardRoutes",
                "shardActivity",
                "threadFollows",
                "sharedPinRoutes",
            ]) as never,
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

    /** The guest's deletion by a merge run holding `generation`, after the newest generation the shard saw is `seen`. */
    const deleteGuest = async (
        harness: ReturnType<typeof harnessWithUsers>,
        userId: string,
        { generation = 1, seen = generation }: { generation?: number; seen?: number } = {},
    ) =>
        await harness.run(async (context: any) => {
            await context.runMutation(noteMergeGeneration, { from: userId, generation: seen });

            return await context.runMutation(deleteMergedGuest, { generation, userId });
        });

    it("takes the guest's pins-left signal with it", async () => {
        const harness = harnessWithUsers();

        try {
            const guest = await insertUser(harness, true);

            await harness.run(
                async (context: any) =>
                    await context.db.insert("idempotencyClaims", {
                        claimedAt: 0,
                        expiresAt: IMPORT_MARKER_EXPIRES_AT,
                        key: guest,
                        result: "",
                        scope: MERGE_PINS_LEFT_SCOPE,
                        userId: guest,
                    }),
            );

            expect(await deleteGuest(harness, guest)).toStrictEqual({ deleted: true });
            expect(await harness.run(async (context: any) => await context.runMutation(pinsLeftShard, { ownerId: guest }))).toStrictEqual({
                abandoned: false,
                left: false,
            });
        } finally {
            harness.close();
        }
    });

    it("deletes a guest and its sessions", async () => {
        const harness = harnessWithUsers();

        try {
            const guest = await insertUser(harness, true);

            await harness.run(
                async (context: any) =>
                    await context.db.insert("session", { createdAt: 0, expiresAt: Date.now() + 60_000, token: "t", updatedAt: 0, userId: guest }),
            );

            const result = await deleteGuest(harness, guest);

            expect(result).toStrictEqual({ deleted: true });
            await expect(userExists(harness, guest)).resolves.toBe(false);
            const sessions = await harness.run(async (context: any) => await context.db.session.findMany({ where: { userId: guest } }));

            expect(sessions.page).toStrictEqual([]);
            // A second run (queue redelivery) finds nothing to do.
            await expect(deleteGuest(harness, guest)).resolves.toStrictEqual({
                deleted: false,
            });
        } finally {
            harness.close();
        }
    });

    it("lists, deletes and checks none of its rows, and keeps the guest, where every user runs on `__root__`", async () => {
        const harness = harnessWithUsers();

        try {
            const guest = await insertUser(harness, true);
            const other = (await harness.run(
                async (context: any) =>
                    await context.db.insert("threads", {
                        mode: "text",
                        model: "gpt-4o",
                        status: "active",
                        title: "someone else's",
                        updatedAt: 1,
                        userId: "other",
                    }),
            )) as string;
            const onRoot = async <T>(work: (context: any) => Promise<T>): Promise<T> => await runInShard("__root__", async () => await harness.run(work));

            await onRoot(async (context: any) => await context.runMutation(noteMergeGeneration, { from: guest, generation: 1 }));

            expect(
                await onRoot(async (context: any) => await context.runQuery(listShardRowsPage, { cursor: null, from: guest, table: "threads" })),
            ).toStrictEqual({
                continueCursor: null,
                isDone: true,
                page: [],
            });
            expect(await onRoot(async (context: any) => await context.runQuery(listShardRowsToClear, { from: guest, table: "threads" }))).toStrictEqual({
                digests: [],
                rows: [],
            });

            const row = await harness.run(async (context: any) => await context.db.get("threads", other));
            const { digests } = (await harness.run(
                async (context: any) => await context.runQuery(listShardRowsToClear, { from: guest, table: "threads" }),
            )) as {
                digests: string[];
            };

            expect(row).not.toBeNull();
            await onRoot(
                async (context: any) =>
                    await context.runMutation(deleteShardRows, { from: guest, generation: 1, rows: [{ digest: digests[0]!, id: other }], table: "threads" }),
            );
            expect(await harness.run(async (context: any) => await context.db.get("threads", other))).not.toBeNull();
            expect(await onRoot(async (context: any) => await firstTableWithGuestRows(context, guest))).toBeNull();
            expect(await onRoot(async (context: any) => await context.runMutation(deleteMergedGuest, { generation: 1, userId: guest }))).toStrictEqual({
                deleted: false,
                sharedShard: true,
            });
            await expect(userExists(harness, guest)).resolves.toBe(true);
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

            const result = await deleteGuest(harness, guest);

            expect(result).toStrictEqual({ deleted: false, followsRemain: true });
            await expect(userExists(harness, guest)).resolves.toBe(true);
        } finally {
            harness.close();
        }
    });

    it("keeps a guest that a shared pin route still names, and says so", async () => {
        const harness = harnessWithUsers();

        try {
            const guest = await insertUser(harness, true);

            await harness.run(async (context: any) => {
                const threadId = await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "T", userId: "owner" });

                await context.db.insert("sharedPinRoutes", { createdAt: 1, ownerId: "owner", threadId, userId: guest });
            });

            const result = await deleteGuest(harness, guest);

            expect(result).toStrictEqual({ deleted: false, pinsRemain: true });
            await expect(userExists(harness, guest)).resolves.toBe(true);
        } finally {
            harness.close();
        }
    });

    it("keeps a guest whose shard got a row after the merge cleared its table, and names the table", async () => {
        const harness = harnessWithUsers();

        try {
            const guest = await insertUser(harness, true);

            await harness.run(
                async (context: any) => await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "late", userId: guest }),
            );

            await expect(deleteGuest(harness, guest)).resolves.toStrictEqual({ deleted: false, rowsRemain: "threads" });
            await expect(userExists(harness, guest)).resolves.toBe(true);
        } finally {
            harness.close();
        }
    });

    it("deletes nothing for a merge run a later delivery has superseded", async () => {
        const harness = harnessWithUsers();

        try {
            const guest = await insertUser(harness, true);

            await expect(deleteGuest(harness, guest, { generation: 1, seen: 2 })).resolves.toStrictEqual({ deleted: false, fenced: true });
            await expect(userExists(harness, guest)).resolves.toBe(true);
        } finally {
            harness.close();
        }
    });

    it("never deletes an account that is not a guest", async () => {
        const harness = harnessWithUsers();

        try {
            const member = await insertUser(harness, false);
            const result = await deleteGuest(harness, member);

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

                const { generation } = await context.runMutation(acquireMergeLease, { from: "guest", to: "user" });

                await context.runMutation(importShardRows, { from: "guest", generation, rows: guestRows, table: "userSettings", to: "user" });

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

                const { rows } = await context.runQuery(listShardRowsToClear, { from: "guest", ownedBy: "guest", table: "userSettings" });

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

        expect(listClearCalls.find((args) => args.table === "userSettings")).toEqual({ from: "guest", ownedBy: "guest", table: "userSettings" });
        expect(listClearCalls.find((args) => args.table === "threads")).toEqual({ from: "guest", table: "threads" });
    });
});

/**
 * The guest's shard and the new account's as two harnesses, each running the real row procedures; the steps around
 * them (global rows, follows, the guest's deletion) are stubbed. `beforeClear` runs once, after the copy and before the
 * first clear call, on the guest's harness.
 */
describe("mergeGuestInto across two real shards", () => {
    const PROCEDURES: Record<string, { fn: unknown; kind: "mutation" | "query" }> = {
        abandonPinsLeft: { fn: abandonPinsLeft, kind: "mutation" },
        acquireMergeLease: { fn: acquireMergeLease, kind: "mutation" },
        beginMergeRun: { fn: beginMergeRun, kind: "mutation" },
        deleteShardRows: { fn: deleteShardRows, kind: "mutation" },
        dropImportMarkersPage: { fn: dropImportMarkersPage, kind: "mutation" },
        importShardRows: { fn: importShardRows, kind: "mutation" },
        listShardRowsPage: { fn: listShardRowsPage, kind: "query" },
        listShardRowsToClear: { fn: listShardRowsToClear, kind: "query" },
        noteMergeGeneration: { fn: noteMergeGeneration, kind: "mutation" },
        releaseMergeLease: { fn: releaseMergeLease, kind: "mutation" },
        resolvePinsLeft: { fn: resolvePinsLeft, kind: "mutation" },
    };

    const thread = (title: string, userId = "guest") => {
        return { mode: "text", model: "gpt-4o", status: "active", title, updatedAt: 1, userId };
    };

    const byId = (a: { _id: unknown }, b: { _id: unknown }) => String(a._id).localeCompare(String(b._id));

    const twoShards = () => {
        const shards = { guest: lunoraTest(schemaWithShardedTables([]) as never), user: lunoraTest(schemaWithShardedTables([]) as never) };
        let before: { hook: () => Promise<void>; name: string } | undefined;
        let failOnce: ((name: string, args: Record<string, unknown>) => boolean) | undefined;
        /** Each guest deletion: the table that still held a row of the guest's, or `null` when it went. */
        const guestDeletions: (string | null)[] = [];

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
                // The guest's user row is `.global()`, which this harness does not hold: the deletion's own shard check only.
                case "deleteMergedGuest": {
                    const left = (await shards.guest.run(async (context: any) => await firstTableWithGuestRows(context, args.userId as string))) as
                        | string
                        | null;

                    guestDeletions.push(left);

                    return (left === null ? { deleted: true } : { deleted: false, rowsRemain: left }) as never;
                }
                case "listSharedPinRoutesForExport": {
                    return { continueCursor: null, isDone: true, page: [] } as never;
                }
                case "nextSharedPinRoute": {
                    return null as never;
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
            guestDeletions,
            /** The lease of a delivery that died or paused lapses, as `MERGE_LEASE_MS` after its last write would. */
            lapseLease: async () => {
                await shards.user.run(async (context: any) => {
                    const lease = await context.db
                        .query("idempotencyClaims")
                        .withIndex("by_scope_key", (q: any) => q.eq("scope", MERGE_LEASE_SCOPE).eq("key", "guest"))
                        .first();
                    const { generation } = JSON.parse(lease.result) as { generation: number };

                    await context.db.patch("idempotencyClaims", lease._id, { result: JSON.stringify({ generation, until: 0 }) });
                });
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

    it("re-owns a moved thread and keeps its title as it was, even when the title is the guest's id", async () => {
        const merge = twoShards();

        try {
            const id = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("guest")))) as string;

            await mergeToEnd(merge.call, "guest", "user");

            expect(await merge.threadsOn("user")).toStrictEqual([{ _id: id, title: "guest", userId: "user" }]);
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
            await merge.lapseLease();

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
            await merge.lapseLease();

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

    it("stops an older delivery that read a row before another finished the merge, and never brings back a row the account deleted since", async () => {
        const merge = twoShards();

        try {
            const id = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("guest title")))) as string;
            let finished = false;

            // The older delivery has read the threads page; before its import lands, a later delivery runs the whole merge
            // and drops the markers, and the account deletes the moved row.
            merge.onceBefore("importShardRows", async () => {
                // It has paused past its lease, so the later delivery takes the merge over.
                await merge.lapseLease();
                await mergeToEnd(merge.call, "guest", "user");
                await merge.shards.user.run(async (context: any) => await context.db.delete("threads", id));
                finished = true;
            });

            // The older delivery's own chain of runs ends at the fence instead of importing what it read.
            await mergeToEnd(merge.call, "guest", "user");

            expect(finished).toBe(true);
            expect(await merge.threadsOn("user")).toStrictEqual([]);
            expect(await merge.threadsOn("guest")).toStrictEqual([]);

            const fence = await merge.shards.user.run(
                async (context: any) =>
                    await context.db
                        .query("idempotencyClaims")
                        .withIndex("by_scope_key", (q: any) => q.eq("scope", MERGE_FENCE_SCOPE).eq("key", "guest"))
                        .first(),
            );

            expect(fence).toMatchObject({ userId: "user" });
        } finally {
            merge.close();
        }
    });

    it("stops a delivery paused past its lease once a later one took the merge over, so its stale copy never replaces the later edit", async () => {
        const merge = twoShards();

        try {
            const id = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("first title")))) as string;
            let newer: MergeProgress | null = null;

            // The first delivery has read the row and pauses past its lease. The guest edits the row, and a redelivery takes
            // the lease over, imports the edit and deletes the guest's copy; its chain has more runs to go.
            merge.onceBefore("importShardRows", async () => {
                await merge.lapseLease();
                await merge.shards.guest.run(async (context: any) => await context.db.patch("threads", id, { title: "edited during the merge", updatedAt: 2 }));
                ({ next: newer } = await mergeGuestInto(merge.call, REFERENCES, "guest", "user", {
                    budget: MERGE_LEASE_CALLS + 3,
                    resume: { cursor: null, moved: 0, phase: "clear", run: 1, table: "threads" },
                }));
            });

            // The first delivery resumes with the old title in hand: its import is refused and its chain ends.
            await mergeToEnd(merge.call, "guest", "user");

            expect(newer).not.toBeNull();
            expect(await merge.threadsOn("user")).toStrictEqual([{ _id: id, title: "edited during the merge", userId: "user" }]);

            // The later delivery's chain carries the merge to its end.
            let resume: MergeProgress | null = newer;

            while (resume !== null) {
                ({ next: resume } = await mergeGuestInto(merge.call, REFERENCES, "guest", "user", { resume }));
            }

            expect(await merge.threadsOn("user")).toStrictEqual([{ _id: id, title: "edited during the merge", userId: "user" }]);
            expect(await merge.threadsOn("guest")).toStrictEqual([]);
        } finally {
            merge.close();
        }
    });

    it("moves a row written to an already cleared table before the guest's deletion, and deletes the guest only once its shard is empty", async () => {
        const merge = twoShards();

        try {
            const copied = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("before")))) as string;
            let late = "";

            merge.onceBefore("deleteMergedGuest", async () => {
                late = (await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("written after the clear")))) as string;
            });

            await mergeToEnd(merge.call, "guest", "user");

            expect(await merge.threadsOn("user")).toStrictEqual(
                [
                    { _id: copied, title: "before", userId: "user" },
                    { _id: late, title: "written after the clear", userId: "user" },
                ].toSorted(byId),
            );
            expect(await merge.threadsOn("guest")).toStrictEqual([]);
            expect(merge.guestDeletions).toStrictEqual(["threads", null]);
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

    describe("the stalled-merge sweep", () => {
        type Saved = { progress: MergeProgress | null; savedAt: number };

        /** The merge's progress record on the new account's shard, or `null`. */
        const progressOf = async (merge: ReturnType<typeof twoShards>): Promise<Saved | null> => {
            const row = (await merge.shards.user.run(
                async (context: any) =>
                    await context.db
                        .query("idempotencyClaims")
                        .withIndex("by_scope_key", (q: any) => q.eq("scope", MERGE_PROGRESS_SCOPE).eq("key", "guest"))
                        .first(),
            )) as { result: string; userId: string } | null;

            if (row === null) {
                return null;
            }

            expect(row.userId).toBe("user");

            return JSON.parse(row.result) as Saved;
        };

        /** The record last moved past the stall threshold, as it would with no job carrying the merge on. */
        const age = async (merge: ReturnType<typeof twoShards>) => {
            await merge.shards.user.run(async (context: any) => {
                const row = await context.db
                    .query("idempotencyClaims")
                    .withIndex("by_scope_key", (q: any) => q.eq("scope", MERGE_PROGRESS_SCOPE).eq("key", "guest"))
                    .first();
                const saved = JSON.parse(row.result) as Saved;

                await context.db.patch("idempotencyClaims", row._id, { result: JSON.stringify({ ...saved, savedAt: Date.now() - MERGE_STALL_MS - 1 }) });
            });
        };

        const sweep = async (merge: ReturnType<typeof twoShards>) => {
            transport.queued = [];

            return (await merge.shards.user.run(async (context: any) => await context.runMutation(resumeStalledGuestMerges, {}))) as {
                dropped: number;
                resumed: number;
            };
        };

        it("restarts a merge whose job died mid-copy from its saved progress, and it finishes with no row lost", async () => {
            const merge = twoShards();

            try {
                const ids = (await merge.shards.guest.run(async (context: any) =>
                    Promise.all(["a", "b", "c"].map(async (title) => await context.db.insert("threads", thread(title)))),
                )) as string[];

                merge.onceFail((name, args) => name === "importShardRows" && args.table === "threads");

                // The chain of runs, until one dies mid-copy on its last redelivery and nothing queues the merge again.
                let resume: MergeProgress | undefined;
                let died: unknown;

                while (died === undefined) {
                    try {
                        const { next } = await mergeGuestInto(merge.call, REFERENCES, "guest", "user", resume === undefined ? {} : { resume });

                        resume = next!;
                    } catch (error) {
                        died = error;
                    }
                }

                expect(String(died)).toContain("cut off");

                const saved = await progressOf(merge);

                expect(saved?.progress).toMatchObject({ phase: "copy", table: "threads" });
                // Not yet stalled: the sweep leaves a merge alone while its progress is fresh.
                expect(await sweep(merge)).toStrictEqual({ dropped: 0, resumed: 0 });

                await age(merge);

                expect(await sweep(merge)).toStrictEqual({ dropped: 0, resumed: 1 });
                expect(transport.queued).toStrictEqual([
                    {
                        args: { from: "guest", resume: saved?.progress, to: "user" },
                        options: { shardKey: "user" },
                        ref: expect.objectContaining({ __lunoraRef: expect.stringContaining("runGuestMerge") }),
                    },
                ]);
                // The record's time moved, so the next pass waits for the queued job instead of queueing a second.
                expect(await sweep(merge)).toStrictEqual({ dropped: 0, resumed: 0 });

                expect(transport.queued).toStrictEqual([]);

                await mergeToEnd(merge.call, "guest", "user", { resume: saved!.progress! });

                const moved = await merge.threadsOn("user");

                expect(moved.map((row) => row._id)).toStrictEqual(ids.toSorted((a, b) => a.localeCompare(b)));
                expect(await merge.threadsOn("guest")).toStrictEqual([]);
                expect(await progressOf(merge)).toBeNull();
            } finally {
                merge.close();
            }
        });

        it("restarts a merge whose first job never took the lease, from the start", async () => {
            const merge = twoShards();

            try {
                await merge.shards.user.run(async (context: any) => await context.runMutation(recordGuestMerge, { from: "guest", to: "user" }));
                await age(merge);

                expect(await sweep(merge)).toStrictEqual({ dropped: 0, resumed: 1 });
                expect(transport.queued.map((job) => job.args)).toStrictEqual([{ from: "guest", to: "user" }]);
            } finally {
                merge.close();
            }
        });

        it("never restarts a completed merge, and drops a record one left behind", async () => {
            const merge = twoShards();

            try {
                await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("a")));
                await mergeToEnd(merge.call, "guest", "user");

                expect(await progressOf(merge)).toBeNull();

                // A late hand-over or a stale delivery writes no record once the fence is here.
                await merge.shards.user.run(async (context: any) => await context.runMutation(recordGuestMerge, { from: "guest", to: "user" }));

                expect(await progressOf(merge)).toBeNull();

                // One left from before the fence (a release that failed) is dropped, never queued.
                await merge.shards.user.run(
                    async (context: any) =>
                        await context.db.insert("idempotencyClaims", {
                            claimedAt: 1,
                            expiresAt: Date.now() + 60_000,
                            key: "guest",
                            result: JSON.stringify({ progress: null, savedAt: 1 }),
                            scope: MERGE_PROGRESS_SCOPE,
                            userId: "user",
                        }),
                );

                expect(await sweep(merge)).toStrictEqual({ dropped: 1, resumed: 0 });
                expect(transport.queued).toStrictEqual([]);
                expect(await progressOf(merge)).toBeNull();
            } finally {
                merge.close();
            }
        });

        it("leaves a merge alone while a run holds its lease, so it is never run twice", async () => {
            const merge = twoShards();

            try {
                await merge.shards.user.run(async (context: any) => await context.runMutation(acquireMergeLease, { from: "guest", to: "user" }));
                await age(merge);

                expect(await sweep(merge)).toStrictEqual({ dropped: 0, resumed: 0 });
                expect(transport.queued).toStrictEqual([]);

                // Once that run's lease lapses with no word from it, the merge is restarted.
                await merge.lapseLease();

                expect(await sweep(merge)).toStrictEqual({ dropped: 0, resumed: 1 });
            } finally {
                merge.close();
            }
        });

        it("restarts no merge while either account is being erased, and drops its record", async () => {
            for (const erased of ["guest", "user"]) {
                const merge = twoShards();

                try {
                    await merge.shards.user.run(async (context: any) => await context.runMutation(recordGuestMerge, { from: "guest", to: "user" }));
                    await merge.shards.user.run(
                        async (context: any) => await context.db.insert("accountMoves", { createdAt: 1, kind: "erasing", userId: erased }),
                    );
                    await age(merge);

                    expect(await sweep(merge)).toStrictEqual({ dropped: 1, resumed: 0 });
                    // No restart: only the note to the guest's shard that its merge stopped before its routes moved.
                    expect(transport.queued.map((job) => [job.ref.__lunoraRef, job.args])).toStrictEqual([
                        ["lib_account_merge:abandonPinsLeft", { from: "guest" }],
                    ]);
                    expect(await progressOf(merge)).toBeNull();
                } finally {
                    merge.close();
                }
            }
        });

        it("drops the record of a merge an erasure stopped at its run's start", async () => {
            const merge = twoShards();

            try {
                await merge.shards.user.run(async (context: any) => await context.runMutation(recordGuestMerge, { from: "guest", to: "user" }));
                await merge.shards.user.run(async (context: any) => await context.db.insert("accountMoves", { createdAt: 1, kind: "erasing", userId: "user" }));

                expect(await mergeGuestInto(merge.call, REFERENCES, "guest", "user")).toStrictEqual({ moved: 0, next: null, stopped: true });
                expect(await progressOf(merge)).toBeNull();
            } finally {
                merge.close();
            }
        });

        /** Every claim on the new account's shard, as an erasure that has finished leaves none tagged with it. */
        const userClaims = async (merge: ReturnType<typeof twoShards>) =>
            (await merge.shards.user.run(async (context: any) => await context.db.query("idempotencyClaims").take(100))) as {
                key: string;
                scope: string;
                userId?: string;
            }[];

        /** The new account's erasure, finished: its rows and every claim tagged with it are gone, and so is its `user` row. */
        const eraseNewAccount = async (merge: ReturnType<typeof twoShards>) => {
            await merge.shards.user.run(async (context: any) => {
                for (const table of ["threads", "idempotencyClaims", "accountMoves"]) {
                    const rows = await context.db.query(table).take(100);

                    for (const row of rows) {
                        await context.db.delete(table, row._id);
                    }
                }
            });
            goneAccounts.add("user");
        };

        it("writes nothing onto an erased account's shard from a late job, and keeps the guest, however often it comes", async () => {
            const merge = twoShards();

            try {
                await merge.shards.guest.run(async (context: any) =>
                    Promise.all(["a", "b", "c"].map(async (title) => await context.db.insert("threads", thread(title)))),
                );

                // A run moves part of the merge and queues its successor; the new account's erasure then finishes.
                const { next } = await mergeGuestInto(merge.call, REFERENCES, "guest", "user", { budget: MERGE_LEASE_CALLS + 3 });

                expect(next).not.toBeNull();

                await eraseNewAccount(merge);

                // The delayed successor, a busy-requeued duplicate and a first job: each ends the merge, none takes a lease.
                for (const resume of [next!, next!, undefined]) {
                    expect(await mergeGuestInto(merge.call, REFERENCES, "guest", "user", resume === undefined ? {} : { resume })).toStrictEqual({
                        moved: resume?.moved ?? 0,
                        next: null,
                        stopped: true,
                    });
                }

                // Sweeps after them find nothing to restart, however many pass.
                for (let pass = 0; pass < 3; pass += 1) {
                    expect(await sweep(merge)).toStrictEqual({ dropped: 0, resumed: 0 });
                    expect(transport.queued).toStrictEqual([]);
                }

                expect(await merge.threadsOn("user")).toStrictEqual([]);
                const kept = await merge.threadsOn("guest");

                expect(kept.map((row) => String(row.title)).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["a", "b", "c"]);
                expect(merge.guestDeletions).toStrictEqual([]);
                expect(await userClaims(merge)).toStrictEqual([]);

                const moves = (await merge.shards.user.run(async (context: any) => await context.db.query("accountMoves").take(10))) as { kind: string }[];

                // The guest's merging marker ended with the merge, so its own pin writes go on.
                expect(moves).toStrictEqual([]);
            } finally {
                goneAccounts.delete("user");
                merge.close();
            }
        });

        it("ends a run whose new account was erased after it took the lease, leaving no lease or progress behind", async () => {
            const merge = twoShards();

            try {
                await merge.shards.guest.run(async (context: any) => await context.db.insert("threads", thread("a")));
                merge.onceBefore("beginMergeRun", async () => {
                    await eraseNewAccount(merge);
                });

                expect(await mergeGuestInto(merge.call, REFERENCES, "guest", "user")).toStrictEqual({ moved: 0, next: null, stopped: true });
                expect(await merge.threadsOn("user")).toStrictEqual([]);
                expect(await merge.threadsOn("guest")).toHaveLength(1);
                expect(merge.guestDeletions).toStrictEqual([]);
                expect(await userClaims(merge)).toStrictEqual([]);
            } finally {
                goneAccounts.delete("user");
                merge.close();
            }
        });

        it("drops, never queues, a stalled merge whose new account is gone", async () => {
            const merge = twoShards();

            try {
                await merge.shards.user.run(async (context: any) => await context.runMutation(recordGuestMerge, { from: "guest", to: "user" }));
                await age(merge);
                goneAccounts.add("user");

                expect(await sweep(merge)).toStrictEqual({ dropped: 1, resumed: 0 });
                expect(transport.queued.map((job) => [job.ref.__lunoraRef, job.args])).toStrictEqual([
                    ["lib_account_merge:abandonPinsLeft", { from: "guest" }],
                ]);
                expect(await progressOf(merge)).toBeNull();
                expect(await sweep(merge)).toStrictEqual({ dropped: 0, resumed: 0 });
            } finally {
                goneAccounts.delete("user");
                merge.close();
            }
        });
    });
});

/** The merge's progress record on the new account's shard, or null. */
const progressRecordOf = async (harness: ReturnType<typeof lunoraTest>, from: string) =>
    await harness.run(
        async (context: any) =>
            await context.db
                .query("idempotencyClaims")
                .withIndex("by_scope_key", (q: any) => q.eq("scope", MERGE_PROGRESS_SCOPE).eq("key", from))
                .first(),
    );

/** One run's start under its own lease, as a delivery makes it: take the lease, begin the run, give the lease back. */
const beginRunOf = async (harness: ReturnType<typeof lunoraTest>, from = "guest", to = "user") =>
    await harness.run(async (context: any) => {
        const { generation } = (await context.runMutation(acquireMergeLease, { from, to })) as { generation: number };
        const begun = await context.runMutation(beginMergeRun, { from, generation, to });

        await context.runMutation(releaseMergeLease, { from, generation });

        return begun;
    });

describe("the account-move markers a merge holds", () => {
    const movesOf = async (harness: ReturnType<typeof lunoraTest>, userId: string) =>
        (
            (await harness.run(async (context: any) => await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } }))) as {
                page: { kind: string }[];
            }
        ).page.map((row) => row.kind);

    it("marks the guest as merging and the new account as importing at each run, and drops both with the last page of import markers", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const begun = await beginRunOf(harness);

            expect(begun).toStrictEqual({ cleanup: false, finished: false, pinWritesUntil: null, stopped: false, superseded: false });
            expect(await movesOf(harness, "guest")).toStrictEqual(["merging"]);
            expect(await movesOf(harness, "user")).toStrictEqual(["importing"]);

            // A later run renews the markers instead of adding a second pair.
            await beginRunOf(harness);

            expect(await movesOf(harness, "guest")).toStrictEqual(["merging"]);

            const { generation } = (await harness.run(async (context: any) => await context.runMutation(acquireMergeLease, { from: "guest", to: "user" }))) as {
                generation: number;
            };
            const dropped = await harness.run(
                async (context: any) => await context.runMutation(dropImportMarkersPage, { from: "guest", generation, to: "user" }),
            );

            expect(dropped).toStrictEqual({ fenced: false, hasMore: false });
            expect(await movesOf(harness, "guest")).toStrictEqual([]);
            expect(await movesOf(harness, "user")).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("stops the merge and drops its markers when either account is being erased, keeping the erasure's own", async () => {
        for (const erased of ["guest", "user"]) {
            const harness = lunoraTest(schemaWithShardedTables([]) as never);

            try {
                await harness.run(async (context: any) => await context.db.insert("accountMoves", { createdAt: 1, kind: "erasing", userId: erased }));

                const begun = await beginRunOf(harness);

                expect(begun).toStrictEqual({ cleanup: false, finished: false, pinWritesUntil: null, stopped: true, superseded: false });
                expect(await movesOf(harness, erased)).toStrictEqual(["erasing"]);
                expect(await movesOf(harness, erased === "guest" ? "user" : "guest")).toStrictEqual([]);
            } finally {
                harness.close();
            }
        }
    });

    it("reports a guest pin write still in flight, so the run waits for it", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const until = Date.now() + 60_000;

            await harness.run(async (context: any) => await context.db.insert("pinWriteLeases", { expiresAt: until, userId: "guest" }));

            const begun = await beginRunOf(harness);

            expect(begun).toStrictEqual({ cleanup: false, finished: false, pinWritesUntil: until, stopped: false, superseded: false });
        } finally {
            harness.close();
        }
    });

    it("marks nothing for a delivery that arrives after the merge finished", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(
                async (context: any) =>
                    await context.db.insert("idempotencyClaims", {
                        claimedAt: 1,
                        expiresAt: Date.now() + 60_000,
                        key: "guest",
                        scope: MERGE_FENCE_SCOPE,
                        userId: "user",
                    }),
            );

            const begun = await beginRunOf(harness);

            expect(begun).toStrictEqual({ cleanup: false, finished: true, pinWritesUntil: null, stopped: false, superseded: false });
            expect(await movesOf(harness, "guest")).toStrictEqual([]);
            expect(await movesOf(harness, "user")).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("leaves the markers alone for an older delivery that resumes after a newer one took the lease", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        /** The account-move markers, by what each is: the read has no order. */
        const markersOf = async () => {
            const { page } = (await harness.run(async (context: any) => await context.db.accountMoves.findMany({ consistency: "primary", where: {} }))) as {
                page: { createdAt: number; kind: string; userId: string }[];
            };
            const markers = page.map(({ createdAt, kind, userId }) => {
                return { createdAt, kind, userId };
            });

            return markers.toSorted((a, b) => `${a.userId}:${a.kind}`.localeCompare(`${b.userId}:${b.kind}`));
        };

        try {
            const older = (await harness.run(async (context: any) => await context.runMutation(acquireMergeLease, { from: "guest", to: "user" }))) as {
                generation: number;
            };

            // The older delivery pauses; its lease is given back and a newer one takes the merge on and marks both accounts.
            await harness.run(async (context: any) => await context.runMutation(releaseMergeLease, { from: "guest", generation: older.generation }));

            const newer = (await harness.run(async (context: any) => await context.runMutation(acquireMergeLease, { from: "guest", to: "user" }))) as {
                generation: number;
            };

            await harness.run(async (context: any) => await context.runMutation(beginMergeRun, { from: "guest", generation: newer.generation, to: "user" }));

            const before = await markersOf();

            expect(before.map(({ kind, userId }) => `${userId}:${kind}`).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
                "guest:merging",
                "user:importing",
            ]);

            // An erasure of the guest begins: the older delivery, resuming, would stop the merge and drop the newer run's markers.
            await harness.run(async (context: any) => await context.db.insert("accountMoves", { createdAt: 1, kind: "erasing", userId: "guest" }));

            const begun = await harness.run(
                async (context: any) => await context.runMutation(beginMergeRun, { from: "guest", generation: older.generation, to: "user" }),
            );

            expect(begun).toStrictEqual({ cleanup: false, finished: false, pinWritesUntil: null, stopped: false, superseded: true });
            expect(await markersOf()).toStrictEqual(
                [...before, { createdAt: 1, kind: "erasing", userId: "guest" }].toSorted((a, b) =>
                    `${a.userId}:${a.kind}`.localeCompare(`${b.userId}:${b.kind}`),
                ),
            );
            expect(await progressRecordOf(harness, "guest")).not.toBeNull();
        } finally {
            harness.close();
        }
    });

    it("keeps the account's importing marker, and its erasure waiting, while another guest's merge into it is still running", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const finish = async (from: string) =>
            await harness.run(async (context: any) => {
                const { generation } = (await context.runMutation(acquireMergeLease, { from, to: "user" })) as { generation: number };
                const dropped = await context.runMutation(dropImportMarkersPage, { from, generation, to: "user" });

                await context.runMutation(releaseMergeLease, { from, generation });

                return dropped;
            });
        const waitOf = async () => (await harness.run(async (context: any) => await eraseWaitUntil(context, "user", Date.now()))) as number | null;

        try {
            await beginRunOf(harness, "guest-a");
            await beginRunOf(harness, "guest-b");

            expect(await movesOf(harness, "user")).toStrictEqual(["importing"]);

            expect(await finish("guest-a")).toStrictEqual({ fenced: false, hasMore: false });

            // The first merge's end leaves the second's guard: the account's erasure still waits.
            expect(await movesOf(harness, "guest-a")).toStrictEqual([]);
            expect(await movesOf(harness, "guest-b")).toStrictEqual(["merging"]);
            expect(await movesOf(harness, "user")).toStrictEqual(["importing"]);
            expect(await waitOf()).not.toBeNull();

            // The finished merge is over by its own state, not the shared marker: no cleanup left, its record gone, so the
            // stalled-merge sweep does not restart it.
            expect(await beginRunOf(harness, "guest-a")).toStrictEqual({
                cleanup: false,
                finished: true,
                pinWritesUntil: null,
                stopped: false,
                superseded: false,
            });
            expect(await progressRecordOf(harness, "guest-a")).toBeNull();
            expect(await progressRecordOf(harness, "guest-b")).not.toBeNull();

            // A restarted end of the finished merge still leaves the other's guard.
            await finish("guest-a");

            expect(await movesOf(harness, "user")).toStrictEqual(["importing"]);

            // The second merge's run renews its guard; once it ends too, the account's marker goes and the erasure may sweep.
            await beginRunOf(harness, "guest-b");
            await finish("guest-b");

            expect(await movesOf(harness, "user")).toStrictEqual([]);
            expect(await waitOf()).toBeNull();
        } finally {
            harness.close();
        }
    });

    it("gives the lease back when a run throws, so its redelivery takes the merge on instead of finding it busy", async () => {
        const { call } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        const made: string[] = [];

        await expect(
            mergeGuestInto(
                async (reference, args, shardKey) => {
                    const name = reference.__lunoraRef.split(":", 2)[1]!;

                    made.push(name);

                    // The first step's read fails, after the lease was taken.
                    if (name === "listShardRowsPage") {
                        throw new Error("the merge job was cut off");
                    }

                    return await call(reference, args, shardKey);
                },
                REFERENCES,
                "guest",
                "user",
            ),
        ).rejects.toThrow("cut off");

        expect(made.at(-1)).toBe("releaseMergeLease");
    });

    it("touches no row of a merge an erasure stopped, and gives the lease back", async () => {
        const { call, shards } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        const made: string[] = [];

        const result = await mergeGuestInto(
            async (reference, args, shardKey) => {
                const name = reference.__lunoraRef.split(":", 2)[1]!;

                made.push(name);

                return name === "beginMergeRun" ? ({ finished: false, pinWritesUntil: null, stopped: true } as never) : await call(reference, args, shardKey);
            },
            REFERENCES,
            "guest",
            "user",
        );

        expect(result).toStrictEqual({ moved: 0, next: null, stopped: true });
        // Last, on the guest's shard: a pins-left signal of its, if any, says the merge stopped before its routes moved.
        expect(made).toStrictEqual(["acquireMergeLease", "noteMergeGeneration", "beginMergeRun", "releaseMergeLease", "abandonPinsLeft"]);
        expect(shards.get("guest")?.get("threads")).toHaveLength(1);
    });

    it("queues the same run again for when a guest pin write in flight has run out", async () => {
        const { call } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
        transport.call = async (reference, args, shardKey) =>
            reference.__lunoraRef.endsWith(":beginMergeRun")
                ? ({ finished: false, pinWritesUntil: 1_000_000 + 20_000, stopped: false } as never)
                : await call(reference, args, shardKey);
        transport.queued = [];

        try {
            const resume: MergeProgress = { cursor: null, moved: 3, phase: "pins", run: 2, table: "" };
            const result = await harness.action(async (context: any) => await context.runAction(runGuestMerge, { from: "guest", resume, to: "user" }));

            expect(result).toStrictEqual({ done: false, moved: 3 });
            expect(transport.queued).toStrictEqual([
                { args: { from: "guest", resume, to: "user" }, options: { delayMs: 21_000, shardKey: "user" }, ref: expect.objectContaining({}) },
            ]);
        } finally {
            vi.useRealTimers();
            harness.close();
        }
    });

    it("ends a merge across two real shards with no account-move marker left", async () => {
        const PROCEDURES: Record<string, unknown> = {
            acquireMergeLease,
            beginMergeRun,
            deleteShardRows,
            dropImportMarkersPage,
            importShardRows,
            listShardRowsPage,
            listShardRowsToClear,
            noteMergeGeneration,
            releaseMergeLease,
            resolvePinsLeft,
        };
        const QUERIES = new Set(["listShardRowsPage", "listShardRowsToClear"]);
        const shards = { guest: lunoraTest(schemaWithShardedTables([]) as never), user: lunoraTest(schemaWithShardedTables([]) as never) };
        const call: ShardCall = async (reference, args, shardKey) => {
            const name = reference.__lunoraRef.split(":", 2)[1]!;

            switch (name) {
                case "deleteMergedGuest": {
                    return { deleted: true } as never;
                }
                case "listSharedPinRoutesForExport": {
                    return { continueCursor: null, isDone: true, page: [] } as never;
                }
                case "nextSharedPinRoute": {
                    return null as never;
                }
                case "reassignGlobalRows": {
                    return { done: true, reassigned: 0 } as never;
                }
                case "reassignThreadFollowsPage": {
                    return { hasMore: false, moved: 0 } as never;
                }
                default: {
                    const procedure = PROCEDURES[name];

                    return (await shards[shardKey as keyof typeof shards].run(async (context: any) =>
                        QUERIES.has(name) ? await context.runQuery(procedure, args) : await context.runMutation(procedure, args),
                    )) as never;
                }
            }
        };

        try {
            await shards.guest.run(
                async (context: any) =>
                    await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "a", updatedAt: 1, userId: "guest" }),
            );

            await mergeToEnd(call, "guest", "user");

            expect(await movesOf(shards.user, "guest")).toStrictEqual([]);
            expect(await movesOf(shards.user, "user")).toStrictEqual([]);
        } finally {
            shards.guest.close();
            shards.user.close();
        }
    });
});

describe("a merge's end past the fence", () => {
    const PROCEDURES: Record<string, unknown> = { acquireMergeLease, beginMergeRun, dropImportMarkersPage, noteMergeGeneration, releaseMergeLease };

    it("drops every import marker and both account-move markers over several runs once the fence is in, renewing neither", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const call: ShardCall = async (reference, args) => {
            const name = reference.__lunoraRef.split(":", 2)[1]!;

            return (await harness.run(async (context: any) => await context.runMutation(PROCEDURES[name], args))) as never;
        };
        const claimsOf = async (scope: string) =>
            (await harness.run(
                async (context: any) =>
                    await context.db
                        .query("idempotencyClaims")
                        .withIndex("by_scope_key", (q: any) => q.eq("scope", scope))
                        .collect(),
            )) as { key: string }[];

        try {
            await harness.run(async (context: any) => {
                const expiresAt = Date.now() + 60_000;

                await context.db.insert("idempotencyClaims", { claimedAt: 1, expiresAt, key: "guest", scope: MERGE_FENCE_SCOPE, userId: "user" });

                // More than one page of markers (a page drops 500): the fence went in with the first, the rest are left.
                for (let index = 0; index < 600; index += 1) {
                    await context.db.insert("idempotencyClaims", {
                        claimedAt: 1,
                        expiresAt,
                        key: `guest:threads:${String(index)}`,
                        scope: IMPORT_MARKER_SCOPE,
                        userId: "user",
                    });
                }

                await context.db.insert("accountMoves", { createdAt: 1, kind: "merging", userId: "guest" });
                await context.db.insert("accountMoves", { createdAt: 1, kind: "importing", userId: "user" });
            });

            const begun = await beginRunOf(harness);

            expect(begun).toStrictEqual({ cleanup: true, finished: true, pinWritesUntil: null, stopped: false, superseded: false });

            // A continuation from a stale progress, one markers page per run: the phase is the markers', whatever it says.
            const { runs } = await mergeToEnd(call, "guest", "user", {
                budget: MERGE_LEASE_CALLS + 1,
                resume: { cursor: null, moved: 0, phase: "copy", run: 3, table: "threads" },
            });

            expect(runs.map((run) => run.phase)).toStrictEqual(["markers"]);
            expect(await claimsOf(IMPORT_MARKER_SCOPE)).toStrictEqual([]);
            expect(await claimsOf(MERGE_PROGRESS_SCOPE)).toStrictEqual([]);
            expect(await claimsOf(MERGE_FENCE_SCOPE)).toHaveLength(1);

            const moves = (await harness.run(async (context: any) => await context.db.accountMoves.findMany({ consistency: "primary", where: {} }))) as {
                page: unknown[];
            };

            expect(moves.page).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });

    it("keeps a fenced merge's record while its markers are left, so the sweep restarts the end", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => {
                const expiresAt = Date.now() + 60_000;

                await context.db.insert("idempotencyClaims", { claimedAt: 1, expiresAt, key: "guest", scope: MERGE_FENCE_SCOPE, userId: "user" });
                await context.db.insert("idempotencyClaims", { claimedAt: 1, expiresAt, key: "guest:threads:1", scope: IMPORT_MARKER_SCOPE, userId: "user" });
            });

            const { generation } = (await harness.run(async (context: any) => await context.runMutation(acquireMergeLease, { from: "guest", to: "user" }))) as {
                generation: number;
            };
            const progress: MergeProgress = { cursor: null, moved: 0, phase: "markers", run: 4, table: "" };

            await harness.run(async (context: any) => await context.runMutation(releaseMergeLease, { from: "guest", generation, progress }));

            const record = await harness.run(
                async (context: any) =>
                    await context.db
                        .query("idempotencyClaims")
                        .withIndex("by_scope_key", (q: any) => q.eq("scope", MERGE_PROGRESS_SCOPE).eq("key", "guest"))
                        .first(),
            );

            expect(JSON.parse((record as { result: string }).result).progress).toStrictEqual(progress);
        } finally {
            harness.close();
        }
    });
});

describe("how a run ends", () => {
    it("gives the lease back, with where it was, when its generation note fails before any step", async () => {
        const { call } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        const releases: Record<string, unknown>[] = [];
        const resume: MergeProgress = { cursor: null, moved: 2, phase: "clear", run: 5, table: "threads" };

        await expect(
            mergeGuestInto(
                async (reference, args, shardKey) => {
                    const name = reference.__lunoraRef.split(":", 2)[1]!;

                    if (name === "noteMergeGeneration") {
                        throw new Error("the guest's shard is unreachable");
                    }

                    if (name === "releaseMergeLease") {
                        releases.push(args);
                    }

                    return await call(reference, args, shardKey);
                },
                REFERENCES,
                "guest",
                "user",
                { resume },
            ),
        ).rejects.toThrow("unreachable");

        // Saved one run on, so a merge that fails here every time still reaches its run cap.
        expect(releases).toStrictEqual([{ from: "guest", generation: 1, progress: { ...resume, run: 6 } }]);
    });

    it("says a delivery was superseded, not done, when another one finished the merge or holds a newer lease", async () => {
        const answers: Record<string, unknown>[] = [
            { importShardRows: { fenced: true, imported: 0, present: [] } },
            { noteMergeGeneration: { current: false } },
            { beginMergeRun: { cleanup: false, finished: true, pinWritesUntil: null, stopped: false } },
        ];

        for (const answer of answers) {
            // The first table the copy reaches, so the fenced import comes within the run.
            const { call } = fakeShards({ guest: { acpSessions: [{ _id: "a1", userId: "guest" }] } });
            const result = await mergeGuestInto(
                async (reference, args, shardKey) => {
                    const name = reference.__lunoraRef.split(":", 2)[1]!;

                    return name in answer ? (answer[name] as never) : await call(reference, args, shardKey);
                },
                REFERENCES,
                "guest",
                "user",
            );

            expect(result).toMatchObject({ next: null, superseded: true });
        }
    });

    it("reports a finished merge as not superseded", async () => {
        const { call } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        let last: Awaited<ReturnType<typeof mergeGuestInto>> | undefined;
        let resume: MergeProgress | undefined;

        for (;;) {
            last = await mergeGuestInto(call, REFERENCES, "guest", "user", resume === undefined ? {} : { resume });

            if (last.next === null) {
                break;
            }

            resume = last.next;
        }

        expect(last.superseded).toBeUndefined();
    });
});

describe("listShardRowsPage", () => {
    it("cuts a page of large rows at the cross-shard byte budget, and the next page starts right after it", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const big = "x".repeat(300 * 1024);

        try {
            const ids = (await harness.run(async (context: any) => {
                const inserted: string[] = [];

                for (const title of ["a", "b", "c"]) {
                    inserted.push(
                        await context.db.insert("threads", {
                            mode: "text",
                            model: "gpt-4o",
                            status: "active",
                            title: `${title}${big}`,
                            updatedAt: 1,
                            userId: "guest",
                        }),
                    );
                }

                return inserted;
            })) as string[];
            const seen: string[] = [];
            let cursor: string | null = null;

            for (;;) {
                const page = (await harness.run(
                    async (context: any) => await context.runQuery(listShardRowsPage, { cursor, from: "guest", table: "threads" }),
                )) as { continueCursor: string | null; isDone: boolean; page: { _id: string }[] };

                // Two of these rows already pass the budget, so each page holds one.
                expect(page.page).toHaveLength(1);

                seen.push(...page.page.map((row) => row._id));

                if (page.isDone || page.continueCursor === null) {
                    break;
                }

                ({ continueCursor: cursor } = page);
            }

            expect(seen.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(ids.toSorted((a, b) => a.localeCompare(b)));
        } finally {
            harness.close();
        }
    });
});

describe("the merge's progress record", () => {
    const recordOf = async (harness: ReturnType<typeof lunoraTest>, from = "guest") => {
        const row = (await harness.run(
            async (context: any) =>
                await context.db
                    .query("idempotencyClaims")
                    .withIndex("by_scope_key", (q: any) => q.eq("scope", MERGE_PROGRESS_SCOPE).eq("key", from))
                    .first(),
        )) as { result: string } | null;

        return row === null ? null : (JSON.parse(row.result) as { progress: MergeProgress | null; savedAt: number });
    };
    const acquire = async (harness: ReturnType<typeof lunoraTest>, to = "user") =>
        (await harness.run(async (context: any) => await context.runMutation(acquireMergeLease, { from: "guest", to }))) as {
            generation: number;
            saved?: MergeProgress;
        };
    const release = async (harness: ReturnType<typeof lunoraTest>, generation: number, progress: MergeProgress) =>
        await harness.run(async (context: any) => await context.runMutation(releaseMergeLease, { from: "guest", generation, progress }));

    it("never moves back: a stale release keeps the later run's record, and the next lease hands that record out", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const later: MergeProgress = { cursor: "c", moved: 40, phase: "clear", run: 5, table: "threads" };
            const first = await acquire(harness);

            await release(harness, first.generation, later);

            // An older delivery takes the next lease: it is told where the merge is.
            const stale = await acquire(harness);

            expect(stale.saved).toStrictEqual(later);

            // Should it still give back an older position, the record stays.
            await release(harness, stale.generation, { cursor: null, moved: 3, phase: "copy", run: 2, table: "threads" });

            const kept = await recordOf(harness);

            expect(kept?.progress).toStrictEqual(later);

            const next = await acquire(harness);

            await release(harness, next.generation, { ...later, run: 6 });

            const moved = await recordOf(harness);

            expect(moved?.progress).toStrictEqual({ ...later, run: 6 });
        } finally {
            harness.close();
        }
    });

    it("notes the new account's shard as active with each save, so housekeeping visits an idle account's shard", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        // Its own key: the activity note is throttled per isolate and key.
        const to = "idle-account-of-a-stalled-merge";

        try {
            await acquire(harness, to);

            const census = (await harness.run(
                async (context: any) => await context.db.shardActivity.findMany({ consistency: "primary", where: { shardKey: to } }),
            )) as { page: { lastActiveAt: number }[] };

            expect(census.page).toHaveLength(1);
            expect(census.page[0]!.lastActiveAt).toBeGreaterThan(Date.now() - 60_000);
        } finally {
            harness.close();
        }
    });

    it("goes on from the record when the delivery's own payload is behind it", async () => {
        const { call } = fakeShards({ guest: { threads: [{ _id: "t1", userId: "guest" }] } });
        const saved: MergeProgress = { cursor: null, moved: 7, phase: "markers", run: 9, table: "" };
        const made: string[] = [];
        const result = await mergeGuestInto(
            async (reference, args, shardKey) => {
                const name = reference.__lunoraRef.split(":", 2)[1]!;

                made.push(name);

                return name === "acquireMergeLease" ? ({ generation: 2, saved } as never) : await call(reference, args, shardKey);
            },
            REFERENCES,
            "guest",
            "user",
            { resume: { cursor: null, moved: 0, phase: "copy", run: 2, table: "threads" } },
        );

        // The copy the payload names is not run again: the record's markers phase is all that is left.
        expect(made).not.toContain("listShardRowsPage");
        expect(made).toContain("dropImportMarkersPage");
        expect(result).toStrictEqual({ moved: 7, next: null });
    });

    it("fails at the run cap the record has reached, giving the lease back", async () => {
        const { call } = fakeShards({});
        const made: string[] = [];

        await expect(
            mergeGuestInto(
                async (reference, args, shardKey) => {
                    const name = reference.__lunoraRef.split(":", 2)[1]!;

                    made.push(name);

                    return name === "acquireMergeLease"
                        ? ({ generation: 2, saved: { cursor: null, moved: 0, phase: "copy", run: 10, table: "threads" } } as never)
                        : await call(reference, args, shardKey);
                },
                REFERENCES,
                "guest",
                "user",
                { maxRuns: 10, resume: { cursor: null, moved: 0, phase: "copy", run: 3, table: "threads" } },
            ),
        ).rejects.toThrow("did not finish in 10 runs");
        expect(made).toStrictEqual(["acquireMergeLease", "releaseMergeLease", "abandonPinsLeft"]);
    });

    it("lets the sweep reach a stalled merge behind more fresh records than one pass reads", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const sweep = async () =>
            (await harness.run(async (context: any) => await context.runMutation(resumeStalledGuestMerges, {}))) as { dropped: number; resumed: number };

        try {
            await harness.run(async (context: any) => {
                const now = Date.now();
                const record = (key: string, savedAt: number) => {
                    return {
                        claimedAt: now,
                        expiresAt: now + 60_000,
                        key,
                        result: JSON.stringify({ progress: null, savedAt }),
                        scope: MERGE_PROGRESS_SCOPE,
                        userId: "user",
                    };
                };

                for (let index = 0; index < 40; index += 1) {
                    await context.db.insert("idempotencyClaims", record(`fresh-${String(index).padStart(2, "0")}`, now));
                }

                await context.db.insert("idempotencyClaims", record("stalled", now - MERGE_STALL_MS - 1));
            });
            transport.queued = [];

            // The first pass reads only fresh records; the next reads on after them and finds the stalled one.
            expect(await sweep()).toStrictEqual({ dropped: 0, resumed: 0 });
            expect(await sweep()).toStrictEqual({ dropped: 0, resumed: 1 });
            expect(transport.queued.map((job) => job.args)).toStrictEqual([{ from: "stalled", to: "user" }]);

            // That pass reached the last record, so the next starts from the first again.
            transport.queued = [];

            expect(await sweep()).toStrictEqual({ dropped: 0, resumed: 0 });
            expect(transport.queued).toStrictEqual([]);
        } finally {
            harness.close();
        }
    });
});

describe("pins the clear moves off a guest's shard", () => {
    it("marks the shard once its pins are deleted there, so another merge's pin pass waits for their route", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            const pin = (await harness.run(async (context: any) => {
                const threadId = await context.db.insert("threads", {
                    mode: "text",
                    model: "gpt-4o",
                    status: "active",
                    title: "T",
                    updatedAt: 1,
                    userId: "owner",
                });

                return await context.db.insert("threadPins", { createdAt: 1, messageRole: "user", threadId, updatedAt: 1, userId: "collaborator" });
            })) as string;

            await harness.run(async (context: any) => await context.runMutation(noteMergeGeneration, { from: "owner", generation: 1 }));

            expect(await harness.run(async (context: any) => await context.runMutation(pinsLeftShard, { ownerId: "owner" }))).toStrictEqual({
                abandoned: false,
                left: false,
            });

            const { digests } = (await harness.run(
                async (context: any) => await context.runQuery(listShardRowsToClear, { from: "owner", table: "threadPins" }),
            )) as {
                digests: string[];
            };

            await harness.run(
                async (context: any) =>
                    await context.runMutation(deleteShardRows, { from: "owner", generation: 1, rows: [{ digest: digests[0]!, id: pin }], table: "threadPins" }),
            );

            expect(await harness.run(async (context: any) => await context.runMutation(pinsLeftShard, { ownerId: "owner" }))).toStrictEqual({
                abandoned: false,
                left: true,
            });
            expect(
                await harness.run(
                    async (context: any) =>
                        await context.db
                            .query("idempotencyClaims")
                            .withIndex("by_scope_key", (q: any) => q.eq("scope", MERGE_PINS_LEFT_SCOPE).eq("key", "owner"))
                            .first(),
                ),
            ).not.toBeNull();
        } finally {
            harness.close();
        }
    });

    it("marks a stopped merge's signal abandoned, never writes one where none is, and a later clear arms it again", async () => {
        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const left = async (ownerId: string) => await harness.run(async (context: any) => await context.runMutation(pinsLeftShard, { ownerId }));
        const abandon = async (from: string) => await harness.run(async (context: any) => await context.runMutation(abandonPinsLeft, { from }));

        try {
            // No signal: the stopped merge's clear moved no pin, so another merge has nothing to wait on or stop for.
            await abandon("quiet");

            expect(await left("quiet")).toStrictEqual({ abandoned: false, left: false });

            await harness.run(async (context: any) => {
                await context.db.insert("idempotencyClaims", {
                    claimedAt: 1,
                    expiresAt: IMPORT_MARKER_EXPIRES_AT,
                    key: "owner",
                    result: "",
                    scope: MERGE_PINS_LEFT_SCOPE,
                    userId: "owner",
                });
            });
            await abandon("owner");

            expect(await left("owner")).toStrictEqual({ abandoned: true, left: true });

            // A later run of that merge clears pins again: they are on their way once more, and its `global` step re-points them.
            const pin = (await harness.run(async (context: any) => {
                const threadId = await context.db.insert("threads", {
                    mode: "text",
                    model: "gpt-4o",
                    status: "active",
                    title: "T",
                    updatedAt: 1,
                    userId: "owner",
                });

                return await context.db.insert("threadPins", { createdAt: 1, messageRole: "user", threadId, updatedAt: 1, userId: "collaborator" });
            })) as string;

            await harness.run(async (context: any) => await context.runMutation(noteMergeGeneration, { from: "owner", generation: 2 }));
            const { digests } = (await harness.run(
                async (context: any) => await context.runQuery(listShardRowsToClear, { from: "owner", table: "threadPins" }),
            )) as { digests: string[] };

            await harness.run(
                async (context: any) =>
                    await context.runMutation(deleteShardRows, { from: "owner", generation: 2, rows: [{ digest: digests[0]!, id: pin }], table: "threadPins" }),
            );

            expect(await left("owner")).toStrictEqual({ abandoned: false, left: true });
        } finally {
            harness.close();
        }
    });
});

describe("import markers outlive any merge", () => {
    const DAY = 24 * 60 * 60 * 1000;

    it("keeps a deleted row deleted when the merge resumes past the old 30-day time to live, even with its marker lapsed", async () => {
        vi.useFakeTimers({ now: 1_000_000_000, toFake: ["Date"] });

        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const markerOf = async (key: string) =>
            (await harness.run(
                async (context: any) =>
                    await context.db
                        .query("idempotencyClaims")
                        .withIndex("by_scope_key", (q: any) => q.eq("scope", IMPORT_MARKER_SCOPE).eq("key", key))
                        .first(),
            )) as { _id: string; expiresAt: number } | null;

        try {
            // The guest's row as the merge reads it: here only so it has an id of this table.
            const row = (await harness.run(async (context: any) => {
                const id = await context.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "a", updatedAt: 1, userId: "guest" });
                const stored = await context.db.get("threads", id);

                await context.db.delete("threads", id);

                return stored;
            })) as Record<string, unknown>;
            const id = row._id as string;
            const importOnce = async () =>
                (await harness.run(async (context: any) => {
                    const { generation } = await context.runMutation(acquireMergeLease, { from: "guest", to: "user" });
                    const result = await context.runMutation(importShardRows, { from: "guest", generation, rows: [row], table: "threads", to: "user" });

                    await context.runMutation(releaseMergeLease, { from: "guest", generation });

                    return result;
                })) as { imported: number };

            const first = await importOnce();

            expect(first.imported).toBe(1);

            const key = `guest:threads:${id}`;

            const written = await markerOf(key);

            expect(written?.expiresAt).toBe(IMPORT_MARKER_EXPIRES_AT);

            // The new account deletes the moved row; the merge stalls and resumes long after.
            await harness.run(async (context: any) => await context.db.delete("threads", id));
            vi.setSystemTime(Date.now() + 31 * DAY);
            await harness.run(async (context: any) => await context.runMutation(purgeExpiredClaims, {}));

            expect(await markerOf(key)).not.toBeNull();

            const resumed = await importOnce();

            expect(resumed.imported).toBe(0);
            expect(await harness.run(async (context: any) => await context.db.get("threads", id))).toBeNull();

            // A marker that did lapse (written while markers still had a time to live) still says the merge wrote the row.
            const lapsed = (await markerOf(key))!;

            await harness.run(async (context: any) => await context.db.patch("idempotencyClaims", lapsed._id, { expiresAt: Date.now() - 1 }));

            const afterLapse = await importOnce();

            expect(afterLapse.imported).toBe(0);
            expect(await harness.run(async (context: any) => await context.db.get("threads", id))).toBeNull();
        } finally {
            harness.close();
            vi.useRealTimers();
        }
    });
});

describe("a merge's unfinished state never lapses", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const claimOf = (harness: ReturnType<typeof lunoraTest>, scope: string, key: string) =>
        harness.run(
            async (context: any) =>
                await context.db
                    .query("idempotencyClaims")
                    .withIndex("by_scope_key", (q: any) => q.eq("scope", scope).eq("key", key))
                    .first(),
        ) as Promise<{ expiresAt: number } | null>;

    it("never hands a generation out twice, however long an unfinished merge waits between runs", async () => {
        vi.useFakeTimers({ now: 1_000_000_000, toFake: ["Date"] });

        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const acquire = async () =>
            (await harness.run(async (context: any) => await context.runMutation(acquireMergeLease, { from: "guest", to: "user" }))) as { generation: number };

        try {
            const { generation } = await acquire();

            await harness.run(async (context: any) => await context.runMutation(noteMergeGeneration, { from: "guest", generation }));
            await harness.run(async (context: any) => await context.runMutation(releaseMergeLease, { from: "guest", generation }));

            const lease = await claimOf(harness, MERGE_LEASE_SCOPE, "guest");
            const seen = await claimOf(harness, MERGE_GENERATION_SCOPE, "guest");

            expect(lease?.expiresAt).toBe(IMPORT_MARKER_EXPIRES_AT);
            expect(seen?.expiresAt).toBe(IMPORT_MARKER_EXPIRES_AT);

            // The merge waits more than the old 30-day time to live; the purge runs meanwhile.
            vi.setSystemTime(Date.now() + 31 * DAY);
            await harness.run(async (context: any) => await context.runMutation(purgeExpiredClaims, {}));

            const next = await acquire();

            expect(next.generation).toBe(generation + 1);
            // The older run's generation is still refused on the guest's shard.
            expect(
                await harness.run(async (context: any) => await context.runMutation(noteMergeGeneration, { from: "guest", generation: generation + 1 })),
            ).toStrictEqual({ current: true });
            expect(await harness.run(async (context: any) => await context.runMutation(noteMergeGeneration, { from: "guest", generation }))).toStrictEqual({
                current: false,
            });
        } finally {
            harness.close();
            vi.useRealTimers();
        }
    });

    it("restarts a merge whose progress is older than the old 30-day time to live, after a claim purge", async () => {
        vi.useFakeTimers({ now: 1_000_000_000, toFake: ["Date"] });

        const harness = lunoraTest(schemaWithShardedTables([]) as never);

        try {
            await harness.run(async (context: any) => await context.runMutation(recordGuestMerge, { from: "guest", to: "user" }));

            const record = await claimOf(harness, MERGE_PROGRESS_SCOPE, "guest");

            expect(record?.expiresAt).toBe(IMPORT_MARKER_EXPIRES_AT);

            // No job carries the merge on for a month and more; the purge runs meanwhile.
            vi.setSystemTime(Date.now() + 31 * DAY);
            await harness.run(async (context: any) => await context.runMutation(purgeExpiredClaims, {}));
            transport.queued = [];

            expect(await harness.run(async (context: any) => await context.runMutation(resumeStalledGuestMerges, {}))).toStrictEqual({
                dropped: 0,
                resumed: 1,
            });
            expect(transport.queued.map((job) => job.args)).toStrictEqual([{ from: "guest", to: "user" }]);
            expect(await claimOf(harness, MERGE_PROGRESS_SCOPE, "guest")).not.toBeNull();
        } finally {
            harness.close();
            vi.useRealTimers();
        }
    });

    it("keeps a shard's pins-left signal past the old 30-day time to live, until the merge's global step resolves it", async () => {
        vi.useFakeTimers({ now: 1_000_000_000, toFake: ["Date"] });

        const harness = lunoraTest(schemaWithShardedTables([]) as never);
        const left = async () => await harness.run(async (context: any) => await context.runMutation(pinsLeftShard, { ownerId: "owner" }));

        try {
            const pin = (await harness.run(async (context: any) => {
                const threadId = await context.db.insert("threads", {
                    mode: "text",
                    model: "gpt-4o",
                    status: "active",
                    title: "T",
                    updatedAt: 1,
                    userId: "owner",
                });

                return await context.db.insert("threadPins", { createdAt: 1, messageRole: "user", threadId, updatedAt: 1, userId: "collaborator" });
            })) as string;

            await harness.run(async (context: any) => await context.runMutation(noteMergeGeneration, { from: "owner", generation: 2 }));

            const { digests } = (await harness.run(
                async (context: any) => await context.runQuery(listShardRowsToClear, { from: "owner", table: "threadPins" }),
            )) as { digests: string[] };

            await harness.run(
                async (context: any) =>
                    await context.runMutation(deleteShardRows, { from: "owner", generation: 2, rows: [{ digest: digests[0]!, id: pin }], table: "threadPins" }),
            );

            const signal = await claimOf(harness, MERGE_PINS_LEFT_SCOPE, "owner");

            expect(signal?.expiresAt).toBe(IMPORT_MARKER_EXPIRES_AT);

            // The owner's merge stalls before its global step; a collaborator's merge comes by more than 30 days later.
            vi.setSystemTime(Date.now() + 31 * DAY);
            await harness.run(async (context: any) => await context.runMutation(purgeExpiredClaims, {}));

            expect(await left()).toStrictEqual({ abandoned: false, left: true });

            // The owner's merge resumes with a new run; a superseded delivery's global step does not end the signal, the current one's does.
            await harness.run(async (context: any) => await context.runMutation(noteMergeGeneration, { from: "owner", generation: 3 }));

            expect(await harness.run(async (context: any) => await context.runMutation(resolvePinsLeft, { from: "owner", generation: 2 }))).toStrictEqual({
                fenced: true,
            });
            expect(await left()).toStrictEqual({ abandoned: false, left: true });
            expect(await harness.run(async (context: any) => await context.runMutation(resolvePinsLeft, { from: "owner", generation: 3 }))).toStrictEqual({
                fenced: false,
            });
            expect(await left()).toStrictEqual({ abandoned: false, left: false });
        } finally {
            harness.close();
            vi.useRealTimers();
        }
    });

    it("resolves the guest's own pins-left signal at its global step", async () => {
        const merge = fakeShards({});

        merge.pinsLeft.add("guest");

        let result = await mergeGuestInto(merge.call, REFERENCES, "guest", "user");

        while (result.next !== null) {
            result = await mergeGuestInto(merge.call, REFERENCES, "guest", "user", { resume: result.next });
        }

        expect(merge.pinsLeft.has("guest")).toBe(false);
    });
});
