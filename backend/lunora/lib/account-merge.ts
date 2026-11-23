/**
 * A guest's data follows them into the account they convert to.
 *
 * better-auth converts an anonymous user by creating a NEW user and linking the
 * anonymous one afterwards (`anonymous({ onLinkAccount })`, `auth.ts`). Every
 * row lives on its owner's shard, so the
 * guest's threads, messages, files, memories… sit on the GUEST's shard, keyed
 * by the guest's id — where the new account never looks. This moves them:
 *
 * 1. every non-`.global()` table is read from the guest's shard a page at a
 *    time ({@link listShardRowsPage}) and inserted on the new user's shard
 *    under the SAME ids ({@link importShardRows}, so every reference between
 *    rows stays valid) with the guest's id rewritten to the new one;
 * 2. only once EVERYTHING is copied is the guest's shard cleared, a page at a
 *    time: each page is read whole ({@link listShardRowsToClear}), imported
 *    again, and only the ids the new shard confirms are deleted
 *    ({@link deleteShardRows}), each while its digest still holds. A row
 *    written or edited on the guest's shard after its table was copied (a
 *    collaborator's comment, a guest tab still open, a scheduled job) so
 *    arrives as it is at the clear, never deleted uncopied;
 * 3. `.global()` rows naming the guest are re-pointed ({@link reassignGlobalRows}),
 *    its thread follows a page per mutation ({@link reassignThreadFollowsPage}),
 *    and its pins on other owners' threads on each owner's shard, each thread's
 *    pin route moving only after its pins ({@link moveSharedPinRouteOf});
 * 4. once the guest's shard is empty, the guest itself is deleted
 *    (`auth/hooks.ts#deleteMergedGuest`, which first looks again: a row written
 *    to a table after its clear sends the merge back to clear it), as the anonymous plugin does when a
 *    conversion completes in the guest's own browser. A cross-browser
 *    conversion (`auth/guest-conversion.ts`) would otherwise leave it alive.
 *
 * An import never overwrites the new account's own edit: every row it writes
 * leaves an import marker (the digest of what it wrote), and a row on the new
 * shard is replaced only while it still matches its marker. When the merge ends,
 * a completion fence ({@link MERGE_FENCE_SCOPE}) goes in with the first marker
 * drop, and from then on every import of that guest writes nothing, so an older
 * delivery that read rows before the end cannot bring back one the account
 * deleted. Only one delivery works on a guest's merge at a time: each run takes
 * a lease with a new generation ({@link MERGE_LEASE_SCOPE}), and the import, the
 * guest shard's deletes and the guest's deletion refuse an older generation, so
 * a delivery paused past its lease cannot write what it read over what a later
 * one moved since. Re-pointing `.global()` rows, follows and pin routes carries
 * no row contents and is not fenced. A run spends at most
 * {@link MERGE_CALLS_PER_RUN} cross-shard calls and then queues the next run with
 * where it stopped ({@link MergeProgress}), so no guest is too large to finish
 * and no job is acknowledged with rows left behind.
 *
 * The new account's own seeded `userSettings`/`aiUserPreferences` win over the
 * guest's. Re-running after a partial failure is safe: an id already on the new
 * shard is brought up to the guest's row unless the account changed it, and
 * rows already moved are gone from the old one.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { mergeSkippedSteps } from "../auth/lib/setup-step-limits";
import { AUDIT_TABLES } from "./audit-triggers";
import { releaseClaimsWithPrefix } from "./claim-once";
import { authLogger } from "./logger";
import { callOnShard } from "./cross-shard";
import { enqueueJob } from "./job-queue";
import schema from "../schema";
import { dropPushDevicesOf } from "../notifications/push-device-writes";
import { mergeThreadFollowsPage } from "../chat/follows/follow-writes";
import { firstPinRouteOf, moveSharedPinRoute } from "../chat/pins/pin-route-writes";

/** Rows moved per round trip. */
export const MERGE_PAGE_SIZE = 100;

/**
 * Rows per round trip on an audited table (`files`, `folders`, `gdprConsent`, `teammateConnectorAccess`). Of what an
 * import or delete does per row, only the audit trigger's `documentHistory` insert reaches D1 (a `.global()` table): one
 * statement a write. The import marker's lookup and write, the row's read and the row's write are the shard's own
 * SQLite, which counts no D1 statement and no subrequest, only the shard transaction's 50,000 written rows. 16 rows is
 * 16 D1 statements, inside a budget that allows two a row (32 of the Free plan's 50 per invocation).
 */
export const AUDITED_MERGE_PAGE_SIZE = 16;

/**
 * Bytes of rows one clear page carries: the page crosses shards twice (read from the guest's, imported on the new
 * account's), and a cross-shard request is capped at 1 MiB.
 */
export const CLEAR_PAGE_BYTES = 512 * 1024;

const pageSizeFor = (table: string): number => (table in AUDIT_TABLES ? AUDITED_MERGE_PAGE_SIZE : MERGE_PAGE_SIZE);

/** The guest's own copy of these is dropped: the new account already has its seeded row. */
const KEEP_NEW_USERS = new Set(["aiUserPreferences", "userSettings"]);

/** Ephemeral bookkeeping that is not the guest's content. */
const NOT_MOVED = new Set(["cronRuns", "idempotencyClaims", "rateLimits"]);

/** The tables whose rows live on a user's shard — everything but `.global()`. */
export const shardLocalTables = (source: unknown = schema): string[] =>
    Object.entries((source as { tables: Record<string, { shardMode?: { kind?: string } }> }).tables)
        .filter(([name, table]) => table.shardMode?.kind !== "global" && !NOT_MOVED.has(name))
        .map(([name]) => name)
        .toSorted((a, b) => a.localeCompare(b));

/**
 * `.global()` columns that name a user, by table. `shardActivity` is not here:
 * the guest's census row is deleted, the new user has their own. Every
 * `.global()` table with a `userId` column is either here or in
 * {@link GLOBAL_USER_TABLES_NOT_REASSIGNED} (`account-merge.test.ts` pins it).
 */
export const GLOBAL_USER_COLUMNS: Readonly<Record<string, ReadonlyArray<string>>> = {
    botOwners: ["ownerId"],
    chatFileAccess: ["userId"],
    feedback: ["userId"],
    // Without this a guest's collection stays the guest's: the files that moved
    // point at it, and `requireOwnCollectionId` refuses the new owner.
    knowledgeCollections: ["userId"],
    pageAccess: ["userId", "ownerId", "grantedBy"],
    pageInvites: ["userId", "ownerId", "acceptedBy"],
    passkey: ["userId"],
    projectRepositories: ["userId"],
    projectRuleFiles: ["userId"],
    projects: ["userId"],
    promptHistory: ["userId", "contentBy"],
    prompts: ["userId", "contentBy"],
    shardRoutes: ["ownerId"],
    // The owner-side route follows an owner who moved. The guest's own routes (`userId`) move in the merge's `pins` step, each
    // only after the guest's pins behind it, so a pin made between runs never stays the guest's under a route that is not.
    sharedPinRoutes: ["ownerId"],
    skillRatings: ["userId"],
    skills: ["userId"],
    threadAccess: ["userId", "ownerId", "grantedBy"],
    threadInvites: ["ownerId", "invitedBy", "acceptedBy"],
    userVariableDefaults: ["userId"],
};

/** `.global()` tables with a `userId` the generic re-pointing loop deliberately leaves alone, and why. */
export const GLOBAL_USER_TABLES_NOT_REASSIGNED: Readonly<Record<string, string>> = {
    account: "better-auth links the anonymous user itself",
    deviceCode: "a guest cannot approve a code, and a pending one lapses in 30 minutes",
    documentHistory: "an audit trail records who acted; it is not re-attributed",
    member: "a guest joins no organization",
    memberCredits: "a guest joins no organization",
    pushDevices:
        "tied to the guest's session, which ends with the guest: the notifications module drops them, and the phone registers again under the new sign-in",
    session: "better-auth's own; the guest's sessions end with the guest",
    teamMember: "a guest joins no team",
    threadFollows:
        "moved by the follows module's own step (`reassignThreadFollowsPage`, a page per mutation): a row per person and thread is unique, so where the new account already follows a thread, its row wins and the guest's is dropped",
    twoFactor: "better-auth's own; a guest has no second factor",
    user: "the guest's user row itself",
};

/** `row` with every top-level field equal to `from` set to `to`. */
export const rewriteOwner = (row: Record<string, unknown>, from: string, to: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === from ? to : value]));

type RawDb = {
    delete: (table: string, id: string) => Promise<void>;
    get: (table: string, id: string) => Promise<unknown>;
    insert: (table: string, document: Record<string, unknown>, options: { allowExplicitId: boolean }) => Promise<string>;
    patch: (table: string, id: string, fields: Record<string, unknown>) => Promise<void>;
    query: (table: string) => {
        paginate: (options: {
            cursor: string | null;
            numItems: number;
        }) => Promise<{ continueCursor: string | null; isDone: boolean; page: Record<string, unknown>[] }>;
        take: (count: number) => Promise<Record<string, unknown>[]>;
    };
    replace: (table: string, id: string, document: Record<string, unknown>) => Promise<void>;
};

const rawDb = (ctx: { db: unknown }): RawDb => ctx.db as RawDb;

/** On the GUEST's shard: one page of `table`, from `cursor`. */
export const listShardRowsPage = internalQuery
    .input({ cursor: v.union(v.string(), v.null()), table: v.string() })
    .output(v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean(), page: v.array(v.any()) }))
    .query(async ({ args, ctx }) => {
        const { continueCursor, isDone, page } = await rawDb(ctx)
            .query(args.table)
            .paginate({ cursor: args.cursor, numItems: pageSizeFor(args.table) });

        return { continueCursor, isDone, page };
    });

/** A row's own fields, without the system ones (`_id`, `_creationTime`). */
const ownFields = (row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_")));

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Sorted by code unit, not locale: the order must not change with the runtime. */
const byCodeUnit = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

/** The byte views the store hands back as plain bytes: a top-level binary column decodes to an `ArrayBuffer`. */
const PLAIN_BYTES = new Set(["DataView", "Uint8Array"]);

/**
 * A stored value as deterministic text: object keys sorted, absent (`undefined`) keys dropped, and every value JSON
 * cannot carry tagged with its type. These are the types Lunora's storage codec (`@lunora/wire`) gives back: a bigint by
 * its digits, binary by the hex of its bytes (a typed array other than `Uint8Array` with its type), a date by its time,
 * a URL by its address, a `Map` by its entries and a `Set` by its members (each sorted by its own text, so insertion
 * order does not count), an `Error` by its name, message, fields and cause. JSON throws on a bigint and writes every
 * `ArrayBuffer`, `Map` and `Set` as `{}`; this tells them apart, so two rows with the same text hold the same values.
 * The tags (`<bigint:…>`) are no JSON token, so they cannot meet a string or an array of the row's own. A value no
 * Lunora column holds throws: a row that cannot be compared is never deleted.
 */
export const canonicalValue = (value: unknown): string => {
    if (value === null) {
        return "null";
    }

    switch (typeof value) {
        case "bigint": {
            return `<bigint:${value.toString()}>`;
        }
        case "boolean": {
            return String(value);
        }
        case "number": {
            return Number.isFinite(value) ? JSON.stringify(value) : `<number:${String(value)}>`;
        }
        case "string": {
            return JSON.stringify(value);
        }
        case "undefined": {
            return "<undefined>";
        }
        default: {
            break;
        }
    }

    if (value instanceof ArrayBuffer) {
        return `<bytes:${hex(new Uint8Array(value))}>`;
    }

    if (ArrayBuffer.isView(value)) {
        const bytes = hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        const type = value.constructor.name;

        return PLAIN_BYTES.has(type) ? `<bytes:${bytes}>` : `<bytes:${type}:${bytes}>`;
    }

    if (value instanceof Date) {
        return `<date:${String(value.getTime())}>`;
    }

    if (value instanceof URL) {
        return `<url:${JSON.stringify(value.href)}>`;
    }

    if (value instanceof Map) {
        const entries = [...value.entries()]
            .map(([key, item]) => [canonicalValue(key), canonicalValue(item)] as const)
            .toSorted(([a], [b]) => byCodeUnit(a, b));

        return `<map:${entries.map(([key, item]) => `${key}=>${item}`).join(",")}>`;
    }

    if (value instanceof Set) {
        return `<set:${[...value]
            .map((item) => canonicalValue(item))
            .toSorted(byCodeUnit)
            .join(",")}>`;
    }

    if (value instanceof Error) {
        const fields = Object.fromEntries(Object.entries(value));
        const parts = [value.name, value.message, fields, ...("cause" in value && value.cause !== undefined ? [value.cause] : [])];

        return `<error:${canonicalValue(parts)}>`;
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
    }

    const prototype = typeof value === "object" ? (Object.getPrototypeOf(value) as unknown) : undefined;

    if (prototype === Object.prototype || prototype === null) {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, field]) => field !== undefined)
            .toSorted(([a], [b]) => byCodeUnit(a, b));

        return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalValue(field)}`).join(",")}}`;
    }

    throw new TypeError(`a guest merge cannot compare a stored ${Object.prototype.toString.call(value)}`);
};

/** A row's content as it is stored ({@link canonicalValue} of its own fields), so a change between two reads shows. */
const rowDigest = async (row: Record<string, unknown>): Promise<string> =>
    hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalValue(ownFields(row))))));

/**
 * `rows` from the first, cut where their {@link canonicalValue} passes {@link CLEAR_PAGE_BYTES}; never fewer than one.
 * Binary counts as hex, twice its bytes, more than the base64 the cross-shard transport carries it as.
 */
const withinClearBytes = (rows: Record<string, unknown>[]): Record<string, unknown>[] => {
    const encoder = new TextEncoder();
    let bytes = 0;
    let count = 0;

    for (const row of rows) {
        bytes += encoder.encode(canonicalValue(row)).byteLength;

        if (count > 0 && bytes > CLEAR_PAGE_BYTES) {
            break;
        }

        count += 1;
    }

    return rows.slice(0, count);
};

/**
 * On the GUEST's shard: the first page of `table`, whole rows with each one's digest — for the clear, which imports
 * each page again before it deletes it, and deletes a row only while its digest still holds. With `ownedBy`, only that user's rows: `userSettings` and `aiUserPreferences` (the tables the new account
 * keeps its own row of) are cleared of the guest's row alone, so a shard that also holds the new account's row (one
 * shard serving both, as local routing can) keeps it. Every other table is listed whole.
 */
export const listShardRowsToClear = internalQuery
    .input({ ownedBy: v.optional(v.string()), table: v.string() })
    .output(v.object({ digests: v.array(v.string()), rows: v.array(v.any()) }))
    .query(async ({ args, ctx }) => {
        const limit = pageSizeFor(args.table);
        const withDigests = async (rows: Record<string, unknown>[]) => {
            return { digests: await Promise.all(rows.map(async (row) => await rowDigest(row))), rows };
        };

        if (args.ownedBy !== undefined) {
            const facades = ctx.db as unknown as Record<
                string,
                { findMany: (options: { limit: number; where: { userId: string } }) => Promise<{ page: Record<string, unknown>[] }> }
            >;
            const { page } = await facades[args.table]!.findMany({ limit, where: { userId: args.ownedBy } });

            return await withDigests(withinClearBytes(page));
        }

        return await withDigests(withinClearBytes(await rawDb(ctx).query(args.table).take(limit)));
    });

/**
 * The new account keeps its own `userSettings` row, but the guest's skipped first-run steps are a choice the guest made
 * and would otherwise vanish on sign-up: they are added to the new row's list and nothing else of it changes.
 */
const carrySetupSteps = async (ctx: { db: unknown }, guestRows: Record<string, unknown>[], from: string, to: string): Promise<void> => {
    // Only the converting guest's own row: a page may hold other rows, and their choices are not this account's.
    const skipped = guestRows.flatMap((row) => (row.userId === from && Array.isArray(row.setupStepsSkipped) ? (row.setupStepsSkipped as string[]) : []));

    if (skipped.length === 0) {
        return;
    }

    // By userId, through the table's index: the new account's row is found wherever it sits, never by scanning a page of rows.
    const settings = (ctx.db as { userSettings: { findFirst: (options: { where: { userId: string } }) => Promise<Record<string, unknown> | null> } })
        .userSettings;
    const existing = await settings.findFirst({ where: { userId: to } });
    const db = rawDb(ctx);

    if (existing) {
        await db.patch("userSettings", existing._id as string, {
            setupStepsSkipped: mergeSkippedSteps(skipped, existing.setupStepsSkipped as string[] | undefined),
        });
    } else {
        await db.insert("userSettings", { setupStepsSkipped: mergeSkippedSteps(skipped, undefined), userId: to }, { allowExplicitId: false });
    }
};

/**
 * The claim scope of import markers: one per row a merge wrote on the new shard, keyed `<guest>:<table>:<id>`, its
 * `result` the digest of what was written. Tagged with the new account, so its erasure takes them; dropped at the end
 * of the merge ({@link dropImportMarkersPage}), and past {@link IMPORT_MARKER_TTL_MS} by the claim purge.
 */
export const IMPORT_MARKER_SCOPE = "guest-merge-row";

/** Far past any merge's runs; a marker gone early only keeps the new account's row as it is. */
export const IMPORT_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const markerKey = (from: string, table: string, id: string): string => `${from}:${table}:${id}`;

/**
 * The claim scope of a merge's completion fence: one row per guest on the new account's shard, keyed by the guest's id,
 * written in the same transaction that drops the first page of import markers. Once it is there no import of that
 * guest writes anything: an older delivery still holding rows it read before the merge finished would otherwise insert
 * a row the account has deleted since, with no marker left to say so. Tagged with the new account, so its erasure takes
 * it.
 */
export const MERGE_FENCE_SCOPE = "guest-merge-done";

/** Far past any delivery a queue would still retry; the fence then lapses with the claim purge. */
export const MERGE_FENCE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** The guest's merge into this shard has finished: its fence is here and not lapsed. */
const mergeFinished = async (db: MutationCtx["db"], from: string, now: number): Promise<boolean> => {
    const fence = await db
        .query("idempotencyClaims")
        .withIndex("by_scope_key", (q) => q.eq("scope", MERGE_FENCE_SCOPE).eq("key", from))
        .first();

    return fence !== null && fence.expiresAt > now;
};

/**
 * The claim scope of a merge's lease, on the NEW account's shard: one row per guest (keyed by the guest's id), its `result`
 * `{"generation":n,"until":ms}`. Each run takes it with the next generation ({@link acquireMergeLease}), and every write
 * of rows there checks it ({@link holdMergeLease}): queues deliver at least once, so two deliveries of a merge can run at
 * once, and without it an older one paused after reading a row could write that row over the newer edit another one
 * imported since. A holder that dies lets it lapse after {@link MERGE_LEASE_MS}; a later delivery then takes it over.
 * The row outlives the lease ({@link IMPORT_MARKER_TTL_MS}), so a generation is never handed out twice. Tagged with the
 * new account, so its erasure takes it.
 */
export const MERGE_LEASE_SCOPE = "guest-merge-lease";

/**
 * The claim scope of the highest generation the GUEST's shard has seen (`result` `{"generation":n}`, keyed by the guest's
 * id): every delete there refuses an older one ({@link mergeGenerationCurrent}). Its own scope, so a shard serving both
 * users keeps the lease and this apart. Tagged with the guest; it lapses with the claim purge after the guest is gone.
 */
export const MERGE_GENERATION_SCOPE = "guest-merge-generation";

/** How long a run holds the lease without a write; each import renews it. Far past one run's calls. */
export const MERGE_LEASE_MS = 5 * 60 * 1000;

/** The cross-shard calls a run spends on its lease: take it, note its generation on the guest's shard, give it back. */
export const MERGE_LEASE_CALLS = 3;

/** The row of `(scope, key)`, expired or not. */
const storedClaim = async (db: MutationCtx["db"], scope: string, key: string) =>
    await db
        .query("idempotencyClaims")
        .withIndex("by_scope_key", (q) => q.eq("scope", scope).eq("key", key))
        .first();

const claimAt = async (db: MutationCtx["db"], scope: string, key: string, now: number) => {
    const row = await storedClaim(db, scope, key);

    return row !== null && row.expiresAt > now ? row : null;
};

/** Writes `fields` on the row of `(scope, key)`: patched in place, an expired one included, so the key never holds two. */
const writeClaim = async (
    db: MutationCtx["db"],
    scope: string,
    key: string,
    now: number,
    fields: { expiresAt: number; result: string; userId: string },
): Promise<void> => {
    const row = await storedClaim(db, scope, key);

    if (row === null) {
        await db.insert("idempotencyClaims", { claimedAt: now, key, scope, ...fields });
    } else {
        await db.patch("idempotencyClaims", row._id, { claimedAt: row.expiresAt > now ? row.claimedAt : now, ...fields });
    }
};

/** A lease or generation row's `result`; throws on one this module did not write, so nothing runs on a guess. */
const generationOf = (result: string | undefined): { generation: number; until: number } => {
    const parsed = JSON.parse(result ?? "null") as { generation?: unknown; until?: unknown } | null;

    if (typeof parsed?.generation !== "number") {
        throw new TypeError("a guest merge's lease row holds no generation");
    }

    return { generation: parsed.generation, until: typeof parsed.until === "number" ? parsed.until : 0 };
};

/**
 * On the NEW user's shard: the lease is still `generation`'s; it is renewed. `false` once a later delivery took it, so
 * that delivery's rows are the newer ones. One whose lease lapsed with nobody taking it over still holds it.
 */
const holdMergeLease = async (db: MutationCtx["db"], from: string, generation: number, now: number): Promise<boolean> => {
    const row = await claimAt(db, MERGE_LEASE_SCOPE, from, now);

    if (row === null || generationOf(row.result).generation !== generation) {
        return false;
    }

    await db.patch("idempotencyClaims", row._id, { result: JSON.stringify({ generation, until: now + MERGE_LEASE_MS }) });

    return true;
};

/** On the GUEST's shard: `generation` is the newest this shard has seen, so its deletes may run. */
export const mergeGenerationCurrent = async (db: MutationCtx["db"], from: string, generation: number, now: number): Promise<boolean> => {
    const row = await claimAt(db, MERGE_GENERATION_SCOPE, from, now);

    return row !== null && generationOf(row.result).generation === generation;
};

/**
 * On the NEW user's shard: take the guest's merge lease with the next generation, or `busyUntil` while another delivery
 * holds it. The generation counts on from the last one even after a lease lapsed.
 */
export const acquireMergeLease = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ busyUntil: v.optional(v.number()), generation: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;
        const row = await claimAt(ctx.db, MERGE_LEASE_SCOPE, args.from, now);
        const held = row === null ? null : generationOf(row.result);

        if (held !== null && held.until > now) {
            return { busyUntil: held.until, generation: held.generation };
        }

        const generation = (held?.generation ?? 0) + 1;

        await writeClaim(ctx.db, MERGE_LEASE_SCOPE, args.from, now, {
            expiresAt: now + IMPORT_MARKER_TTL_MS,
            result: JSON.stringify({ generation, until: now + MERGE_LEASE_MS }),
            userId: args.to,
        });

        return { generation };
    });

/** On the NEW user's shard: give the lease back at the end of a run, while it is still `generation`'s; the generation stays. */
export const releaseMergeLease = internalMutation
    .input({ from: v.string(), generation: v.number() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await claimAt(ctx.db, MERGE_LEASE_SCOPE, args.from, ctx.now);

        if (row !== null && generationOf(row.result).generation === args.generation) {
            await ctx.db.patch("idempotencyClaims", row._id, { result: JSON.stringify({ generation: args.generation, until: 0 }) });
        }

        return null;
    });

/**
 * On the GUEST's shard: record `generation` as the newest, unless a newer one is already here (`current: false`: this
 * run was superseded before it began and must do nothing).
 */
export const noteMergeGeneration = internalMutation
    .input({ from: v.string(), generation: v.number() })
    .output(v.object({ current: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;
        const row = await claimAt(ctx.db, MERGE_GENERATION_SCOPE, args.from, now);
        const seen = row === null ? 0 : generationOf(row.result).generation;

        if (seen > args.generation) {
            return { current: false };
        }

        await writeClaim(ctx.db, MERGE_GENERATION_SCOPE, args.from, now, {
            expiresAt: now + IMPORT_MARKER_TTL_MS,
            result: JSON.stringify({ generation: args.generation }),
            userId: args.from,
        });

        return { current: true };
    });

/**
 * On the NEW user's shard: insert `rows` of `table` under their own ids, re-owned. An id already here is brought up to
 * the guest's row as it is now (a row edited after the copy) only while it still holds what the merge last wrote there
 * (its import marker): a row the new account changed, or one written here by anything but the merge, stays as it is,
 * and an id whose marker remains but whose row is gone (the account deleted it) is not written again. `present` names
 * every id the guest's shard may now delete: each is on this shard as the merge or the account left it, or (for the
 * tables the new account keeps its own row of) handled. Once the guest's merge has finished ({@link MERGE_FENCE_SCOPE}),
 * or another delivery has taken the merge's lease since this one did ({@link MERGE_LEASE_SCOPE}: its rows may be newer
 * than these), it writes nothing and confirms nothing: `fenced` tells the stale delivery to stop.
 */
export const importShardRows = internalMutation
    .input({ from: v.string(), generation: v.number(), rows: v.array(v.any()), table: v.string(), to: v.string() })
    .output(v.object({ fenced: v.boolean(), imported: v.number(), present: v.array(v.string()) }))
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);
        const rows = args.rows as Record<string, unknown>[];
        const ids = rows.map((row) => row._id as string);
        const { now } = ctx;

        if ((await mergeFinished(ctx.db, args.from, now)) || !(await holdMergeLease(ctx.db, args.from, args.generation, now))) {
            return { fenced: true, imported: 0, present: [] };
        }

        if (args.table === "userSettings") {
            await carrySetupSteps(ctx, rows, args.from, args.to);

            return { fenced: false, imported: 0, present: ids };
        }

        if (KEEP_NEW_USERS.has(args.table)) {
            return { fenced: false, imported: 0, present: ids };
        }

        let imported = 0;

        for (const row of rows) {
            const id = row._id as string;
            const key = markerKey(args.from, args.table, id);
            const reowned = rewriteOwner(row, args.from, args.to);
            const wanted = await rowDigest(reowned);
            const marker = await ctx.db
                .query("idempotencyClaims")
                .withIndex("by_scope_key", (q) => q.eq("scope", IMPORT_MARKER_SCOPE).eq("key", key))
                .first();
            const written = marker !== null && marker.expiresAt > now ? (marker.result ?? null) : null;
            const existing = (await db.get(args.table, id)) as Record<string, unknown> | null;
            let write = false;

            if (existing === null) {
                // No marker: never here. A marker: the merge wrote it and the new account deleted it since.
                write = written === null;

                if (write) {
                    await db.insert(args.table, reowned, { allowExplicitId: true });
                    imported += 1;
                }
            } else {
                const current = await rowDigest(existing);

                if (current === wanted) {
                    // Already the guest's row: remember it, so a later guest edit may still follow.
                    write = written !== wanted;
                } else if (written === current) {
                    await db.replace(args.table, id, ownFields(reowned));
                    write = true;
                }
                // Otherwise the new account changed the row since the merge wrote it: its edit stays.
            }

            if (write) {
                if (marker === null) {
                    await ctx.db.insert("idempotencyClaims", {
                        claimedAt: now,
                        expiresAt: now + IMPORT_MARKER_TTL_MS,
                        key,
                        result: wanted,
                        scope: IMPORT_MARKER_SCOPE,
                        userId: args.to,
                    });
                } else {
                    await ctx.db.patch("idempotencyClaims", marker._id, { expiresAt: now + IMPORT_MARKER_TTL_MS, result: wanted });
                }
            }
        }

        return { fenced: false, imported, present: ids };
    });

/**
 * On the NEW user's shard: once the guest's merge is done, fence it ({@link MERGE_FENCE_SCOPE}) and drop a page of its
 * import markers; `hasMore` while some may remain. The fence goes in with the first page, so no import ever runs
 * between a marker's drop and the fence. Markers and fence are this shard's own rows, not D1's: a page of deletes costs
 * no D1 statement. `fenced` when another delivery holds the lease: that one finishes the merge.
 */
export const dropImportMarkersPage = internalMutation
    .input({ from: v.string(), generation: v.number(), to: v.string() })
    .output(v.object({ fenced: v.boolean(), hasMore: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;

        if (!(await holdMergeLease(ctx.db, args.from, args.generation, now))) {
            return { fenced: true, hasMore: false };
        }

        const fence = await ctx.db
            .query("idempotencyClaims")
            .withIndex("by_scope_key", (q) => q.eq("scope", MERGE_FENCE_SCOPE).eq("key", args.from))
            .first();

        if (fence === null) {
            await ctx.db.insert("idempotencyClaims", {
                claimedAt: now,
                expiresAt: now + MERGE_FENCE_TTL_MS,
                key: args.from,
                scope: MERGE_FENCE_SCOPE,
                userId: args.to,
            });
        }

        return { fenced: false, hasMore: await releaseClaimsWithPrefix(ctx, IMPORT_MARKER_SCOPE, `${args.from}:`) };
    });

/**
 * On the GUEST's shard: delete the moved rows. A row whose digest no longer matches was changed after the clear read
 * it, so the new shard holds an older copy: it stays, and the clear's next page reads and imports it again. Nothing is
 * deleted for a delivery whose generation is no longer this shard's newest (`fenced`).
 */
export const deleteShardRows = internalMutation
    .input({ from: v.string(), generation: v.number(), rows: v.array(v.object({ digest: v.string(), id: v.string() })), table: v.string() })
    .output(v.object({ fenced: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);

        if (!(await mergeGenerationCurrent(ctx.db, args.from, args.generation, ctx.now))) {
            return { fenced: true };
        }

        for (const { digest, id } of args.rows) {
            const row = (await db.get(args.table, id)) as Record<string, unknown> | null;

            if (row !== null && (await rowDigest(row)) === digest) {
                await db.delete(args.table, id);
            }
        }

        return { fenced: false };
    });

/**
 * On the GUEST's shard, right before the guest is deleted: the first shard-local table that still holds a row of the
 * guest's (one written after the clear emptied it), or `null`. Scoped as {@link listShardRowsToClear} is: the guest's
 * own row of the tables the new account keeps its own of, any row of every other table. One `take(1)` a table, all on
 * the shard's own SQLite: no D1 statement and no subrequest. The `.global()` tables naming a user are skipped: they are
 * no shard's rows (none is shard-local in the deploy; the test harness keeps them on the shard).
 */
export const firstTableWithGuestRows = async (ctx: { db: unknown }, guestId: string): Promise<string | null> => {
    const facades = ctx.db as Record<string, { findMany: (options: { limit: number; where: { userId: string } }) => Promise<{ page: unknown[] }> }>;
    const globalUserTables = new Set([...Object.keys(GLOBAL_USER_COLUMNS), ...Object.keys(GLOBAL_USER_TABLES_NOT_REASSIGNED)]);

    for (const table of shardLocalTables()) {
        if (globalUserTables.has(table)) {
            continue;
        }

        let rows: unknown[];

        if (KEEP_NEW_USERS.has(table)) {
            const { page } = await facades[table]!.findMany({ limit: 1, where: { userId: guestId } });

            rows = page;
        } else {
            rows = await rawDb(ctx).query(table).take(1);
        }

        if (rows.length > 0) {
            return table;
        }
    }

    return null;
};

/** Re-point every `.global()` row naming the guest to the new user, and drop the guest's census row. */
/**
 * Global rows one `reassignGlobalRows` call moves: each is one D1 statement, and an invocation may run only so many, so a
 * guest with more is moved over several calls (`mergeGuestInto` repeats it until `done`).
 */
const REASSIGN_BATCH = 200;

/**
 * Fewer rows per call for a table whose rows are large: each read row is charged whole against the call's read limit,
 * and a rule-file row may hold up to `MAX_RULE_FILES_BYTES`.
 */
const REASSIGN_BATCH_BY_TABLE: Readonly<Record<string, number>> = { projectRuleFiles: 8 };

export const reassignGlobalRows = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ done: v.boolean(), reassigned: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const facades = ctx.db as unknown as Record<
            string,
            {
                findMany: (options: { consistency: "primary"; limit: number; where: Record<string, string> }) => Promise<{ page: Record<string, unknown>[] }>;
            }
        >;
        let reassigned = 0;

        for (const [table, columns] of Object.entries(GLOBAL_USER_COLUMNS)) {
            for (const column of columns) {
                const room = Math.min(REASSIGN_BATCH - reassigned, REASSIGN_BATCH_BY_TABLE[table] ?? REASSIGN_BATCH);

                if (room <= 0) {
                    // Primary reads: a patch moves its row out of the filter, so the next call starts where this one stopped.
                    return { done: false, reassigned };
                }

                const { page } = await facades[table]!.findMany({ consistency: "primary", limit: room + 1, where: { [column]: args.from } });

                for (const row of page.slice(0, room)) {
                    await ctx.db.patch(table as never, row._id as never, { [column]: args.to } as never);
                    reassigned += 1;
                }

                if (page.length > room) {
                    return { done: false, reassigned };
                }
            }
        }

        // Through each module's own write surface, never the generic loop above.
        await dropPushDevicesOf(ctx.db, args.from);

        const { page: census } = await ctx.db.shardActivity.findMany({ where: { shardKey: args.from } });

        for (const row of census) {
            await ctx.db.delete("shardActivity", row._id);
        }

        return { done: true, reassigned };
    });

/**
 * One page of the guest's thread follows, moved through the follows module's own write surface. A page per mutation:
 * a D1 read and write per row would otherwise pass the Worker's subrequest ceiling at a few hundred follows.
 */
export const reassignThreadFollowsPage = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ hasMore: v.boolean(), moved: v.number() }))
    .mutation(async ({ args, ctx }) => await mergeThreadFollowsPage(ctx.db, args.from, args.to));

/** The first `.global()` pin route that still names the guest, with the shard its pins live on; `null` once none does. */
export const nextSharedPinRoute = internalQuery
    .input({ from: v.string() })
    .output(v.union(v.object({ ownerId: v.string(), threadId: v.string() }), v.null()))
    .query(async ({ args, ctx }) => await firstPinRouteOf(ctx.db, args.from));

/** Hands the guest's pin route on `threadId` to the new account, once the guest's pins there have moved. */
export const moveSharedPinRouteOf = internalMutation
    .input({ from: v.string(), threadId: v.string(), to: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await moveSharedPinRoute(ctx.db, args.from, args.to, args.threadId);

        return null;
    });

/** A caller into a named shard, as `createShardClient(...).call` is. */
export type ShardCall = <R>(reference: { __lunoraRef: string }, args: Record<string, unknown>, shardKey: string) => Promise<R>;

/**
 * Cross-shard calls one merge run makes before it queues the next: each is a Worker subrequest, and the Free plan allows
 * 50 per invocation, some of which the run's own queue and shard calls take.
 */
export const MERGE_CALLS_PER_RUN = 40;

/**
 * Runs one merge may take before it gives up and fails, keeping the guest and every row not yet moved. At
 * {@link MERGE_CALLS_PER_RUN} calls a run, that copies and clears at least 4,000 rows of an audited table (16 a page,
 * five calls a page) and 25,000 of any other; a guest has far fewer.
 */
export const MAX_MERGE_RUNS = 1000;

/** The merge's steps, in order. */
export type MergePhase = "clear" | "copy" | "follows" | "global" | "guest" | "markers" | "pins";

/** Where a merge run stopped, for the next run to start from: the step, its table and that table's copy cursor. */
export interface MergeProgress {
    cursor: string | null;
    moved: number;
    phase: MergePhase;
    /** Runs taken so far. */
    run: number;
    /** The table the copy or the clear stopped in; another phase ignores it. */
    table: string;
}

/** A run's position and what it may still spend: {@link MergeProgress} while it runs. */
interface MergeState {
    calls: number;
    cursor: string | null;
    index: number;
    moved: number;
    phase: MergePhase;
}

interface MergeContext {
    call: ShardCall;
    from: string;
    /** The lease generation this run holds ({@link MERGE_LEASE_SCOPE}). */
    generation: number;
    references: MergeReferences;
    tables: string[];
    to: string;
}

/** The most cross-shard calls one step of each phase makes: a run stops before a step it could not finish. */
const STEP_CALLS: Readonly<Record<MergePhase, number>> = { clear: 3, copy: 2, follows: 1, global: 1, guest: 1, markers: 1, pins: 3 };

/** Moves `state` to the first table of `phase`. */
const enter = (state: MergeState, phase: MergePhase): void => {
    state.phase = phase;
    state.index = 0;
    state.cursor = null;
};

/** Moves `state` past its table, and on to `phase` after the last one, so a run never stops between them. */
const nextTable = (state: MergeState, tables: string[], phase: MergePhase): void => {
    state.index += 1;
    state.cursor = null;

    if (state.index >= tables.length) {
        enter(state, phase);
    }
};

/** One step of each phase; `true` once the merge is done. */
const STEPS: Readonly<Record<MergePhase, (context: MergeContext, state: MergeState) => Promise<boolean>>> = {
    // A page of the table: cleared, and read again until the guest's shard holds none of its rows.
    clear: async ({ call, from, generation, references, tables, to }, state) => {
        const table = tables[state.index];

        if (table === undefined) {
            enter(state, "global");

            return false;
        }

        state.calls -= 1;
        const cleared = await clearPage(call, references, table, { from, generation, to });

        if (cleared === "fenced") {
            return true;
        }

        if (cleared === "page") {
            state.calls -= 2;
        } else {
            nextTable(state, tables, "global");
        }

        return false;
    },
    // A page of the table from the cursor, imported on the new shard.
    copy: async ({ call, from, generation, references, tables, to }, state) => {
        const table = tables[state.index];

        if (table === undefined) {
            enter(state, "clear");

            return false;
        }

        state.calls -= 1;
        const page: { continueCursor: string | null; isDone: boolean; page: Record<string, unknown>[] } = await call(
            references.list,
            { cursor: state.cursor, table },
            from,
        );

        if (page.page.length > 0) {
            state.calls -= 1;
            const { fenced }: { fenced: boolean } = await call(references.importRows, { from, generation, rows: page.page, table, to }, to);

            // Another delivery finished this merge, or took it over: this one read its rows before that and must write none of them.
            if (fenced) {
                return true;
            }

            state.moved += page.page.length;
        }

        if (page.isDone || page.continueCursor === null) {
            nextTable(state, tables, "clear");
        } else {
            state.cursor = page.continueCursor;
        }

        return false;
    },
    follows: async ({ call, from, references, to }, state) => {
        state.calls -= 1;
        const page: { hasMore: boolean; moved: number } = await call(references.reassignFollows, { from, to }, to);

        state.moved += page.moved;

        if (!page.hasMore) {
            enter(state, "pins");
        }

        return false;
    },
    // Each call moves at most `REASSIGN_BATCH` rows, so a guest with many never hits the statement cap.
    global: async ({ call, from, references, to }, state) => {
        state.calls -= 1;
        const { done }: { done: boolean } = await call(references.reassignGlobal, { from, to }, to);

        if (done) {
            enter(state, "follows");
        }

        return false;
    },
    // Only now: every table was copied, then cleared to empty, so nothing of the guest's is left to move.
    guest: async ({ call, from, generation, references, tables }, state) => {
        state.calls -= 1;
        const result: { deleted: boolean; fenced?: boolean; followsRemain?: boolean; pinsRemain?: boolean; rowsRemain?: string } = await call(
            references.deleteGuest,
            { generation, userId: from },
            from,
        );

        if (result.fenced === true) {
            return true;
        }

        // A follow, a pin or a row written under the guest's id after its step: move it, then try again. A row goes back to
        // the clear from its table on; the clear then runs the later steps again, each finding little or nothing.
        if (result.followsRemain === true) {
            enter(state, "follows");
        } else if (result.pinsRemain === true) {
            enter(state, "pins");
        } else if (result.rowsRemain === undefined) {
            enter(state, "markers");
        } else {
            enter(state, "clear");
            state.index = Math.max(0, tables.indexOf(result.rowsRemain));
        }

        return false;
    },
    markers: async ({ call, from, generation, references, to }, state) => {
        state.calls -= 1;
        const { fenced, hasMore }: { fenced: boolean; hasMore: boolean } = await call(references.dropMarkers, { from, generation, to }, to);

        return fenced || !hasMore;
    },
    // The guest's pins on one thread another user owns, moved on that owner's shard, a batch per step; its route follows
    // only once none is left. Right before the guest's deletion, which sends the merge back here while a route remains.
    pins: async ({ call, from, references, to }, state) => {
        state.calls -= 1;
        const route: { ownerId: string; threadId: string } | null = await call(references.nextPinRoute, { from }, to);

        if (route === null) {
            enter(state, "guest");

            return false;
        }

        state.calls -= 1;
        const { hasMore }: { hasMore: boolean } = await call(references.reassignPins, { from, threadId: route.threadId, to }, route.ownerId);

        if (!hasMore) {
            state.calls -= 1;
            await call(references.movePinRoute, { from, threadId: route.threadId, to }, to);
        }

        return false;
    },
};

/**
 * Run the merge of guest `from` into user `to` from `resume` (from the start without it), for at most `budget`
 * cross-shard calls. `next` is where it stopped, for the next run, or `null` once the merge is done: every table
 * copied, then cleared, the global rows, follows and pins moved, the guest deleted and the import markers dropped, or
 * another delivery found to have done all that (the fence) or to hold a newer lease. `budget` counts every call, the
 * run's {@link MERGE_LEASE_CALLS} lease calls included. `busyUntil` instead when another delivery holds the lease:
 * nothing ran, and this delivery is to be tried again after it. Throws past `maxRuns`, so a merge that cannot finish
 * fails with the guest and its remaining rows kept.
 */
export const mergeGuestInto = async (
    call: ShardCall,
    references: MergeReferences,
    from: string,
    to: string,
    { budget = MERGE_CALLS_PER_RUN, maxRuns = MAX_MERGE_RUNS, resume }: { budget?: number; maxRuns?: number; resume?: MergeProgress } = {},
): Promise<{ busyUntil?: number; moved: number; next: MergeProgress | null }> => {
    const run = resume?.run ?? 0;

    if (run >= maxRuns) {
        throw new Error(`the merge of guest ${from} into ${to} did not finish in ${String(maxRuns)} runs; the guest and its rows stay`);
    }

    // One delivery at a time: the lease's generation goes with every write, and a later one's makes this one's stale.
    const lease: { busyUntil?: number; generation: number } = await call(references.acquireLease, { from, to }, to);

    if (lease.busyUntil !== undefined) {
        return { busyUntil: lease.busyUntil, moved: resume?.moved ?? 0, next: null };
    }

    const { generation } = lease;
    const { current }: { current: boolean } = await call(references.noteGeneration, { from, generation }, from);

    if (!current) {
        await call(references.releaseLease, { from, generation }, to);

        return { moved: resume?.moved ?? 0, next: null };
    }

    const tables = shardLocalTables();
    // A table no longer in the schema (a deploy between runs): its phase starts over, which is safe for both.
    const index = resume === undefined ? 0 : Math.max(0, tables.indexOf(resume.table));
    const state: MergeState = {
        calls: budget - MERGE_LEASE_CALLS,
        cursor: resume !== undefined && tables[index] === resume.table ? resume.cursor : null,
        index,
        moved: resume?.moved ?? 0,
        phase: resume?.phase ?? "copy",
    };
    const context: MergeContext = { call, from, generation, references, tables, to };
    let done = false;

    while (!done && state.calls >= STEP_CALLS[state.phase]) {
        done = await STEPS[state.phase](context, state);
    }

    // Given back before the next run is queued, so it need not wait for the lease to lapse. A run that threw keeps it
    // until then: its redelivery tries again after it.
    await call(references.releaseLease, { from, generation }, to);

    return {
        moved: state.moved,
        next: done ? null : { cursor: state.cursor, moved: state.moved, phase: state.phase, run: run + 1, table: tables[state.index] ?? "" },
    };
};

/**
 * Clear one page of `table` on the guest's shard: the page is imported again before it is deleted, so a row written or
 * edited there since the table was copied arrives as it is now; only ids the new shard confirms are deleted. `empty`
 * when the table holds none of the guest's rows any more (one call), `page` after a page (three calls), `fenced` when
 * another delivery already finished the merge (two calls, nothing deleted).
 */
const clearPage = async (
    call: ShardCall,
    references: MergeReferences,
    table: string,
    { from, generation, to }: { from: string; generation: number; to: string },
): Promise<"empty" | "fenced" | "page"> => {
    const { digests, rows }: { digests: string[]; rows: Record<string, unknown>[] } = await call(
        references.listClear,
        KEEP_NEW_USERS.has(table) ? { ownedBy: from, table } : { table },
        from,
    );

    if (rows.length === 0) {
        return "empty";
    }

    const { fenced, present }: { fenced: boolean; present: string[] } = await call(references.importRows, { from, generation, rows, table, to }, to);

    // Another delivery finished this merge or took it over: nothing of this page is confirmed, so nothing of it is deleted.
    if (fenced) {
        return "fenced";
    }

    const confirmed = new Set(present);
    const deletable = rows
        .map((row, index) => {
            return { digest: digests[index]!, id: row._id as string };
        })
        .filter(({ id }) => confirmed.has(id));

    if (deletable.length > 0) {
        const deleted: { fenced: boolean } = await call(references.deleteRows, { from, generation, rows: deletable, table }, from);

        if (deleted.fenced) {
            return "fenced";
        }
    }

    if (deletable.length < rows.length) {
        throw new Error(`the new shard of ${to} did not confirm ${String(rows.length - deletable.length)} ${table} rows of guest ${from}; they stay`);
    }

    return "page";
};

/** The generated references `mergeGuestInto` calls (passed in, so this module does not import `_generated/api`). */
export interface MergeReferences {
    acquireLease: { __lunoraRef: string };
    deleteGuest: { __lunoraRef: string };
    deleteRows: { __lunoraRef: string };
    dropMarkers: { __lunoraRef: string };
    importRows: { __lunoraRef: string };
    list: { __lunoraRef: string };
    listClear: { __lunoraRef: string };
    movePinRoute: { __lunoraRef: string };
    nextPinRoute: { __lunoraRef: string };
    noteGeneration: { __lunoraRef: string };
    reassignFollows: { __lunoraRef: string };
    reassignGlobal: { __lunoraRef: string };
    reassignPins: { __lunoraRef: string };
    releaseLease: { __lunoraRef: string };
}

/**
 * The move, as queue jobs on the NEW user's shard (`auth.ts` enqueues the first).
 * Off the sign-up request: a guest's rows are one round trip per table and
 * page, far too long to hold the request that creates the account. Each run
 * makes at most {@link MERGE_CALLS_PER_RUN} cross-shard calls and queues the
 * next with where it stopped, before it returns: a run is acknowledged only
 * once its successor is queued or the merge is done. Redelivery is safe — see
 * the module comment.
 */
export const runGuestMerge = internalAction
    .input({
        from: v.string(),
        resume: v.optional(
            v.object({
                cursor: v.union(v.string(), v.null()),
                moved: v.number(),
                phase: v.union(
                    v.literal("clear"),
                    v.literal("copy"),
                    v.literal("follows"),
                    v.literal("global"),
                    v.literal("guest"),
                    v.literal("markers"),
                    v.literal("pins"),
                ),
                run: v.number(),
                table: v.string(),
            }),
        ),
        to: v.string(),
    })
    .output(v.object({ done: v.boolean(), moved: v.number() }))
    .action(async ({ args }) => {
        const { busyUntil, moved, next } = await mergeGuestInto(
            async (reference, callArgs, shardKey) => (await callOnShard(reference as never, callArgs as never, { shardKey })) as never,
            {
                acquireLease: internal.lib.account_merge.acquireMergeLease,
                deleteGuest: internal.auth.hooks.deleteMergedGuest,
                deleteRows: internal.lib.account_merge.deleteShardRows,
                dropMarkers: internal.lib.account_merge.dropImportMarkersPage,
                importRows: internal.lib.account_merge.importShardRows,
                list: internal.lib.account_merge.listShardRowsPage,
                listClear: internal.lib.account_merge.listShardRowsToClear,
                movePinRoute: internal.lib.account_merge.moveSharedPinRouteOf,
                nextPinRoute: internal.lib.account_merge.nextSharedPinRoute,
                noteGeneration: internal.lib.account_merge.noteMergeGeneration,
                reassignFollows: internal.lib.account_merge.reassignThreadFollowsPage,
                reassignGlobal: internal.lib.account_merge.reassignGlobalRows,
                reassignPins: internal.chat.pins.functions.reassignUserPinsOnThread,
                releaseLease: internal.lib.account_merge.releaseMergeLease,
            },
            args.from,
            args.to,
            args.resume === undefined ? {} : { resume: args.resume },
        );

        if (busyUntil !== undefined) {
            // Another delivery is running this merge. Tried again once its lease would lapse, never dropped: should that
            // one die, this is what carries the merge on.
            await enqueueJob(internal.lib.account_merge.runGuestMerge, args, { delayMs: Math.max(1000, busyUntil - Date.now()), shardKey: args.to });

            return { done: false, moved };
        }

        if (next !== null) {
            // Queued before this run returns: should the send fail, the run fails and its redelivery repeats it.
            await enqueueJob(internal.lib.account_merge.runGuestMerge, { from: args.from, resume: next, to: args.to }, { shardKey: args.to });

            return { done: false, moved };
        }

        authLogger.info(`[auth] moved ${String(moved)} rows from guest ${args.from} to ${args.to}`);

        return { done: true, moved };
    });
