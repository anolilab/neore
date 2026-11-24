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
 *    arrives as it is at the clear, never deleted uncopied.
 *    Before any copy, the guest's organization contributor entries are handed to the new account
 *    ({@link handOverOrganizationContributors}, the `contributors` phase), so its organization ledger rows land in the cohort they
 *    were counted in; an older row that cannot still moves, held out of the organization view (`heldFrom`);
 * 3. `.global()` rows naming the guest are re-pointed ({@link reassignGlobalRows}),
 *    its thread follows a page per mutation ({@link reassignThreadFollowsPage}),
 *    and its pins on other owners' threads on each owner's shard, each thread's
 *    pin route moving only after its pins ({@link moveSharedPinRouteOf}); a
 *    second pass over the new account's routes then reaches a pin an owner's
 *    parallel merge moved to another shard in between;
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
 * Every run, under its lease, marks the guest as merging and the new account as
 * importing (`lib/account-moves.ts`, {@link beginMergeRun}): the guest's pin
 * writes are refused, the run waits while one may still be in flight, an erasure
 * of either account stops the merge, and the new account's erasure waits for it.
 * The markers go with the last page of import markers; a run that finds the fence
 * with markers left does only that, renewing neither marker. Several guests can
 * merge into one account: each holds the account's importing marker through its
 * own claim ({@link MERGE_IMPORTING_SCOPE}), and the marker goes with the last
 * holder. A delivery whose lease a newer one took touches no marker.
 *
 * The copy, the clear and the final check read the guest's shard whole: every row
 * there belongs to an object the guest owns. Where development's
 * `SHARD_ROUTING=off` runs every user on one shard that is not so, and the merge
 * moves, deletes and checks no row there and keeps the guest ({@link onGuestShard}).
 *
 * A merge whose job runs out of redeliveries is not lost: each run saves where it stopped beside its lease
 * ({@link MERGE_PROGRESS_SCOPE}), and the housekeeping sweep ({@link resumeStalledGuestMerges}) queues it again from
 * there once the lease is free and the progress has not moved for {@link MERGE_STALL_MS}.
 *
 * The new account's own seeded `userSettings`/`aiUserPreferences` win over the
 * guest's. Re-running after a partial failure is safe: an id already on the new
 * shard is brought up to the guest's row unless the account changed it, and
 * rows already moved are gone from the old one.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { isMergeDestination, mergeSourceState } from "../auth/lib/merge-destination";
import { mergeSkippedSteps } from "../auth/lib/setup-step-limits";
import { beginAccountMove, endAccountMove, hasAccountMove, isErasing, MERGE_MARKER_MAX_AGE_MS, pinWritesInFlightUntil } from "./account-moves";
import { AUDIT_TABLES } from "./audit-triggers";
import { hasClaimWithPrefix, prefixEnd, releaseClaimsWithPrefix } from "./claim-once";
import { authLogger } from "./logger";
import { callOnShard } from "./cross-shard";
import { enqueueJob } from "./job-queue";
import { noteRetentionDueAt, noteShardActivity, noteShardDue } from "./shard-housekeeping";
import { currentShard } from "./shard-context";
import schema from "../schema";
import { dropPushDevicesOf } from "../notifications/push-device-writes";
import { mergeThreadFollowsPage } from "../chat/follows/follow-writes";
import { firstPinRouteOf, moveSharedPinRoute, pinRouteOwnerOf } from "../chat/pins/pin-route-writes";
import { ORGANIZATION_RECORD_LATE_MS } from "../usage/activity-logic";
import { patchRow } from "./patch";
import { SEARCH_INTERNAL_FIELDS } from "../agent/thread-search-plan";
import { countUserTurns } from "../agent/thread-search-triggers";

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

/**
 * The tables whose rows live on a user's shard — everything but `.global()` — sorted, but `threads` just before
 * `messages`: a thread is on the new shard before its messages come, so the messages trigger there counts each one it
 * imports (`userTurnCount`, {@link DERIVED_FIELDS}), and the guest's thread is cleared before its messages, whose
 * deletes then count nothing down. Still after the `embeddings*` tables, so a cleared thread's vector cleanup never runs
 * on vectors the clear has yet to read.
 */
export const shardLocalTables = (source: unknown = schema): string[] => {
    const tables = Object.entries((source as { tables: Record<string, { shardMode?: { kind?: string } }> }).tables)
        .filter(([name, table]) => table.shardMode?.kind !== "global" && !NOT_MOVED.has(name))
        .map(([name]) => name)
        .filter((name) => name !== "threads")
        .toSorted((a, b) => a.localeCompare(b));
    const messages = tables.indexOf("messages");

    return messages === -1 ? tables : tables.toSpliced(messages, 0, "threads");
};

/**
 * Per table, the fields each shard keeps itself and the merge never compares or carries over a row it replaces: the
 * thread's user-turn count (the messages triggers, which count down as the clear deletes the guest's messages and up as
 * the import adds them on the new shard) and the palette sync's vector ids, claim and refusal. A change to one is no
 * edit: they stay out of every digest ({@link rowDigest}), a replaced row keeps the new shard's values, and an inserted
 * thread's count is the new shard's own ({@link countUserTurns}).
 */
const DERIVED_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = { threads: SEARCH_INTERNAL_FIELDS };

const withoutDerived = (table: string, row: Record<string, unknown>): Record<string, unknown> => {
    const derived = DERIVED_FIELDS[table];

    return derived === undefined ? row : Object.fromEntries(Object.entries(row).filter(([key]) => !derived.includes(key)));
};

const derivedOf = (table: string, row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries((DERIVED_FIELDS[table] ?? []).filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));

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
    // The organizations a guest's projects were filed under: the list follows the guest's ledger rows (which move with their shard).
    usageOrganizationContributors: ["userId"],
    userVariableDefaults: ["userId"],
};

/** `.global()` tables with a `userId` the generic re-pointing loop deliberately leaves alone, and why. */
export const GLOBAL_USER_TABLES_NOT_REASSIGNED: Readonly<Record<string, string>> = {
    account: "better-auth links the anonymous user itself",
    accountMoves:
        "the move marker of the account being merged or erased: it refuses pin writes from that account and names no content, and that account ends with the move, so nothing re-points it",
    deviceCode: "a guest cannot approve a code, and a pending one lapses in 30 minutes",
    documentHistory: "an audit trail records who acted; it is not re-attributed",
    member: "a guest joins no organization",
    memberCredits: "a guest joins no organization",
    pinWriteLeases:
        "the in-flight pin-write lease of the account being merged or erased: it names no content, and the move removes it when it ends, so nothing re-points it",
    pushDevices:
        "tied to the guest's session, which ends with the guest: the notifications module drops them, and the phone registers again under the new sign-in",
    session: "better-auth's own; the guest's sessions end with the guest",
    teamMember: "a guest joins no team",
    threadFollows:
        "moved by the follows module's own step (`reassignThreadFollowsPage`, a page per mutation): a row per person and thread is unique, so where the new account already follows a thread, its row wins and the guest's is dropped",
    twoFactor: "better-auth's own; a guest has no second factor",
    user: "the guest's user row itself",
};

/**
 * The shard-local columns that hold a user id: the row's owner and the people it records (who created, resolved, performed
 * or last edited it). A merge re-points only these; every other column is content (a title, a note, a
 * message) and keeps its value even when that value is the guest's id. `account-merge.test.ts` pins this against the
 * schema: a new column with a user-like name goes here or in {@link NOT_USER_REFERENCE_FIELDS}.
 */
export const USER_REFERENCE_FIELDS: ReadonlySet<string> = new Set([
    "createdBy",
    "lastEditedBy",
    // The vector tables' copy of their row's owner.
    "model_table_userId",
    "performedBy",
    // The payment component's customer reference: the paying user's id.
    "referenceId",
    "resolvedBy",
    "userId",
]);

/** Shard-local columns whose names look like a user reference but hold no user id, and what they hold. */
export const NOT_USER_REFERENCE_FIELDS: Readonly<Record<string, string>> = {
    actor: "a kind (`owner` or `collaborator`), never an id",
    authorizationResponseIssParameterSupported: "a flag of the OAuth authorization server's metadata",
    authorName: "a display name",
    dispatchedBy: "a dispatch source",
    isAdvancedUser: "a flag",
    lastUserMessageAt: "a time",
    platformUserId: "the person's id on a messenger platform",
    platformUsername: "the person's name on a messenger platform",
    resumedBy: "an approval id",
    supersededBy: "a memory id",
    taintedBy: "the untrusted sources a device call or summary read",
    trustedAuthorizationServerHosts: "host names",
    userColor: "a presence color",
    userEmail: "an address",
    userName: "a display name",
    username: "a saved site login's name",
    userTurnCount: "a count",
};

/** `row` with each user-reference column ({@link USER_REFERENCE_FIELDS}) that names `from` set to `to`; content stays. */
export const rewriteOwner = (row: Record<string, unknown>, from: string, to: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === from && USER_REFERENCE_FIELDS.has(key) ? to : value]));

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

/**
 * Whether the running code is on the guest's OWN shard, where every row belongs to an object the guest owns (a row lives
 * on its object owner's shard: a collaborator's comment on the guest's page is one of the guest's rows to move). That is
 * why the copy, the clear and the final check read a table whole. Not so where development's `SHARD_ROUTING=off` runs
 * every user on `__root__`: there a table holds everyone's rows, so the merge reads, deletes and checks none of them, and
 * the guest is kept with its rows. Outside a shard (unit tests) nothing says otherwise.
 */
export const onGuestShard = (guestId: string): boolean => {
    const shard = currentShard();

    return shard === undefined || shard === guestId;
};

const NO_ROWS = { continueCursor: null, isDone: true, page: [] };

/**
 * On the GUEST's shard: one page of `table`, from `cursor`; none on a shard that is not the guest's own ({@link onGuestShard}).
 * The page goes to the new shard whole, so it is cut at {@link CLEAR_PAGE_BYTES} as the clear's are: a page that passes
 * it is read again with only the rows that fit, so its cursor resumes right after the last row sent.
 */
export const listShardRowsPage = internalQuery
    .input({ cursor: v.union(v.string(), v.null()), from: v.string(), table: v.string() })
    .output(v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean(), page: v.array(v.any()) }))
    .query(async ({ args, ctx }) => {
        if (!onGuestShard(args.from)) {
            return NO_ROWS;
        }

        const read = async (size: number) => await rawDb(ctx).query(args.table).paginate({ cursor: args.cursor, numItems: size });
        const full = await read(pageSizeFor(args.table));
        const fits = withinClearBytes(full.page).length;
        const { continueCursor, isDone, page } = fits < full.page.length ? await read(fits) : full;

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

/**
 * A stored value as deterministic text: object keys sorted, absent (`undefined`) keys dropped, and every value JSON
 * cannot carry tagged with its type. These are the types Lunora's storage codec (`@lunora/wire`) gives back: a bigint by
 * its digits, binary by its type and the hex of its bytes (the codec keeps an `ArrayBuffer`, a `Uint8Array` and each other
 * typed array apart, so an edit that changes only the type is a change), a date by its time,
 * a URL by its address, a `Map` by its entries and a `Set` by its members (in their iteration order, which the codec
 * stores, so a change of order alone is a change), an `Error` by its name, message, fields and cause. JSON throws on a bigint and writes every
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
        return `<bytes:ArrayBuffer:${hex(new Uint8Array(value))}>`;
    }

    if (ArrayBuffer.isView(value)) {
        return `<bytes:${value.constructor.name}:${hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}>`;
    }

    if (value instanceof Date) {
        return `<date:${String(value.getTime())}>`;
    }

    if (value instanceof URL) {
        return `<url:${JSON.stringify(value.href)}>`;
    }

    if (value instanceof Map) {
        return `<map:${[...value.entries()].map(([key, item]) => `${canonicalValue(key)}=>${canonicalValue(item)}`).join(",")}>`;
    }

    if (value instanceof Set) {
        return `<set:${[...value].map((item) => canonicalValue(item)).join(",")}>`;
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

/**
 * A row's content as it is stored ({@link canonicalValue} of its own fields, without the {@link DERIVED_FIELDS} of its
 * table), so a change between two reads shows.
 */
const rowDigest = async (table: string, row: Record<string, unknown>): Promise<string> =>
    hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalValue(withoutDerived(table, ownFields(row)))))));

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
 * shard serving both, as local routing can) keeps it. Every other table is listed whole, on the guest's own shard only
 * ({@link onGuestShard}): nothing on one that serves other users too.
 */
export const listShardRowsToClear = internalQuery
    .input({ from: v.string(), ownedBy: v.optional(v.string()), table: v.string() })
    .output(v.object({ digests: v.array(v.string()), rows: v.array(v.any()) }))
    .query(async ({ args, ctx }) => {
        if (!onGuestShard(args.from)) {
            return { digests: [], rows: [] };
        }

        const limit = pageSizeFor(args.table);
        const withDigests = async (rows: Record<string, unknown>[]) => {
            return { digests: await Promise.all(rows.map(async (row) => await rowDigest(args.table, row))), rows };
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
 * The claim scope of the guest's skipped first-run steps a merge has already added to the new account's list, on the NEW
 * account's shard, keyed by the guest's id, `result` the steps as JSON. Both the copy and the clear import the guest's
 * `userSettings` row: without it the clear would add back a step the account resumed after the copy. Tagged with the new
 * account, so its erasure takes it; never by time, and gone with the merge's last page of import markers.
 */
export const MERGE_CARRIED_STEPS_SCOPE = "guest-merge-carried-steps";

/**
 * The new account keeps its own `userSettings` row, but the guest's skipped first-run steps are a choice the guest made
 * and would otherwise vanish on sign-up: they are added to the new row's list and nothing else of it changes. Each step
 * is added once ({@link MERGE_CARRIED_STEPS_SCOPE}): a later import adds only the steps the guest skipped since, so one
 * the account resumed meanwhile stays resumed.
 */
const carrySetupSteps = async (ctx: Pick<MutationCtx, "db">, guestRows: Record<string, unknown>[], from: string, to: string, now: number): Promise<void> => {
    // Only the converting guest's own row: a page may hold other rows, and their choices are not this account's.
    const skipped = guestRows.flatMap((row) => (row.userId === from && Array.isArray(row.setupStepsSkipped) ? (row.setupStepsSkipped as string[]) : []));
    const record = await storedClaim(ctx.db, MERGE_CARRIED_STEPS_SCOPE, from);
    const carried = JSON.parse(record?.result ?? "[]") as string[];
    const fresh = skipped.filter((step, index) => !carried.includes(step) && skipped.indexOf(step) === index);

    if (fresh.length === 0) {
        return;
    }

    await writeClaim(ctx.db, MERGE_CARRIED_STEPS_SCOPE, from, now, {
        expiresAt: IMPORT_MARKER_EXPIRES_AT,
        result: JSON.stringify([...carried, ...fresh]),
        userId: to,
    });

    // By userId, through the table's index: the new account's row is found wherever it sits, never by scanning a page of rows.
    const settings = (ctx.db as { userSettings: { findFirst: (options: { where: { userId: string } }) => Promise<Record<string, unknown> | null> } })
        .userSettings;
    const existing = await settings.findFirst({ where: { userId: to } });
    const db = rawDb(ctx);

    if (existing) {
        await db.patch("userSettings", existing._id as string, {
            setupStepsSkipped: mergeSkippedSteps(fresh, existing.setupStepsSkipped as string[] | undefined),
        });
    } else {
        await db.insert("userSettings", { setupStepsSkipped: mergeSkippedSteps(fresh, undefined), userId: to }, { allowExplicitId: false });
    }
};

/**
 * The claim scope of import markers: one per row a merge wrote on the new shard, keyed `<guest>:<table>:<id>`, its
 * `result` the digest of what was written. Tagged with the new account, so its erasure takes them; dropped at the end
 * of the merge ({@link dropImportMarkersPage}) and with the new account's erasure, never by time: a merge has no end
 * date, and a marker gone before it ends would let the merge write again a row the account deleted
 * ({@link IMPORT_MARKER_EXPIRES_AT}).
 */
export const IMPORT_MARKER_SCOPE = "guest-merge-row";

/**
 * The time to live of the stalled-merge sweep's cursor. Not of any claim a merge has not finished with: import markers,
 * the progress record, the pins-left signal, the lease and the generation are each the only record of something
 * unfinished, and none may lapse before that is done ({@link IMPORT_MARKER_EXPIRES_AT}).
 */
export const IMPORT_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The `expiresAt` of an import marker, a progress record, a pins-left signal, and a merge's lease and generation: it
 * never lapses, so the claim purge never takes it. Each goes only when the merge has done what it records, or with the
 * erasure of the account it is tagged with; a merge given up on keeps its markers until then, so a later delivery still
 * leaves alone every row the account deleted, and its lease and generation, so a generation is never handed out twice.
 */
export const IMPORT_MARKER_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

const markerKey = (from: string, table: string, id: string): string => `${from}:${table}:${id}`;

/**
 * The claim scope of the clear's own record, on the NEW user's shard, keyed as its import marker: the clear imported the
 * row and is about to delete it on the guest's shard. A marker without one names a row the clear has not read: once the
 * clear has emptied the table, such a row missing from the guest's shard was deleted by the guest after the copy, and the
 * reconcile takes its copy back ({@link listUnclearedImports}). Written before the guest's delete, so a run that dies in
 * between keeps the copy, never drops a moved row; taken off a row whose delete was skipped (changed since the read).
 * Never lapses, and goes with the import markers ({@link IMPORT_MARKER_EXPIRES_AT}).
 */
export const MERGE_CLEARED_SCOPE = "guest-merge-cleared";

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

/**
 * The claim scope of a merge stopped for good at its run cap ({@link MAX_MERGE_RUNS}), on the NEW account's shard: one
 * row per guest, tagged with the new account, so its erasure takes it, and never by time. It outlives the lease and the
 * progress record the stop drops: a late delivery (a requeued duplicate, the hand-over repeated) finds it before it takes
 * a lease or writes a record ({@link acquireMergeLease}, {@link recordGuestMerge}), so nothing starts the merge again.
 */
export const MERGE_STOPPED_SCOPE = "guest-merge-stopped";

const markMergeStopped = async (db: MutationCtx["db"], from: string, to: string, now: number): Promise<void> => {
    await writeClaim(db, MERGE_STOPPED_SCOPE, from, now, { expiresAt: IMPORT_MARKER_EXPIRES_AT, result: "", userId: to });
};

const mergeStopped = async (db: QueryCtx["db"], from: string): Promise<boolean> => (await storedClaim(db, MERGE_STOPPED_SCOPE, from)) !== null;

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
 * The row never lapses while the merge is unfinished ({@link IMPORT_MARKER_EXPIRES_AT}), so a generation is never handed
 * out twice; it is deleted when the merge and its end are over, as the fence then refuses every later delivery before it
 * takes a lease ({@link acquireMergeLease}). Tagged with the new account, so its erasure takes it.
 */
export const MERGE_LEASE_SCOPE = "guest-merge-lease";

/**
 * The claim scope of the highest generation the GUEST's shard has seen (`result` `{"generation":n}`, keyed by the guest's
 * id): every delete there refuses an older one ({@link mergeGenerationCurrent}). Its own scope, so a shard serving both
 * users keeps the lease and this apart. Never lapses ({@link IMPORT_MARKER_EXPIRES_AT}): it goes with the guest's deletion
 * (`auth/hooks.ts#deleteMergedGuest`) or with the erasure of the guest it is tagged with, and is never written again once
 * the guest is gone ({@link noteMergeGeneration}).
 */
export const MERGE_GENERATION_SCOPE = "guest-merge-generation";

/** How long a run holds the lease without a write; each import renews it. Far past one run's calls. */
export const MERGE_LEASE_MS = 5 * 60 * 1000;

/**
 * The cross-shard calls a run spends around its steps: take the lease, note its generation on the guest's shard, mark the
 * two accounts ({@link beginMergeRun}), give the lease back.
 */
export const MERGE_LEASE_CALLS = 4;

/**
 * The call a run that stops the merge makes after it gives the lease back: its guest's pins-left signal is marked
 * abandoned ({@link abandonPinsLeft}). Kept back from the steps, so a step that stops the merge on the run's last step
 * call still ends within its budget.
 */
export const MERGE_STOP_CALLS = 1;

/** The fields of {@link MergeProgress}, spread into each validator that takes one. */
const vMergeProgressFields = {
    cursor: v.union(v.string(), v.null()),
    moved: v.number(),
    phase: v.union(
        v.literal("clear"),
        v.literal("contributors"),
        v.literal("copy"),
        v.literal("follows"),
        v.literal("global"),
        v.literal("guest"),
        v.literal("markers"),
        v.literal("pins"),
        v.literal("reconcile"),
        v.literal("repins"),
    ),
    route: v.optional(v.number()),
    routeThread: v.optional(v.string()),
    run: v.number(),
    table: v.string(),
};

/** The row of `(scope, key)`, expired or not. */
const storedClaim = async (db: QueryCtx["db"], scope: string, key: string) =>
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

/**
 * The claim scope of one merge's hold on the new account's importing marker, on the new account's shard: one row per
 * merge, keyed `<newAccount>:<guest>`, live for `MERGE_MARKER_MAX_AGE_MS` after the run that last renewed it. Several
 * guests can merge into one account at once, and the account has one importing marker: a merge that ends drops its own
 * row and the marker only once no other merge's row is live, so the account's erasure keeps waiting for the others.
 * Tagged with the new account, so its erasure takes it.
 */
export const MERGE_IMPORTING_SCOPE = "guest-merge-importing";

const importingKey = (from: string, to: string): string => `${to}:${from}`;

/** Marks the new account as importing for this merge: its own hold, then the account's shared marker, both renewed. */
const beginImporting = async (ctx: Pick<MutationCtx, "db">, from: string, to: string, now: number): Promise<void> => {
    await writeClaim(ctx.db, MERGE_IMPORTING_SCOPE, importingKey(from, to), now, {
        expiresAt: now + MERGE_MARKER_MAX_AGE_MS,
        result: "1",
        userId: to,
    });
    await beginAccountMove(ctx, to, "importing", now);
};

/** Importing holds read per page by {@link otherMergeImporting}. */
const IMPORTING_PROBE_BATCH = 50;

/** Whether another merge into `to` still holds its importing marker live. Read a page at a time; `;` follows `:`. */
const otherMergeImporting = async (ctx: Pick<MutationCtx, "db">, to: string, now: number): Promise<boolean> => {
    let after = `${to}:`;

    for (;;) {
        const from = after;
        const rows = await ctx.db
            .query("idempotencyClaims")
            .withIndex("by_scope_key", (q) => q.eq("scope", MERGE_IMPORTING_SCOPE).gt("key", from).lt("key", `${to};`))
            .take(IMPORTING_PROBE_BATCH);

        if (rows.some((row) => row.expiresAt > now)) {
            return true;
        }

        if (rows.length < IMPORTING_PROBE_BATCH) {
            return false;
        }

        after = rows.at(-1)!.key;
    }
};

/**
 * Ends this merge's hold on the new account's importing marker. The marker itself goes only when no other merge into the
 * account holds it live; one given up on stops holding it once its row is past `MERGE_MARKER_MAX_AGE_MS`, as the marker
 * stops fencing then.
 */
const endImporting = async (ctx: Pick<MutationCtx, "db">, from: string, to: string, now: number): Promise<void> => {
    const own = await storedClaim(ctx.db, MERGE_IMPORTING_SCOPE, importingKey(from, to));

    if (own !== null) {
        await ctx.db.delete("idempotencyClaims", own._id);
    }

    if (!(await otherMergeImporting(ctx, to, now))) {
        await endAccountMove(ctx, to, "importing");
    }
};

/**
 * A finished merge (its fence is here) still has its end to run: import markers of the guest left on this shard, this
 * merge's hold on the new account's importing marker, or the guest's merging marker. All three are this merge's own: the
 * account's importing marker is shared with other merges into it and says nothing about this one. The fence goes in with
 * the first page of dropped markers, so a merge with more than a page of them is fenced before its markers phase is over;
 * until this is `false`, a run carries on with that phase alone, and the new account's erasure waits for the importing
 * marker no longer than `MERGE_MARKER_MAX_AGE_MS` after the last run renewed it.
 */
const mergeCleanupPending = async (ctx: Pick<MutationCtx, "db">, from: string, to: string | undefined): Promise<boolean> =>
    (await hasClaimWithPrefix(ctx, IMPORT_MARKER_SCOPE, `${from}:`)) ||
    (await hasClaimWithPrefix(ctx, MERGE_CLEARED_SCOPE, `${from}:`)) ||
    (to !== undefined && (await storedClaim(ctx.db, MERGE_IMPORTING_SCOPE, importingKey(from, to))) !== null) ||
    (await hasAccountMove(ctx, from, "merging"));

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
    const row = await storedClaim(db, MERGE_LEASE_SCOPE, from);

    if (row === null || generationOf(row.result).generation !== generation) {
        return false;
    }

    await db.patch("idempotencyClaims", row._id, { result: JSON.stringify({ generation, until: now + MERGE_LEASE_MS }) });

    return true;
};

/** On the GUEST's shard: `generation` is the newest this shard has seen, so its deletes may run. */
export const mergeGenerationCurrent = async (db: MutationCtx["db"], from: string, generation: number): Promise<boolean> => {
    const row = await storedClaim(db, MERGE_GENERATION_SCOPE, from);

    return row !== null && generationOf(row.result).generation === generation;
};

/** On the GUEST's shard, once the guest is deleted: its merge has nothing left to fence. */
export const dropMergeGeneration = async (db: MutationCtx["db"], from: string): Promise<void> => {
    const row = await storedClaim(db, MERGE_GENERATION_SCOPE, from);

    if (row !== null) {
        await db.delete("idempotencyClaims", row._id);
    }
};

/**
 * A merge that stops for good with no run holding its lease: into an account that is gone (erased, so every claim tagged
 * with it went too), or one the stalled-merge sweep drops (an erasure, the run cap). This merge's markers end, so the
 * guest's pin writes are refused no longer, and its progress record and lease go, so nothing tagged with an erased account
 * is left on its shard. A merge at its run cap keeps its stop record ({@link MERGE_STOPPED_SCOPE}), which refuses a late
 * delivery before it takes a lease.
 * The guest and its rows stay, as for any merge that stops. `to` is unknown only for a record written without its tag.
 */
const endStoppedMerge = async (ctx: Pick<MutationCtx, "db">, from: string, to: string | undefined, now: number): Promise<void> => {
    if (to !== undefined) {
        await endImporting(ctx, from, to, now);
    }

    await endAccountMove(ctx, from, "merging");
    await dropMergeProgress(ctx.db, from);

    const lease = await storedClaim(ctx.db, MERGE_LEASE_SCOPE, from);

    if (lease !== null) {
        await ctx.db.delete("idempotencyClaims", lease._id);
    }
};

/**
 * On the NEW user's shard: take the guest's merge lease with the next generation, or `busyUntil` while another delivery
 * holds it. The generation counts on from the last one even after a lease lapsed. `saved` is the merge's progress record
 * ({@link MERGE_PROGRESS_SCOPE}): a delivery whose payload is behind it goes on from the record, never back. `finished`:
 * the merge and its end are over (its fence is here): nothing is written and the delivery stops. `stopped`:
 * the new account is gone ({@link isMergeDestination}), or the merge stopped for good at its run cap
 * ({@link MERGE_STOPPED_SCOPE}); nothing is written and the merge ends, so a late job (a delayed successor, a requeued
 * duplicate) never starts it again.
 */
export const acquireMergeLease = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(
        v.object({
            busyUntil: v.optional(v.number()),
            finished: v.optional(v.boolean()),
            generation: v.number(),
            saved: v.optional(v.object({ ...vMergeProgressFields })),
            stopped: v.optional(v.boolean()),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;

        if (!(await isMergeDestination(ctx, args.to))) {
            await endStoppedMerge(ctx, args.from, args.to, now);

            return { generation: 0, stopped: true };
        }

        // Its fence is here and its end is over: a late delivery takes no lease, so it writes nothing that would outlive the merge.
        if ((await mergeFinished(ctx.db, args.from, now)) && !(await mergeCleanupPending(ctx, args.from, args.to))) {
            return { finished: true, generation: 0 };
        }

        // Stopped for good at its run cap: no lease and no record, so neither this delivery nor the sweep starts it again.
        if (await mergeStopped(ctx.db, args.from)) {
            return { generation: 0, stopped: true };
        }

        const row = await storedClaim(ctx.db, MERGE_LEASE_SCOPE, args.from);
        const held = row === null ? null : generationOf(row.result);

        if (held !== null && held.until > now) {
            return { busyUntil: held.until, generation: held.generation };
        }

        const generation = (held?.generation ?? 0) + 1;

        await writeClaim(ctx.db, MERGE_LEASE_SCOPE, args.from, now, {
            // Never by time while the merge is unfinished: a lapsed row would hand out a generation again.
            expiresAt: IMPORT_MARKER_EXPIRES_AT,
            result: JSON.stringify({ generation, until: now + MERGE_LEASE_MS }),
            userId: args.to,
        });
        await recordMergeStart(ctx, args.from, args.to, now);

        const record = await storedClaim(ctx.db, MERGE_PROGRESS_SCOPE, args.from);
        const saved = record === null ? null : savedProgressOf(record.result).progress;

        return { generation, ...(saved !== null && { saved }) };
    });

/**
 * On the NEW user's shard: give the lease back at the end of a run, while it is still `generation`'s; the generation stays.
 * With it the run's `progress` is saved for {@link resumeStalledGuestMerges}, and a finished merge's record goes. Only a
 * later run than the record's moves it ({@link MergeProgress.run}), so the record never goes back.
 */
export const releaseMergeLease = internalMutation
    .input({ from: v.string(), generation: v.number(), progress: v.optional(v.object({ ...vMergeProgressFields })) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;
        const row = await storedClaim(ctx.db, MERGE_LEASE_SCOPE, args.from);

        if (row === null || generationOf(row.result).generation !== args.generation) {
            return null;
        }

        await ctx.db.patch("idempotencyClaims", row._id, { result: JSON.stringify({ generation: args.generation, until: 0 }) });

        if ((await mergeFinished(ctx.db, args.from, now)) && !(await mergeCleanupPending(ctx, args.from, row.userId))) {
            await dropMergeProgress(ctx.db, args.from);
            // Finished: the fence alone refuses every delivery after it (`acquireMergeLease` takes no lease for it), so the
            // lease goes, and with it the last of the merge's claims here but the fence.
            await ctx.db.delete("idempotencyClaims", row._id);
        } else if (args.progress !== undefined && row.userId !== undefined) {
            const record = await storedClaim(ctx.db, MERGE_PROGRESS_SCOPE, args.from);

            if (record === null || args.progress.run > runOf(savedProgressOf(record.result).progress)) {
                // The lease is tagged with the new account (`acquireMergeLease`), so the record is too.
                await saveMergeProgress(ctx, args.from, row.userId, args.progress, now);
            }
        }

        return null;
    });

/**
 * On the GUEST's shard: record `generation` as the newest, unless a newer one is already here (`current: false`: this
 * run was superseded before it began and must do nothing). `guestGone` (with `current: false`) only once this merge
 * itself got past its `guest` step (`pastGuest`: its progress is in the `markers` phase) and no generation is here, or
 * when the id is a real account's: nothing is written, since the `guest` step drops this row, and one written after it
 * would never go. A missing `user` row alone is no reason to stop: the anonymous plugin deletes the guest's in the very
 * sign-up request that queues the merge, before any row has moved, so a merge short of its `markers` phase writes its
 * generation and runs every step; its `guest` step drops the row again once the guest's shard is empty
 * (`auth/hooks.ts#deleteMergedGuest`). With no row on its shard, every delete there refuses the run
 * ({@link mergeGenerationCurrent}). The `user` row is read only when no generation is here. `sharedShard` (with
 * `current: false`, nothing written) on a shard that is not the guest's own: the merge stops and keeps the guest.
 */
export const noteMergeGeneration = internalMutation
    .input({ from: v.string(), generation: v.number(), pastGuest: v.optional(v.boolean()) })
    .output(v.object({ current: v.boolean(), guestGone: v.optional(v.boolean()), sharedShard: v.optional(v.boolean()) }))
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;

        // A store every user runs on (development's `SHARD_ROUTING=off`): the merge would move none of the guest's rows
        // ({@link onGuestShard}), so it stops before its first step and keeps the guest, never fencing itself finished.
        if (!onGuestShard(args.from)) {
            return { current: false, sharedShard: true };
        }

        const row = await storedClaim(ctx.db, MERGE_GENERATION_SCOPE, args.from);
        const seen = row === null ? 0 : generationOf(row.result).generation;

        if (seen > args.generation) {
            return { current: false };
        }

        if (row === null) {
            const source = await mergeSourceState(ctx, args.from);

            // A real account's rows are never moved; a guest this merge already deleted has nothing left to move.
            if (source === "account" || (source === "missing" && args.pastGuest === true)) {
                return { current: false, guestGone: true };
            }
        }

        await writeClaim(ctx.db, MERGE_GENERATION_SCOPE, args.from, now, {
            expiresAt: IMPORT_MARKER_EXPIRES_AT,
            result: JSON.stringify({ generation: args.generation }),
            userId: args.from,
        });

        return { current: true };
    });

/**
 * The claim scope of a merge's latest progress, on the NEW account's shard: one row per guest (keyed by the guest's id),
 * its `result` `{"progress":MergeProgress|null,"savedAt":ms}` (`null`: from the start), tagged with the new account, so
 * its erasure takes it. Apart from any queued job's payload: when a job runs out of redeliveries, nothing else would carry
 * the merge on, so {@link resumeStalledGuestMerges} restarts it from here. Written when the merge is handed over
 * ({@link recordGuestMerge}) and at its first lease, saved each time a run gives the lease back, and dropped once the
 * merge is finished (its fence is here), stopped by an erasure or past {@link MAX_MERGE_RUNS}; never by time
 * ({@link IMPORT_MARKER_EXPIRES_AT}), as a merge whose jobs are gone has no other way on.
 */
export const MERGE_PROGRESS_SCOPE = "guest-merge-progress";

/** A merge whose lease is free and whose progress has not moved for this long has no job carrying it on. */
export const MERGE_STALL_MS = 30 * 60 * 1000;

/**
 * D1 statements one pass of the stalled-merge sweep may send. A Worker invocation may send 50 on the Free plan, and the
 * minute tick (`shard-housekeeping.ts#runShardTick`) runs this pass beside its other steps in the same invocation, so the
 * pass keeps well under that. Only `.global()` statements count: the progress records, leases and markers it reads and
 * writes are this shard's own SQLite. A read costs one, a write ({@link MERGE_SWEEP_WRITE_STATEMENTS}) two. A pass that
 * stops at the budget leaves its cursor on the last record it handled and asks for the next pass at once.
 */
export const MERGE_SWEEP_STATEMENTS = 20;

/** What a `.global()` insert, patch or delete is counted as by {@link MERGE_SWEEP_STATEMENTS}. */
export const MERGE_SWEEP_WRITE_STATEMENTS = 2;

/**
 * The census writes a pass that restarted a merge makes once, after its records: the shard's activity and its due time,
 * each a read and a write ({@link noteShardActivity}, {@link noteShardDue}).
 */
export const MERGE_SWEEP_CENSUS_STATEMENTS = 2 * (1 + MERGE_SWEEP_WRITE_STATEMENTS);

/**
 * The most D1 statements one stalled record costs, whichever way it goes: the new account's `user` row, the guest's
 * merging marker (a fenced merge's cleanup check), the two erasure checks, then for a merge that stops (a gone account,
 * an erasure, the run cap: {@link endStoppedMerge}) the new account's markers read and its importing marker deleted, the
 * guest's markers read, its merging marker deleted, its pin-write leases read and deleted. A restarted or finished one
 * costs only the reads. An account holds one marker of a kind and one pin-write lease (`lib/account-moves.ts`). A pass
 * takes on a record only while this much of its budget is left.
 */
export const MERGE_SWEEP_RECORD_STATEMENTS = 1 + 1 + 2 + 3 * (1 + MERGE_SWEEP_WRITE_STATEMENTS);

/**
 * Progress records one housekeeping pass reads on a shard: this shard's own rows, no D1 statement. The next pass reads on
 * after the last one this pass looked at ({@link MERGE_SWEEP_SCOPE}), so records it skipped never hide the ones behind them.
 */
const MERGE_PROGRESS_SCAN = 32;

/**
 * The claim scope of where the stalled-merge sweep reads on from, on the NEW account's shard: one row (key `cursor`), its
 * `result` the guest id of the last progress record a pass looked at. Dropped once a pass reaches the end of the records;
 * tagged with that record's new account, so its erasure takes it.
 */
export const MERGE_SWEEP_SCOPE = "guest-merge-sweep";

const MERGE_SWEEP_KEY = "cursor";

/** The run count a saved progress stands at: `0` for a merge recorded from the start. */
const runOf = (progress: MergeProgress | null): number => progress?.run ?? 0;

/**
 * Writes the merge's progress record and notes the new account's shard as active: housekeeping visits a shard only within
 * `HOUSEKEEPING_HORIZON_MS` of its last activity, so a merge that stalls on an idle account's shard is still swept.
 */
const writeMergeProgress = async (db: MutationCtx["db"], from: string, to: string, progress: MergeProgress | null, now: number): Promise<void> => {
    await writeClaim(db, MERGE_PROGRESS_SCOPE, from, now, {
        // Never by time: the record is the merge's only continuation once its jobs are gone, so only its end goes with it.
        expiresAt: IMPORT_MARKER_EXPIRES_AT,
        result: JSON.stringify({ progress, savedAt: now }),
        userId: to,
    });
};

const saveMergeProgress = async (ctx: Pick<MutationCtx, "db">, from: string, to: string, progress: MergeProgress | null, now: number): Promise<void> => {
    await writeMergeProgress(ctx.db, from, to, progress, now);
    await noteShardActivity(ctx, to, now);
    // Housekeeping reads only the most recently active shards, so a merge stalled on a shard behind them would never be
    // swept. The shard's timed work is dispatched by due time instead: the tick there checks for the stall
    // (`resumeStalledGuestMergesOnTick`) and re-arms while a record is left.
    await noteShardDue(ctx, now + MERGE_STALL_MS, to, { rearmPassed: true });
};

const dropMergeProgress = async (db: MutationCtx["db"], from: string): Promise<void> => {
    const row = await storedClaim(db, MERGE_PROGRESS_SCOPE, from);

    if (row !== null) {
        await db.delete("idempotencyClaims", row._id);
    }
};

/**
 * A record for a merge that has none yet, from the start; one already here keeps its progress, a finished merge or one
 * stopped for good ({@link MERGE_STOPPED_SCOPE}) gets none.
 */
const recordMergeStart = async (ctx: Pick<MutationCtx, "db">, from: string, to: string, now: number): Promise<void> => {
    if ((await storedClaim(ctx.db, MERGE_PROGRESS_SCOPE, from)) === null && !(await mergeFinished(ctx.db, from, now)) && !(await mergeStopped(ctx.db, from))) {
        await saveMergeProgress(ctx, from, to, null, now);
    }
};

/** A progress row's `result`; throws on one this module did not write. */
const savedProgressOf = (result: string | undefined): { progress: MergeProgress | null; savedAt: number } => {
    const parsed = JSON.parse(result ?? "null") as { progress?: MergeProgress | null; savedAt?: unknown } | null;

    if (typeof parsed?.savedAt !== "number") {
        throw new TypeError("a guest merge's progress row holds no time");
    }

    return { progress: parsed.progress ?? null, savedAt: parsed.savedAt };
};

/**
 * On the NEW user's shard, when the guest's merge is handed over (`auth.ts#onGuestConverted`), before its first job is
 * queued: the record {@link resumeStalledGuestMerges} restarts it from, should that job never take the lease.
 */
export const recordGuestMerge = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await recordMergeStart(ctx, args.from, args.to, ctx.now);

        return null;
    });

/**
 * Housekeeping sweep (`shardSweeps()`), on the NEW account's shard: restarts each guest merge that no job carries on any
 * more. A merge is stalled when its record has not moved for {@link MERGE_STALL_MS} and no run holds its lease; it is
 * queued again from its saved progress, and the record's time moves first, so the next pass waits for that job. The time
 * moves before the job is sent and in the transaction that read the record: a job that runs at once saves its own newer
 * progress after this write, never under it. Two deliveries of one merge are safe (the lease and its generation decide),
 * so a job that was only slow costs a redundant run. A finished merge's record goes instead (one whose import markers or
 * account-move markers are still to drop is restarted for that), as does one either account's erasure has stopped (the
 * erasure has priority) and one past {@link MAX_MERGE_RUNS}, which keeps the guest and its rows. Each pass reads at most
 * {@link MERGE_PROGRESS_SCAN} records, on from where the last one stopped ({@link MERGE_SWEEP_SCOPE}), and takes on a
 * stalled one only while {@link MERGE_SWEEP_RECORD_STATEMENTS} of its D1 budget ({@link MERGE_SWEEP_STATEMENTS}) is left.
 */
export const resumeStalledMerges = async (ctx: MutationCtx): Promise<{ dropped: number; nextCheckAt?: number; resumed: number }> => {
    const { now } = ctx;
    // On the guest's shard, which this one is not: queued, as the restart below is.
    const abandonPinsLeftOf = async (from: string): Promise<void> => {
        await enqueueJob(internal.lib.account_merge.abandonPinsLeft, { from }, { shardKey: from });
    };
    const cursor = await claimAt(ctx.db, MERGE_SWEEP_SCOPE, MERGE_SWEEP_KEY, now);
    const after = cursor?.result;
    const rows = await ctx.db
        .query("idempotencyClaims")
        .withIndex("by_scope_key", (q) => (after === undefined ? q.eq("scope", MERGE_PROGRESS_SCOPE) : q.eq("scope", MERGE_PROGRESS_SCOPE).gt("key", after)))
        .take(MERGE_PROGRESS_SCAN);
    let dropped = 0;
    let resumed = 0;
    /** The account a restarted merge goes into: this shard's, whose census the pass notes once. */
    let resumedInto: string | undefined;
    /** The D1 statements this pass may still send; the census writes after a restart are kept back from the start. */
    let budget = MERGE_SWEEP_STATEMENTS - MERGE_SWEEP_CENSUS_STATEMENTS;
    /** The last record this pass looked at, where the next one reads on from. */
    let last: { key: string; userId: string | undefined } | null = null;
    /** The soonest a record this pass looked at and kept can stall. */
    let nextCheckAt: number | undefined;
    const checkAt = (at: number): void => {
        nextCheckAt = nextCheckAt === undefined ? at : Math.min(nextCheckAt, at);
    };

    for (const row of rows) {
        const { progress, savedAt } = savedProgressOf(row.result);
        const lease = savedAt > now - MERGE_STALL_MS ? null : await storedClaim(ctx.db, MERGE_LEASE_SCOPE, row.key);
        const leaseUntil = lease === null ? 0 : generationOf(lease.result).until;

        // Fresh, or held by a run: costs no D1 statement, so it is looked at whatever is left of the budget.
        if (savedAt > now - MERGE_STALL_MS || leaseUntil > now) {
            last = { key: row.key, userId: row.userId };
            checkAt(savedAt > now - MERGE_STALL_MS ? savedAt + MERGE_STALL_MS : leaseUntil);

            continue;
        }

        if (budget < MERGE_SWEEP_RECORD_STATEMENTS) {
            break;
        }

        last = { key: row.key, userId: row.userId };
        budget -= MERGE_SWEEP_RECORD_STATEMENTS;

        const from = row.key;
        const to = row.userId;

        if (to !== undefined && !(await isMergeDestination(ctx, to))) {
            // The new account is gone: the merge ends here, and nothing is queued to write onto its shard.
            await endStoppedMerge(ctx, from, to, now);
            await abandonPinsLeftOf(from);
            dropped += 1;

            continue;
        }

        const finished = to !== undefined && (await mergeFinished(ctx.db, from, now)) && !(await mergeCleanupPending(ctx, from, to));
        const stopped =
            !finished &&
            (to === undefined || (progress !== null && progress.run >= MAX_MERGE_RUNS) || (await isErasing(ctx, to)) || (await isErasing(ctx, from)));

        if (stopped) {
            // Its markers end with the record, so a merge that stopped here (the run cap, an erasure) no longer refuses the
            // guest's pin writes; the guest and its rows stay. Ended before its `global` step: another merge waiting on its
            // pins-left signal stops instead of waiting on. One at its run cap stays stopped ({@link MERGE_STOPPED_SCOPE}).
            if (to !== undefined && progress !== null && progress.run >= MAX_MERGE_RUNS) {
                await markMergeStopped(ctx.db, from, to, now);
            }

            await endStoppedMerge(ctx, from, to, now);
            await abandonPinsLeftOf(from);
            dropped += 1;

            continue;
        }

        if (finished) {
            await ctx.db.delete("idempotencyClaims", row._id);

            // As `releaseMergeLease` does for a finished merge: a run that wrote the fence and died before its release left
            // the lease, which never lapses. No run holds it (a held one was passed over above), so it goes with the record.
            if (lease !== null) {
                await ctx.db.delete("idempotencyClaims", lease._id);
            }

            dropped += 1;

            continue;
        }

        // The census goes once, after the records ({@link MERGE_SWEEP_CENSUS_STATEMENTS}).
        await writeMergeProgress(ctx.db, from, to, progress, now);
        await enqueueJob(internal.lib.account_merge.runGuestMerge, { from, ...(progress !== null && { resume: progress }), to }, { shardKey: to });
        authLogger.info(`[auth] restarted the stalled merge of guest ${from} into ${to}`);
        resumed += 1;
        resumedInto = to;
        checkAt(now + MERGE_STALL_MS);
    }

    const tag = last?.userId ?? cursor?.userId;

    // A pass that looked at the last record starts the next one from the first again.
    if (last === null || (rows.length < MERGE_PROGRESS_SCAN && last.key === rows.at(-1)?.key)) {
        if (cursor !== null) {
            await ctx.db.delete("idempotencyClaims", cursor._id);
            // The records before the cursor were not read here: the next pass reads them.
            checkAt(now);
        }
    } else {
        // Records past this pass's last are left to the next one.
        checkAt(now);

        if (tag !== undefined) {
            await writeClaim(ctx.db, MERGE_SWEEP_SCOPE, MERGE_SWEEP_KEY, now, { expiresAt: now + IMPORT_MARKER_TTL_MS, result: last.key, userId: tag });
        }
    }

    if (resumedInto !== undefined) {
        // Every restarted record is this shard's account's: one note of the shard covers them all.
        await noteShardActivity(ctx, resumedInto, now);
        await noteShardDue(ctx, now + MERGE_STALL_MS, resumedInto, { rearmPassed: true });
    }

    return { dropped, resumed, ...(nextCheckAt !== undefined && { nextCheckAt }) };
};

/** {@link resumeStalledMerges} from the housekeeping sweep (`shardSweeps()`). */
export const resumeStalledGuestMerges = internalMutation
    .input({})
    .output(v.object({ dropped: v.number(), resumed: v.number() }))
    .mutation(async ({ ctx }) => {
        const { dropped, resumed } = await resumeStalledMerges(ctx);

        return { dropped, resumed };
    });

/**
 * {@link resumeStalledGuestMerges} from the shard's minute tick (`shard-housekeeping.ts#runShardTick`), which the root
 * dispatches by due time, so a shard behind any number of more recently active ones is still reached. `nextCheckAt`: when
 * the tick should run the sweep again, absent once no record is left here.
 */
export const resumeStalledGuestMergesOnTick = internalMutation
    .input({})
    .output(v.object({ nextCheckAt: v.optional(v.number()) }))
    .mutation(async ({ ctx }) => {
        const { nextCheckAt } = await resumeStalledMerges(ctx);

        return nextCheckAt === undefined ? {} : { nextCheckAt };
    });

/**
 * The erasure fence of every step that hands the guest's data to the new account (the copy's and the clear's imports, the
 * contributor hand-over, the `global` and follows re-points, a pin route's move). {@link beginMergeRun} checks for an
 * erasure only at the run's start; one of either account that begins during the run is seen here, in the transaction that
 * would write, before anything is written. The merge then stops in that transaction and keeps the guest: its markers end
 * (so the erasure waits no longer), its progress record goes (nothing for the sweep to restart), and nothing more of the
 * guest's moves or is deleted on its shard; the guest's erasure takes what is left there. What a step wrote before the
 * erasure's marker was visible to it stays the new account's (`docs/agents/guest-merge.md`).
 */
const stoppedForErasure = async (ctx: Pick<MutationCtx, "db">, from: string, to: string, now: number): Promise<boolean> => {
    if (!(await isErasing(ctx, from)) && !(await isErasing(ctx, to))) {
        return false;
    }

    await endImporting(ctx, from, to, now);
    await endAccountMove(ctx, from, "merging");
    await dropMergeProgress(ctx.db, from);

    return true;
};

/**
 * On the NEW user's shard: insert `rows` of `table` under their own ids, re-owned. An id already here is brought up to
 * the guest's row as it is now (a row edited after the copy) only while it still holds what the merge last wrote there
 * (its import marker): a row the new account changed, or one written here by anything but the merge, stays as it is,
 * and an id whose marker remains but whose row is gone (the account deleted it) is not written again. `present` names
 * every id the guest's shard may now delete: each is on this shard as the merge or the account left it, or (for the
 * tables the new account keeps its own row of) handled. An id here with other content and no marker is left out: the
 * guest's row stays on its shard, never deleted unseen. Once the guest's merge has finished ({@link MERGE_FENCE_SCOPE}),
 * or another delivery has taken the merge's lease since this one did ({@link MERGE_LEASE_SCOPE}: its rows may be newer
 * than these), it writes nothing and confirms nothing: `fenced` tells the stale delivery to stop. Nor once an erasure of
 * either account has begun ({@link stoppedForErasure}): `erasing`, and the merge has stopped keeping the guest.
 */
export const importShardRows = internalMutation
    .input({ clearing: v.optional(v.boolean()), from: v.string(), generation: v.number(), rows: v.array(v.any()), table: v.string(), to: v.string() })
    .output(v.object({ erasing: v.optional(v.boolean()), fenced: v.boolean(), held: v.number(), imported: v.number(), present: v.array(v.string()) }))
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);
        const rows = args.rows as Record<string, unknown>[];
        const ids = rows.map((row) => row._id as string);
        const { now } = ctx;

        if ((await mergeFinished(ctx.db, args.from, now)) || !(await holdMergeLease(ctx.db, args.from, args.generation, now))) {
            return { fenced: true, held: 0, imported: 0, present: [] };
        }

        if (await stoppedForErasure(ctx, args.from, args.to, now)) {
            return { erasing: true, fenced: false, held: 0, imported: 0, present: [] };
        }

        if (args.table === "userSettings") {
            await carrySetupSteps(ctx, rows, args.from, args.to, now);

            return { fenced: false, held: 0, imported: 0, present: ids };
        }

        if (KEEP_NEW_USERS.has(args.table)) {
            return { fenced: false, held: 0, imported: 0, present: ids };
        }

        let imported = 0;
        let held = 0;
        let usageWritten = false;
        /** The ids the guest's shard may delete: none whose content is on this shard neither as the guest's nor by the account's choice. */
        const present: string[] = [];
        // Per organization: whether the new account's entry there is the guest's, handed over with its cohort.
        const handedOver = new Map<string, boolean>();

        for (const row of rows) {
            const id = row._id as string;
            const key = markerKey(args.from, args.table, id);
            const existing = (await db.get(args.table, id)) as Record<string, unknown> | null;
            let reowned = rewriteOwner(row, args.from, args.to);

            // An organization ledger row older than `ORGANIZATION_RECORD_LATE_MS` is in a week the organization view may already show. It
            // counts only in the cohort it was counted in: where the guest's entry became the new account's
            // (`handOverOrganizationContributors`), every cell stays as it was. Elsewhere (the account has its own entry, or the guest had
            // none yet) it would change a released week by the guest's spend: it still moves, held (`heldFrom`), so the account keeps it
            // in its export until retention prunes it, and the view never counts it. Nothing of the guest's is left behind to be deleted.
            // Decided once, at the row's first import: the clear's re-import keeps what the copy chose (the row's age has grown since,
            // and holding a row the view already counted would change a closed week too).
            if (args.table === "usageOrganizationReplies") {
                if (existing !== null) {
                    if (typeof existing["heldFrom"] === "string") {
                        reowned = { ...reowned, heldFrom: existing["heldFrom"] };
                    }
                } else if (typeof row["at"] === "number" && now - row["at"] > ORGANIZATION_RECORD_LATE_MS) {
                    const organizationId = String(row["organizationId"]);
                    let same = handedOver.get(organizationId);

                    if (same === undefined) {
                        const entry = await ctx.db.usageOrganizationContributors.findFirst({
                            consistency: "primary",
                            where: { organizationId, userId: args.to },
                        });

                        same = entry?.mergedFrom === args.from;
                        handedOver.set(organizationId, same);
                    }

                    if (!same) {
                        reowned = { ...reowned, heldFrom: typeof row["heldFrom"] === "string" ? row["heldFrom"] : args.from };
                    }
                }
            }

            const wanted = await rowDigest(args.table, reowned);
            const marker = await ctx.db
                .query("idempotencyClaims")
                .withIndex("by_scope_key", (q) => q.eq("scope", IMPORT_MARKER_SCOPE).eq("key", key))
                .first();
            // A marker counts however old it is: one written before markers stopped lapsing still says the merge wrote the row.
            const written = marker === null ? null : (marker.result ?? null);
            let write = false;

            if (existing === null) {
                // No marker: never here. A marker: the merge wrote it and the new account deleted it since.
                write = written === null;

                if (write) {
                    // The guest's count is its shard's, moved by its own trigger: here it is the user turns this shard
                    // already holds for the thread, and this shard's trigger counts each one imported after.
                    const own = args.table === "threads" ? { userTurnCount: await countUserTurns(ctx.db, id as Id<"threads">) } : {};

                    await db.insert(args.table, { ...reowned, ...own }, { allowExplicitId: true });
                    imported += 1;

                    if (typeof reowned["heldFrom"] === "string") {
                        held += 1;
                    }
                }
            } else {
                const current = await rowDigest(args.table, existing);

                if (current === wanted) {
                    // Already the guest's row: remember it, so a later guest edit may still follow.
                    write = written !== wanted;
                } else if (written === current) {
                    await db.replace(args.table, id, { ...withoutDerived(args.table, ownFields(reowned)), ...derivedOf(args.table, existing) });
                    write = true;
                } else if (written === null) {
                    // Here with other content and no marker (a copy by the merge code before markers, which the guest edited
                    // since, or a row nothing of the merge wrote): neither is overwritten, so the guest's row is not confirmed
                    // and stays on its shard; the guest is kept with it (`rowsRemain`).
                    authLogger.warn(`[auth] kept ${args.table} row ${id} of guest ${args.from}: the new account holds other content under its id`);

                    continue;
                }
                // Otherwise the new account changed the row since the merge wrote it: its edit stays.
            }

            present.push(id);

            // The clear's page: its delete on the guest's shard follows, so the reconcile leaves this row's copy alone.
            if (args.clearing === true && (await storedClaim(ctx.db, MERGE_CLEARED_SCOPE, key)) === null) {
                await ctx.db.insert("idempotencyClaims", {
                    claimedAt: now,
                    expiresAt: IMPORT_MARKER_EXPIRES_AT,
                    key,
                    scope: MERGE_CLEARED_SCOPE,
                    userId: args.to,
                });
            }

            if (write) {
                usageWritten ||= args.table === "usageOrganizationReplies" || args.table === "usageDaily";

                if (marker === null) {
                    await ctx.db.insert("idempotencyClaims", {
                        claimedAt: now,
                        expiresAt: IMPORT_MARKER_EXPIRES_AT,
                        key,
                        result: wanted,
                        scope: IMPORT_MARKER_SCOPE,
                        userId: args.to,
                    });
                } else {
                    await ctx.db.patch("idempotencyClaims", marker._id, { expiresAt: IMPORT_MARKER_EXPIRES_AT, result: wanted });
                }
            }
        }

        if (held > 0) {
            authLogger.info(`[auth] held ${String(held)} organization ledger rows of guest ${args.from} out of the organization view`, { to: args.to });
        }

        // Moved usage rows have no retention time on this shard (its census row was the guest's): wake it now, so the tick prunes them and
        // sets the exact time.
        if (usageWritten) {
            await noteRetentionDueAt(ctx, now);
            await noteShardDue(ctx, now);
        }

        return { fenced: false, held, imported, present };
    });

/**
 * On the NEW user's shard: once the guest's merge is done, fence it ({@link MERGE_FENCE_SCOPE}) and drop a page of its
 * import markers; `hasMore` while some may remain. The fence goes in with the first page, so no import ever runs
 * between a marker's drop and the fence. Markers and fence are this shard's own rows, not D1's: a page of deletes costs
 * no D1 statement. With the last page the merge's account-move markers ({@link beginMergeRun}) go. `fenced` when another
 * delivery holds the lease: that one finishes the merge.
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

        const hasMore =
            (await releaseClaimsWithPrefix(ctx, IMPORT_MARKER_SCOPE, `${args.from}:`)) ||
            (await releaseClaimsWithPrefix(ctx, MERGE_CLEARED_SCOPE, `${args.from}:`));

        if (!hasMore) {
            // The merge is over: its account-move markers go with the last page, so they end exactly when it does. Fenced,
            // no import carries a setup step again.
            const carried = await storedClaim(ctx.db, MERGE_CARRIED_STEPS_SCOPE, args.from);

            if (carried !== null) {
                await ctx.db.delete("idempotencyClaims", carried._id);
            }

            await endImporting(ctx, args.from, args.to, now);
            await endAccountMove(ctx, args.from, "merging");
        }

        return { fenced: false, hasMore };
    });

/**
 * On the GUEST's shard: delete the moved rows. A row whose digest no longer matches was changed after the clear read
 * it, so the new shard holds an older copy: it stays, and the clear's next page reads and imports it again. `gone` names
 * each id already deleted here since the clear read it: the new shard holds a copy of a row the guest no longer has,
 * which the clear takes back there ({@link dropRowsGoneFromGuest}). `changed` names each row kept for its new digest.
 * Nothing is deleted for a delivery whose generation is no longer this shard's newest (`fenced`).
 */
export const deleteShardRows = internalMutation
    .input({ from: v.string(), generation: v.number(), rows: v.array(v.object({ digest: v.string(), id: v.string() })), table: v.string() })
    .output(v.object({ changed: v.array(v.string()), fenced: v.boolean(), gone: v.array(v.string()) }))
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);
        const { now } = ctx;

        if (!(await mergeGenerationCurrent(ctx.db, args.from, args.generation))) {
            return { changed: [], fenced: true, gone: [] };
        }

        // A shard serving other users too: none of its rows is the merge's to delete.
        if (!onGuestShard(args.from)) {
            return { changed: [], fenced: false, gone: [] };
        }

        let deleted = false;
        const changed: string[] = [];
        const gone: string[] = [];

        for (const { digest, id } of args.rows) {
            const row = (await db.get(args.table, id)) as Record<string, unknown> | null;

            if (row === null) {
                gone.push(id);
            } else if ((await rowDigest(args.table, row)) === digest) {
                await db.delete(args.table, id);
                deleted = true;
            } else {
                changed.push(id);
            }
        }

        // Pins on the guest's threads (other users' among them) now sit on the new account's shard, while their routes still
        // name the guest until the `global` step: another merge's pin pass reading this shard in between must wait for them.
        if (deleted && args.table === "threadPins") {
            await writeClaim(ctx.db, MERGE_PINS_LEFT_SCOPE, args.from, now, { expiresAt: IMPORT_MARKER_EXPIRES_AT, result: "", userId: args.from });
        }

        return { changed, fenced: false, gone };
    });

/**
 * On the NEW user's shard: take back the copies of rows the guest deleted on its shard after the clear read them
 * ({@link deleteShardRows}' `gone`). Only a row that still holds what the merge last wrote (its import marker) goes:
 * one the account changed since, or one no merge wrote, stays. The marker stays too, so no later import of the id writes
 * it again; it goes with the merge's end. `changed`: rows the guest's shard kept for a newer digest, which lose the
 * clear's record ({@link MERGE_CLEARED_SCOPE}) until the clear reads them again, so a deletion before that read still
 * reaches the reconcile. Also the reconcile's drop ({@link listUnclearedImports}). `fenced` as for {@link importShardRows}.
 */
export const dropRowsGoneFromGuest = internalMutation
    .input({ changed: v.optional(v.array(v.string())), from: v.string(), generation: v.number(), ids: v.array(v.string()), table: v.string(), to: v.string() })
    .output(v.object({ dropped: v.number(), fenced: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);
        const { now } = ctx;

        if ((await mergeFinished(ctx.db, args.from, now)) || !(await holdMergeLease(ctx.db, args.from, args.generation, now))) {
            return { dropped: 0, fenced: true };
        }

        const changed = args.changed ?? [];

        for (const id of changed) {
            const record = await storedClaim(ctx.db, MERGE_CLEARED_SCOPE, markerKey(args.from, args.table, id));

            if (record !== null) {
                await ctx.db.delete("idempotencyClaims", record._id);
            }
        }

        let dropped = 0;

        // One at a time: an audited table's delete writes its history row to D1.
        for (const id of args.ids) {
            const existing = (await db.get(args.table, id)) as Record<string, unknown> | null;

            if (existing === null) {
                continue;
            }

            const marker = await ctx.db
                .query("idempotencyClaims")
                .withIndex("by_scope_key", (q) => q.eq("scope", IMPORT_MARKER_SCOPE).eq("key", markerKey(args.from, args.table, id)))
                .first();

            if (marker !== null && marker.result === (await rowDigest(args.table, existing))) {
                await db.delete(args.table, id);
                dropped += 1;
            }
        }

        return { dropped, fenced: false };
    });

/**
 * On the NEW user's shard, once the clear has emptied `table` on the guest's: a page of the guest's import markers of it
 * after the marker key `after`, and the ids of those the clear never read ({@link MERGE_CLEARED_SCOPE}). The copy wrote
 * them and the guest deleted them before the clear's read; the reconcile asks the guest's shard which are gone
 * ({@link listRowsMissingOnGuest}) and takes their copies back ({@link dropRowsGoneFromGuest}). `next`: the key to read on
 * from, `null` after the last page. A page is the clear's page size, so its drop stays within the D1 budget.
 */
export const listUnclearedImports = internalQuery
    .input({ after: v.union(v.string(), v.null()), from: v.string(), table: v.string() })
    .output(v.object({ ids: v.array(v.string()), next: v.union(v.string(), v.null()) }))
    .query(async ({ args, ctx }) => {
        const prefix = markerKey(args.from, args.table, "");
        const limit = pageSizeFor(args.table);
        const { after } = args;
        const markers = await ctx.db
            .query("idempotencyClaims")
            .withIndex("by_scope_key", (q) =>
                (after === null ? q.eq("scope", IMPORT_MARKER_SCOPE).gte("key", prefix) : q.eq("scope", IMPORT_MARKER_SCOPE).gt("key", after)).lt(
                    "key",
                    prefixEnd(prefix),
                ),
            )
            .take(limit);
        const ids: string[] = [];

        for (const marker of markers) {
            if ((await storedClaim(ctx.db, MERGE_CLEARED_SCOPE, marker.key)) === null) {
                ids.push(marker.key.slice(prefix.length));
            }
        }

        return { ids, next: markers.length < limit ? null : markers.at(-1)!.key };
    });

/** On the GUEST's shard: which of `ids` of `table` it no longer holds; none on a shard that is not the guest's own ({@link onGuestShard}). */
export const listRowsMissingOnGuest = internalQuery
    .input({ from: v.string(), ids: v.array(v.string()), table: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => {
        if (!onGuestShard(args.from)) {
            return [];
        }

        const db = rawDb(ctx);
        const missing: string[] = [];

        for (const id of args.ids) {
            if ((await db.get(args.table, id)) === null) {
                missing.push(id);
            }
        }

        return missing;
    });

/**
 * The claim scope of a guest shard whose pins the clear has moved to the new account's shard (keyed by the guest's id,
 * on the guest's shard): the routes of those pins still name the guest as the thread's owner until the merge's `global`
 * step re-points them. A merge of one of the pins' authors that reaches this shard through such a route finds no pin of
 * its guest here, yet one may still arrive on the route's next shard; its `repins` step waits ({@link pinsLeftShard}).
 * Never by time ({@link IMPORT_MARKER_EXPIRES_AT}): a merge stalled between its clear and its `global` step leaves the
 * routes naming this shard for as long as it stays stalled. Dropped once that step has re-pointed them
 * ({@link resolvePinsLeft}) or with the guest's deletion; tagged with the guest, so its erasure takes it too.
 */
export const MERGE_PINS_LEFT_SCOPE = "guest-merge-pins-left";

/**
 * The pins-left signal's `result` once the merge that wrote it stopped before its `global` step (an erasure, a gone account,
 * the run cap): the routes will never be re-pointed, so the pins it moved stay where no route leads. A merge that would
 * wait on it stops instead and keeps its guest ({@link pinsLeftShard}); a later run of the owner's merge that clears pins
 * again writes the signal anew, and its `global` step drops it.
 */
export const PINS_LEFT_ABANDONED = "abandoned";

/**
 * On a thread owner's shard: whether its guest merge's clear has moved the pins here away ({@link MERGE_PINS_LEFT_SCOPE}),
 * and `abandoned` when that merge stopped before re-pointing their routes ({@link PINS_LEFT_ABANDONED}). A signal whose
 * time has passed still counts: only the merge's `global` step ends it.
 */
export const pinsLeftShard = internalMutation
    .input({ ownerId: v.string() })
    .output(v.object({ abandoned: v.boolean(), left: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const row = await storedClaim(ctx.db, MERGE_PINS_LEFT_SCOPE, args.ownerId);

        return { abandoned: row?.result === PINS_LEFT_ABANDONED, left: row !== null };
    });

/**
 * On the GUEST's shard, once its merge stopped before its `global` step: its pins-left signal, if there is one, says so
 * ({@link PINS_LEFT_ABANDONED}). Only a signal already here is marked: none is written for a merge whose clear moved no
 * pin, nor one the guest's erasure took. Marking it never loses a pin, whichever delivery runs it: another merge that
 * would wait on it keeps its guest instead, and a live run of this merge that clears pins again writes it anew.
 */
export const abandonPinsLeft = internalMutation
    .input({ from: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await storedClaim(ctx.db, MERGE_PINS_LEFT_SCOPE, args.from);

        if (row !== null && row.result !== PINS_LEFT_ABANDONED) {
            await ctx.db.patch("idempotencyClaims", row._id, { result: PINS_LEFT_ABANDONED });
        }

        return null;
    });

/** Drops the guest's pins-left signal ({@link MERGE_PINS_LEFT_SCOPE}); on the guest's shard. */
export const dropPinsLeft = async (db: MutationCtx["db"], from: string): Promise<void> => {
    const row = await storedClaim(db, MERGE_PINS_LEFT_SCOPE, from);

    if (row !== null) {
        await db.delete("idempotencyClaims", row._id);
    }
};

/**
 * On the GUEST's shard, once the merge's `global` step is done: the routes of the pins its clear moved away now name the
 * new account, so another merge's `repins` step reaches them there and need not wait on this shard any more. Nothing is
 * dropped for a delivery whose generation is no longer this shard's newest (`fenced`): the newer one's clear may have
 * moved pins again since.
 */
export const resolvePinsLeft = internalMutation
    .input({ from: v.string(), generation: v.number() })
    .output(v.object({ fenced: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        if (!(await mergeGenerationCurrent(ctx.db, args.from, args.generation))) {
            return { fenced: true };
        }

        await dropPinsLeft(ctx.db, args.from);

        return { fenced: false };
    });

/**
 * On the GUEST's shard, right before the guest is deleted: the first shard-local table that still holds a row of the
 * guest's (one written after the clear emptied it), or `null`. Scoped as {@link listShardRowsToClear} is: the guest's
 * own row of the tables the new account keeps its own of, any row of every other table, on the guest's own shard only
 * ({@link onGuestShard}; `auth/hooks.ts#deleteMergedGuest` keeps the guest on any other). One `take(1)` a table, all on
 * the shard's own SQLite: no D1 statement and no subrequest. The `.global()` tables naming a user are skipped: they are
 * no shard's rows (none is shard-local in the deploy; the test harness keeps them on the shard).
 */
export const firstTableWithGuestRows = async (ctx: { db: unknown }, guestId: string): Promise<string | null> => {
    if (!onGuestShard(guestId)) {
        return null;
    }

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

/** Organization contributor entries one {@link handOverOrganizationContributors} call decides. */
const HAND_OVER_BATCH = 50;

/**
 * On the NEW user's shard, before any row is copied (the merge's `contributors` phase): each of the guest's organization contributor
 * entries becomes the new account's, in the guest's cohort and marked with the guest (`mergedFrom`), so the copy moves the guest's ledger
 * rows into the cohort that counted them and no closed week changes. Where the new account already has an entry under the organization, or
 * ledger rows there of its own, the guest's entry stays the guest's, marked, and goes once the guest's shard is empty
 * ({@link reassignGlobalRows}): the cohort that held the guest then shows without them, as one that lost a member does, and the guest's
 * closed-week rows stay out of the view. A marked entry keeps its cohort withheld, and keeps the guest from being booked again while rows of
 * theirs are still on their shard (`usage/cohorts.ts#insertContributor`). Handing over first also means a reply the new account records
 * during the merge finds an entry, and books no cohort of its own that the guest's rows would then land in. Nothing for a delivery whose
 * lease a later one took (`fenced`); each call is safe to run twice (a decided entry leaves the filter).
 */
export const handOverOrganizationContributors = internalMutation
    .input({ from: v.string(), generation: v.number(), to: v.string() })
    .output(v.object({ done: v.boolean(), erasing: v.optional(v.boolean()), fenced: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        if ((await mergeFinished(ctx.db, args.from, ctx.now)) || !(await holdMergeLease(ctx.db, args.from, args.generation, ctx.now))) {
            return { done: false, fenced: true };
        }

        if (await stoppedForErasure(ctx, args.from, args.to, ctx.now)) {
            return { done: false, erasing: true, fenced: false };
        }

        // Primary reads: a decided entry is marked, and leaves the filter, so the next call starts where this one stopped.
        const { page } = await ctx.db.usageOrganizationContributors.findMany({
            consistency: "primary",
            limit: HAND_OVER_BATCH + 1,
            where: { mergedFrom: { isNull: true }, userId: args.from },
        });

        for (const entry of page.slice(0, HAND_OVER_BATCH)) {
            const { organizationId } = entry;
            const kept = await ctx.db.usageOrganizationContributors.findFirst({ consistency: "primary", where: { organizationId, userId: args.to } });
            // Rows with no entry yet (a reconcile still to run): they would join the guest's cohort and change its closed weeks.
            const ownRows = kept
                ? undefined
                : await ctx.db.usageOrganizationReplies.findFirst({
                      consistency: "primary",
                      where: { heldFrom: { isNull: true }, organizationId, userId: args.to },
                  });

            if (kept || ownRows) {
                await ctx.db.patch("usageOrganizationContributors", entry._id, { mergedFrom: args.from });
            } else {
                await ctx.db.patch("usageOrganizationContributors", entry._id, { mergedFrom: args.from, userId: args.to });
            }
        }

        return { done: page.length <= HAND_OVER_BATCH, fenced: false };
    });

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
    // `guestDrained: false` when rows are still on the guest's shard: the organization contributor entries are left as the hand-over
    // marked them (their cohorts withheld), so the guest's leftover ledger rows are never booked into a cohort of their own. The merge's
    // `global` step runs only after its clear emptied the guest's shard, so it never passes `false`.
    .input({ from: v.string(), generation: v.number(), guestDrained: v.optional(v.boolean()), to: v.string() })
    .output(v.object({ done: v.boolean(), erasing: v.optional(v.boolean()), fenced: v.optional(v.boolean()), reassigned: v.number() }))
    .mutation(async ({ args, ctx }) => {
        // In the transaction that writes: a delivery whose lease a later one took (one that may have stopped the merge for an
        // erasure since) re-points nothing, nor does one that finds an erasure begun since its run's start.
        if (!(await holdMergeLease(ctx.db, args.from, args.generation, ctx.now))) {
            return { done: false, fenced: true, reassigned: 0 };
        }

        if (await stoppedForErasure(ctx, args.from, args.to, ctx.now)) {
            return { done: false, erasing: true, reassigned: 0 };
        }

        const facades = ctx.db as unknown as Record<
            string,
            {
                findMany: (options: { consistency: "primary"; limit: number; where: Record<string, string> }) => Promise<{ page: Record<string, unknown>[] }>;
            }
        >;
        let reassigned = 0;

        const settleContributors = args.guestDrained !== false;

        for (const [table, columns] of Object.entries(GLOBAL_USER_COLUMNS)) {
            if (table === "usageOrganizationContributors" && !settleContributors) {
                continue;
            }

            for (const column of columns) {
                const room = Math.min(REASSIGN_BATCH - reassigned, REASSIGN_BATCH_BY_TABLE[table] ?? REASSIGN_BATCH);

                if (room <= 0) {
                    // Primary reads: a patch moves its row out of the filter, so the next call starts where this one stopped.
                    return { done: false, reassigned };
                }

                const { page } = await facades[table]!.findMany({ consistency: "primary", limit: room + 1, where: { [column]: args.from } });

                for (const row of page.slice(0, room)) {
                    // The new account may already be a contributor under the organization: its one entry is kept, and the guest's copy goes,
                    // so the member's ledger is never summed twice. So does an entry the hand-over marked to go, whatever the new account
                    // now has: moved, it would bring the new account's own closed weeks into the guest's cohort.
                    if (table === "usageOrganizationContributors") {
                        const kept = await ctx.db.usageOrganizationContributors.findFirst({
                            consistency: "primary",
                            where: { organizationId: String(row.organizationId), userId: args.to },
                        });

                        if (kept || typeof row.mergedFrom === "string") {
                            await ctx.db.delete(table as never, row._id as never);
                            reassigned += 1;

                            continue;
                        }
                    }

                    await ctx.db.patch(table as never, row._id as never, { [column]: args.to } as never);
                    reassigned += 1;
                }

                if (page.length > room) {
                    return { done: false, reassigned };
                }
            }
        }

        // The guest's rows are copied and deleted: each entry a hand-over marked (`handOverOrganizationContributors`) is settled against the
        // ledger rows the new account now has, as the reconcile would: unmarked where it has some, gone where it has none (a stale entry, or
        // rows the prune took). The view withholds the entry's cohort until then.
        if (settleContributors) {
            const markRoom = Math.min(REASSIGN_BATCH - reassigned, HAND_OVER_BATCH);

            if (markRoom <= 0) {
                return { done: false, reassigned };
            }

            const { page: marked } = await ctx.db.usageOrganizationContributors.findMany({
                consistency: "primary",
                limit: markRoom + 1,
                where: { mergedFrom: args.from, userId: args.to },
            });

            for (const entry of marked.slice(0, markRoom)) {
                const row = await ctx.db.usageOrganizationReplies.findFirst({
                    consistency: "primary",
                    where: { heldFrom: { isNull: true }, organizationId: entry.organizationId, userId: args.to },
                });

                if (row) {
                    await patchRow(ctx.db as never, "usageOrganizationContributors", entry, { mergedFrom: undefined });
                } else {
                    await ctx.db.delete("usageOrganizationContributors", entry._id);
                }

                reassigned += 1;
            }

            if (marked.length > markRoom) {
                return { done: false, reassigned };
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
 * a D1 read and write per row would otherwise pass the Worker's subrequest ceiling at a few hundred follows. On the new
 * account's shard; nothing for a delivery whose lease a later one took (`fenced`).
 */
export const reassignThreadFollowsPage = internalMutation
    .input({ from: v.string(), generation: v.number(), to: v.string() })
    .output(v.object({ erasing: v.optional(v.boolean()), fenced: v.optional(v.boolean()), hasMore: v.boolean(), moved: v.number() }))
    .mutation(async ({ args, ctx }) => {
        if (!(await holdMergeLease(ctx.db, args.from, args.generation, ctx.now))) {
            return { fenced: true, hasMore: false, moved: 0 };
        }

        if (await stoppedForErasure(ctx, args.from, args.to, ctx.now)) {
            return { erasing: true, hasMore: false, moved: 0 };
        }

        return await mergeThreadFollowsPage(ctx.db, args.from, args.to);
    });

/** The first `.global()` pin route that still names the guest, with the shard its pins live on; `null` once none does. */
export const nextSharedPinRoute = internalQuery
    .input({ from: v.string() })
    .output(v.union(v.object({ ownerId: v.string(), threadId: v.string() }), v.null()))
    .query(async ({ args, ctx }) => await firstPinRouteOf(ctx.db, args.from));

/** The owner shard the new account's route on `threadId` names now, or `null` once it has none there. */
export const sharedPinRouteOwner = internalQuery
    .input({ threadId: v.string(), userId: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => await pinRouteOwnerOf(ctx.db, args.userId, args.threadId));

/**
 * On the NEW user's shard, when another guest's merge it waits on in its `repins` step stopped before re-pointing its
 * routes ({@link PINS_LEFT_ABANDONED}): this merge stops too and keeps its guest, whose pins may sit where no route leads.
 * Its markers end and its progress record goes, as for a merge an erasure stopped; nothing for a delivery whose lease a
 * later one took (`superseded`).
 */
export const stopMergeKeepingGuest = internalMutation
    .input({ dropLease: v.optional(v.boolean()), from: v.string(), generation: v.number(), to: v.string() })
    .output(v.object({ superseded: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;

        if (!(await holdMergeLease(ctx.db, args.from, args.generation, now))) {
            return { superseded: true };
        }

        await endImporting(ctx, args.from, args.to, now);
        await endAccountMove(ctx, args.from, "merging");
        await dropMergeProgress(ctx.db, args.from);

        if (args.dropLease === true) {
            // A merge stopped for good (its run cap): the stop record refuses every later delivery before it takes a lease.
            await markMergeStopped(ctx.db, args.from, args.to, now);

            const lease = await storedClaim(ctx.db, MERGE_LEASE_SCOPE, args.from);

            if (lease !== null) {
                await ctx.db.delete("idempotencyClaims", lease._id);
            }
        }

        return { superseded: false };
    });

/**
 * Hands the guest's pin route on `threadId` to the new account, once the guest's pins there have moved. On the new
 * account's shard; nothing for a delivery whose lease a later one took (`fenced`).
 */
export const moveSharedPinRouteOf = internalMutation
    .input({ from: v.string(), generation: v.number(), threadId: v.string(), to: v.string() })
    .output(v.object({ erasing: v.optional(v.boolean()), fenced: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        if (!(await holdMergeLease(ctx.db, args.from, args.generation, ctx.now))) {
            return { fenced: true };
        }

        if (await stoppedForErasure(ctx, args.from, args.to, ctx.now)) {
            return { erasing: true, fenced: false };
        }

        await moveSharedPinRoute(ctx.db, args.from, args.to, args.threadId);

        return { fenced: false };
    });

/**
 * On the NEW user's shard, at the start of each run, while the run holds the lease: mark the guest as merging and the new
 * account as importing (`lib/account-moves.ts`), renewed every run so a long merge keeps them live. A merging marker refuses
 * the guest's pin writes; an importing one holds back the new account's erasure. Each side writes its marker before it
 * reads the other's, so a merge and an erasure always see each other. Then:
 *
 * - `finished`: the merge's fence is here, so a delivery finished it; nothing is marked. With `cleanup` its markers phase
 *   is not over ({@link mergeCleanupPending}): the run drops the rest of the import markers and then both account-move
 *   markers, and renews neither, so an erasure waiting on them is held back no longer than their age allows;
 * - `stopped`: either account is being erased, which has priority; the markers go and the merge ends;
 * - `pinWritesUntil`: a pin write of the guest's may still be in flight until then; the run waits for it;
 * - `superseded`: the lease is no longer `generation`'s, so a later delivery took the merge over; nothing is touched, so
 *   an older delivery resuming late can neither end nor renew the markers the newer one is relying on.
 */
export const beginMergeRun = internalMutation
    .input({ from: v.string(), generation: v.number(), to: v.string() })
    .output(
        v.object({
            cleanup: v.boolean(),
            finished: v.boolean(),
            pinWritesUntil: v.union(v.number(), v.null()),
            stopped: v.boolean(),
            superseded: v.boolean(),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const { now } = ctx;

        // The account was erased after this run took its lease: its erasing marker is gone with it, so this is the check.
        if (!(await isMergeDestination(ctx, args.to))) {
            await endStoppedMerge(ctx, args.from, args.to, now);

            return { cleanup: false, finished: false, pinWritesUntil: null, stopped: true, superseded: false };
        }

        if (!(await holdMergeLease(ctx.db, args.from, args.generation, now))) {
            return { cleanup: false, finished: false, pinWritesUntil: null, stopped: false, superseded: true };
        }

        if (await mergeFinished(ctx.db, args.from, now)) {
            return {
                cleanup: await mergeCleanupPending(ctx, args.from, args.to),
                finished: true,
                pinWritesUntil: null,
                stopped: false,
                superseded: false,
            };
        }

        await beginAccountMove(ctx, args.from, "merging", now);
        await beginImporting(ctx, args.from, args.to, now);

        if ((await isErasing(ctx, args.to)) || (await isErasing(ctx, args.from))) {
            await endImporting(ctx, args.from, args.to, now);
            await endAccountMove(ctx, args.from, "merging");
            // The merge ends here: nothing is left for the stalled-merge sweep to restart.
            await dropMergeProgress(ctx.db, args.from);

            return { cleanup: false, finished: false, pinWritesUntil: null, stopped: true, superseded: false };
        }

        return {
            cleanup: false,
            finished: false,
            pinWritesUntil: await pinWritesInFlightUntil(ctx, args.from, now),
            stopped: false,
            superseded: false,
        };
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
export type MergePhase = "clear" | "contributors" | "copy" | "follows" | "global" | "guest" | "markers" | "pins" | "reconcile" | "repins";

/** Where a merge run stopped, for the next run to start from: the step, its table and that table's copy cursor. */
export interface MergeProgress {
    cursor: string | null;
    moved: number;
    phase: MergePhase;
    /** The route of the page at `cursor` the `repins` step stopped at; another phase ignores it. */
    route?: number;
    /**
     * That route's thread: the page is read again on resume, and a route deleted or added before it since moves its
     * index, so the step finds it by thread. Gone too, the page is walked again from its first route (each is safe twice).
     */
    routeThread?: string;
    /** Runs taken so far. */
    run: number;
    /** The table the copy, the clear or the reconcile stopped in; another phase ignores it. */
    table: string;
}

/** A run's position and what it may still spend: {@link MergeProgress} while it runs. */
interface MergeState {
    calls: number;
    cursor: string | null;
    /** Set by a step that must wait: the run stops, and the next one is queued this many milliseconds later. */
    deferMs: number | null;
    index: number;
    moved: number;
    phase: MergePhase;
    route: number;
    /** The thread of the route the `repins` step works on next, found again by it in each read of the page. */
    routeThread: string | null;
    /** Set by a step that ended the merge with the guest kept ({@link stopMergeKeepingGuest}). */
    stopped: boolean;
    /** Set by a step that stopped because another delivery finished the merge or took it over. */
    superseded: boolean;
}

/** How long a `repins` step waits for the pins another merge's clear moved away to be routed where they now are. */
export const PINS_LEFT_RECHECK_MS = 60 * 1000;

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
const STEP_CALLS: Readonly<Record<MergePhase, number>> = {
    clear: 4,
    contributors: 1,
    copy: 2,
    follows: 1,
    global: 2,
    guest: 2,
    markers: 1,
    pins: 3,
    reconcile: 3,
    repins: 4,
};

/** Moves `state` to the first table of `phase`. */
const enter = (state: MergeState, phase: MergePhase): void => {
    state.phase = phase;
    state.index = 0;
    state.cursor = null;
    state.route = 0;
    state.routeThread = null;
};

/** Moves `state` past its table, and on to `phase` after the last one, so a run never stops between them. */
const nextTable = (state: MergeState, tables: string[], phase: MergePhase): void => {
    state.index += 1;
    state.cursor = null;

    if (state.index >= tables.length) {
        enter(state, phase);
    }
};

/**
 * An owner shard refused to move the guest's pins (`erasing`): an erasure of either account began after this run's start,
 * and it has priority; or the guest's own shard is one other users share. The merge stops and keeps its guest; its markers end and its record goes
 * ({@link stopMergeKeepingGuest}), unless a later delivery holds the lease (`superseded`). One call.
 */
const stopKeepingGuest = async ({ call, from, generation, references, to }: MergeContext, state: MergeState): Promise<boolean> => {
    state.calls -= 1;
    const { superseded }: { superseded: boolean } = await call(references.stopKeepingGuest, { from, generation, to }, to);

    state.stopped = !superseded;
    state.superseded = superseded;

    return true;
};

/**
 * A step's transfer found an erasure of either account begun since this run's start, and stopped the merge in its own
 * transaction ({@link stoppedForErasure}): the run ends with the guest kept, no further call made.
 */
const stoppedByErasure = (state: MergeState): boolean => {
    state.stopped = true;

    return true;
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

        const { calls, outcome } = await clearPage(call, references, table, { from, generation, to });

        state.calls -= calls;

        if (outcome === "erasing") {
            return stoppedByErasure(state);
        }

        if (outcome === "fenced") {
            state.superseded = true;

            return true;
        }

        // The table is empty on the guest's shard: its copies of rows the clear never read are reconciled before the next.
        if (outcome === "empty") {
            state.phase = "reconcile";
            state.cursor = null;
        }

        return false;
    },
    // A batch of the guest's organization contributor entries, handed over before any row is copied, so the copy knows
    // which ledger rows keep their cohort ({@link handOverOrganizationContributors}).
    contributors: async ({ call, from, generation, references, to }, state) => {
        state.calls -= 1;
        const { done, erasing, fenced }: { done: boolean; erasing?: boolean; fenced: boolean } = await call(
            references.handOverContributors,
            { from, generation, to },
            to,
        );

        if (erasing === true) {
            return stoppedByErasure(state);
        }

        if (fenced) {
            state.superseded = true;

            return true;
        }

        if (done) {
            enter(state, "copy");
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
            { cursor: state.cursor, from, table },
            from,
        );

        if (page.page.length > 0) {
            state.calls -= 1;
            const { erasing, fenced }: { erasing?: boolean; fenced: boolean } = await call(
                references.importRows,
                { from, generation, rows: page.page, table, to },
                to,
            );

            if (erasing === true) {
                return stoppedByErasure(state);
            }

            // Another delivery finished this merge, or took it over: this one read its rows before that and must write none of them.
            if (fenced) {
                state.superseded = true;

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
    follows: async ({ call, from, generation, references, to }, state) => {
        state.calls -= 1;
        const page: { erasing?: boolean; fenced?: boolean; hasMore: boolean; moved: number } = await call(
            references.reassignFollows,
            { from, generation, to },
            to,
        );

        if (page.erasing === true) {
            return stoppedByErasure(state);
        }

        if (page.fenced === true) {
            state.superseded = true;

            return true;
        }

        state.moved += page.moved;

        if (!page.hasMore) {
            enter(state, "pins");
        }

        return false;
    },
    // Each call moves at most `REASSIGN_BATCH` rows, so a guest with many never hits the statement cap.
    global: async ({ call, from, generation, references, to }, state) => {
        state.calls -= 1;
        const {
            done,
            erasing,
            fenced: stale,
        }: { done: boolean; erasing?: boolean; fenced?: boolean } = await call(references.reassignGlobal, { from, generation, to }, to);

        if (erasing === true) {
            return stoppedByErasure(state);
        }

        if (stale === true) {
            state.superseded = true;

            return true;
        }

        if (done) {
            // The routes name the new account now: the guest's shard stops holding other merges' `repins` steps back.
            state.calls -= 1;
            const { fenced }: { fenced: boolean } = await call(references.resolvePinsLeft, { from, generation }, from);

            if (fenced) {
                state.superseded = true;

                return true;
            }

            enter(state, "follows");
        }

        return false;
    },
    // Only now: every table was copied, then cleared to empty, so nothing of the guest's is left to move.
    guest: async (context, state) => {
        const { call, from, generation, references, tables, to } = context;

        // A `.global()` row the guest wrote after the `global` step (a project made meanwhile) still names the guest: moved
        // here before the guest goes, and then the merge goes back to that step, the guest kept until it is done again.
        state.calls -= 1;
        const global: { done: boolean; erasing?: boolean; fenced?: boolean; reassigned: number } = await call(
            references.reassignGlobal,
            { from, generation, to },
            to,
        );

        if (global.erasing === true) {
            return stoppedByErasure(state);
        }

        if (global.fenced === true) {
            state.superseded = true;

            return true;
        }

        if (!global.done || global.reassigned > 0) {
            enter(state, "global");

            return false;
        }

        state.calls -= 1;
        const result: {
            deleted: boolean;
            fenced?: boolean;
            followsRemain?: boolean;
            pinsRemain?: boolean;
            rowsRemain?: string;
            sharedShard?: boolean;
        } = await call(references.deleteGuest, { generation, userId: from }, from);

        if (result.fenced === true) {
            state.superseded = true;

            return true;
        }

        // The guest was kept on a store other users share: none of its rows moved, so the merge stops with it, never fenced done.
        if (result.sharedShard === true) {
            return await stopKeepingGuest(context, state);
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

        state.superseded = fenced;

        return fenced || !hasMore;
    },
    // The guest's pins on one thread another user owns, moved on that owner's shard, a batch per step; its route follows
    // only once none is left. Right before the guest's deletion, which sends the merge back here while a route remains.
    pins: async (context, state) => {
        const { call, from, generation, references, to } = context;

        state.calls -= 1;
        const route: { ownerId: string; threadId: string } | null = await call(references.nextPinRoute, { from }, to);

        if (route === null) {
            enter(state, "repins");

            return false;
        }

        state.calls -= 1;
        const { erasing, hasMore }: { erasing?: boolean; hasMore: boolean } = await call(
            references.reassignPins,
            { from, threadId: route.threadId, to },
            route.ownerId,
        );

        if (erasing === true) {
            return await stopKeepingGuest(context, state);
        }

        if (!hasMore) {
            state.calls -= 1;
            const { erasing: routeErasing, fenced }: { erasing?: boolean; fenced?: boolean } = await call(
                references.movePinRoute,
                { from, generation, threadId: route.threadId, to },
                to,
            );

            if (routeErasing === true) {
                return stoppedByErasure(state);
            }

            if (fenced === true) {
                state.superseded = true;

                return true;
            }
        }

        return false;
    },
    // A page of the cleared table's import markers the clear never read: a row the guest deleted after the copy is missing
    // from its shard now, and its copy goes unless the account changed it (`dropRowsGoneFromGuest`). Then the next table.
    reconcile: async ({ call, from, generation, references, tables, to }, state) => {
        const table = tables[state.index];

        if (table === undefined) {
            enter(state, "global");

            return false;
        }

        state.calls -= 1;
        const { ids, next }: { ids: string[]; next: string | null } = await call(references.listUncleared, { after: state.cursor, from, table }, to);
        let present = false;

        if (ids.length > 0) {
            state.calls -= 1;
            const missing: string[] = await call(references.missingOnGuest, { from, ids, table }, from);

            present = missing.length < ids.length;

            if (missing.length > 0) {
                state.calls -= 1;
                const { fenced }: { fenced: boolean } = await call(references.dropGone, { from, generation, ids: missing, table, to }, to);

                if (fenced) {
                    state.superseded = true;

                    return true;
                }
            }
        }

        // A row still on the guest's shard came back after the clear emptied the table: the clear reads it again, so a
        // deletion of it after this check is seen there (the table empty again, the next reconcile finds it gone).
        if (present) {
            state.phase = "clear";
            state.cursor = null;
        } else if (next === null) {
            state.phase = "clear";
            nextTable(state, tables, "global");
        } else {
            state.cursor = next;
        }

        return false;
    },
    // A second pass over every route the new account holds, its own and the guest's moved ones, a route per step: an owner's
    // parallel merge can move a thread's shard, and so the guest's pins on it, after the pins step read the route and before
    // it moved them. The route has followed the owner by now, so this pass reaches the pins where they are, unless that
    // merge's clear has moved them on and its `global` step has not re-pointed the route yet: then the step waits for it.
    repins: async (context, state) => {
        const { call, from, generation, references, to } = context;

        state.calls -= 1;
        const routes: { continueCursor: string | null; isDone: boolean; page: { ownerId: string; threadId: string }[] } = await call(
            references.listPinRoutes,
            { cursor: state.cursor, userId: to },
            to,
        );

        // The route is found again by its thread: a route deleted or added before it since the last read moves its index.
        if (state.routeThread !== null && routes.page[state.route]?.threadId !== state.routeThread) {
            const thread = state.routeThread;

            state.route = Math.max(
                0,
                routes.page.findIndex((each) => each.threadId === thread),
            );
        }

        const route = routes.page[state.route];

        if (route === undefined) {
            if (routes.isDone || routes.continueCursor === null) {
                enter(state, "guest");
            } else {
                state.cursor = routes.continueCursor;
                state.route = 0;
                state.routeThread = null;
            }

            return false;
        }

        state.calls -= 1;
        const { erasing, hasMore }: { erasing?: boolean; hasMore: boolean } = await call(
            references.reassignPins,
            { from, threadId: route.threadId, to },
            route.ownerId,
        );

        if (erasing === true) {
            return await stopKeepingGuest(context, state);
        }

        if (!hasMore && route.ownerId !== from && route.ownerId !== to) {
            state.calls -= 1;
            const { abandoned, left }: { abandoned?: boolean; left: boolean } = await call(references.pinsLeft, { ownerId: route.ownerId }, route.ownerId);

            // That merge stopped with the pins it moved where no route leads, and will not re-point it: waiting would only run
            // this merge into its cap. It stops now and keeps its guest, so no pin of the guest's is left under a deleted id.
            if (abandoned === true) {
                state.calls -= 1;
                const { superseded }: { superseded: boolean } = await call(references.stopKeepingGuest, { from, generation, to }, to);

                state.stopped = !superseded;
                state.superseded = superseded;

                return true;
            }

            // None of the guest's pins here, but this shard's merge moved its pins away: one may arrive where the route points next.
            if (left) {
                state.routeThread = route.threadId;
                state.deferMs = PINS_LEFT_RECHECK_MS;

                return false;
            }

            // Read after the signal, primary: an owner's merge re-points the route before it drops the signal, so a signal gone
            // with the route still on this shard means its pins never left. A route that names another shard now was re-pointed
            // after this page was read, and the pins may be there: the next step reads the page again and follows it.
            state.calls -= 1;
            const owner: string | null = await call(references.routeOwner, { threadId: route.threadId, userId: to }, to);

            if (owner !== null && owner !== route.ownerId) {
                state.routeThread = route.threadId;

                return false;
            }
        }

        if (!hasMore) {
            state.route += 1;
        }

        state.routeThread = routes.page[state.route]?.threadId ?? null;

        return false;
    },
};

/**
 * Run the merge of guest `from` into user `to` from `resume` (from the start without it), for at most `budget`
 * cross-shard calls. `next` is where it stopped, for the next run (`delayMs` later when a step must wait), or `null` once
 * the merge is done: every table copied, then cleared, the global rows, follows and pins moved, the guest deleted and the
 * import markers dropped. `superseded` with `null` when this delivery stopped because another one finished the merge (the
 * fence) or holds a newer lease or generation: nothing more of it is this one's to do. `budget` counts every call, the
 * run's {@link MERGE_LEASE_CALLS} lease calls included. `busyUntil` instead when another delivery holds the lease:
 * nothing ran, and this delivery is to be tried again after it. Throws past `maxRuns`, so a merge that cannot finish
 * fails with the guest and its remaining rows kept. A merge that ends without its `global` step (`stopped`, or past
 * `maxRuns`) marks its guest's pins-left signal abandoned first ({@link abandonPinsLeft}), so another merge waiting on
 * it stops too instead of waiting until its own cap. Every stop ends the merge's markers and keeps the guest; on a store
 * other users share (`sharedShard`) the merge stops before its first step, since none of the guest's rows would move.
 */
export const mergeGuestInto = async (
    call: ShardCall,
    references: MergeReferences,
    from: string,
    to: string,
    { budget = MERGE_CALLS_PER_RUN, maxRuns = MAX_MERGE_RUNS, resume: payload }: { budget?: number; maxRuns?: number; resume?: MergeProgress } = {},
): Promise<{ busyUntil?: number; delayMs?: number; moved: number; next: MergeProgress | null; stopped?: boolean; superseded?: boolean }> => {
    const tooManyRuns = (): Error => new Error(`the merge of guest ${from} into ${to} did not finish in ${String(maxRuns)} runs; the guest and its rows stay`);
    const abandonPins = async (): Promise<void> => {
        await call(references.abandonPinsLeft, { from }, from);
    };

    if ((payload?.run ?? 0) >= maxRuns) {
        await abandonPins();

        throw tooManyRuns();
    }

    // One delivery at a time: the lease's generation goes with every write, and a later one's makes this one's stale.
    const lease: { busyUntil?: number; finished?: boolean; generation: number; saved?: MergeProgress; stopped?: boolean } = await call(
        references.acquireLease,
        { from, to },
        to,
    );

    if (lease.finished === true) {
        // Another delivery finished the merge and its end: no lease was taken, so there is none to give back.
        return { moved: payload?.moved ?? 0, next: null, superseded: true };
    }

    if (lease.stopped === true) {
        // The new account is gone, or the merge stopped at its run cap: no lease was taken, so there is none to give back.
        await abandonPins();

        return { moved: payload?.moved ?? 0, next: null, stopped: true };
    }

    if (lease.busyUntil !== undefined) {
        return { busyUntil: lease.busyUntil, moved: payload?.moved ?? 0, next: null };
    }

    const { generation, saved } = lease;
    // A delivery queued before a later run's (a redelivery, or a job the sweep sent while one was only slow) goes on from
    // the record that run saved, never from its own older payload: the merge's position only moves forward.
    const resume = saved !== undefined && saved.run > (payload?.run ?? 0) ? saved : payload;
    const run = resume?.run ?? 0;

    if (run >= maxRuns) {
        // Stopped for good: its markers end (the guest's pin writes are refused no longer), its record and lease go, and the
        // guest and its rows stay. A later delivery holding the lease already has the merge, and its markers, in hand.
        try {
            await call(references.stopKeepingGuest, { dropLease: true, from, generation, to }, to);
        } finally {
            // Gone with the stop; given back should the stop fail.
            await call(references.releaseLease, { from, generation }, to);
        }

        await abandonPins();

        throw tooManyRuns();
    }

    const tables = shardLocalTables();
    // A table no longer in the schema (a deploy between runs): its phase starts over, which is safe for both.
    const index = resume === undefined ? 0 : Math.max(0, tables.indexOf(resume.table));
    const state: MergeState = {
        calls: budget - MERGE_LEASE_CALLS - MERGE_STOP_CALLS,
        cursor: resume !== undefined && tables[index] === resume.table ? resume.cursor : null,
        deferMs: null,
        index,
        moved: resume?.moved ?? 0,
        phase: resume?.phase ?? "contributors",
        route: resume?.route ?? 0,
        routeThread: resume?.phase === "repins" ? (resume.routeThread ?? null) : null,
        stopped: false,
        superseded: false,
    };
    const context: MergeContext = { call, from, generation, references, tables, to };
    let done = false;
    /** Ends the run before its first step: a newer delivery, an erasure, or a pin write still in flight. */
    let early: { busyUntil?: number; stopped?: boolean; superseded?: boolean } | null = null;
    const progress = (): MergeProgress => {
        return {
            cursor: state.cursor,
            moved: state.moved,
            phase: state.phase,
            ...(state.route > 0 && { route: state.route }),
            ...(state.phase === "repins" && state.routeThread !== null && { routeThread: state.routeThread }),
            run: run + 1,
            table: tables[state.index] ?? "",
        };
    };

    // Everything after the lease is taken runs inside the `try`, so the lease is given back on every path. A run that threw
    // (its first calls included) gives it back too: its redelivery takes the next generation at once and counts against the
    // queue's retries and `maxRuns`, instead of finding the lease busy and queueing itself again without end.
    try {
        const { current, guestGone, sharedShard }: { current: boolean; guestGone?: boolean; sharedShard?: boolean } = await call(
            references.noteGeneration,
            // Only the merge's own progress says its `guest` step is done, never a missing `user` row (see `noteMergeGeneration`).
            { from, generation, ...(state.phase === "markers" && { pastGuest: true }) },
            from,
        );

        if (sharedShard === true) {
            // Nothing of the guest's would move: the merge ends here, its markers with it, and the guest is kept.
            const { superseded }: { superseded: boolean } = await call(references.stopKeepingGuest, { from, generation, to }, to);

            early = superseded ? { superseded: true } : { stopped: true };
        } else if (current || guestGone === true) {
            const begun: { cleanup?: boolean; finished: boolean; pinWritesUntil: number | null; stopped: boolean; superseded?: boolean } = await call(
                references.beginRun,
                { from, generation, to },
                to,
            );

            if (begun.superseded === true) {
                // A later delivery holds the lease: this one leaves the merge, and its markers, to it.
                early = { superseded: true };
            } else if (begun.finished && begun.cleanup === true) {
                // Fenced with its markers phase not over: only that phase is left, whatever the resumed progress says.
                enter(state, "markers");
            } else if (begun.finished) {
                early = { superseded: true };
            } else if (begun.stopped) {
                early = { stopped: true };
            } else if (guestGone === true) {
                // This merge's own `guest` step already deleted the guest (or the id is a real account's): nothing is left to
                // move, and its shard refuses every delete, so only the merge's end is left to run.
                enter(state, "markers");
            } else if (begun.pinWritesUntil !== null) {
                // A pin write of the guest's may still be in flight: the run is tried again from where it was once it has run
                // out, one extra second for clock skew between the writer and this job. The markers stay meanwhile.
                early = { busyUntil: begun.pinWritesUntil + 1000 };
            }
        } else {
            early = { superseded: true };
        }

        while (early === null && !done && state.deferMs === null && state.calls >= STEP_CALLS[state.phase]) {
            done = await STEPS[state.phase](context, state);
        }
    } finally {
        // Given back before the next run is queued, so it need not wait for the lease to lapse; should the release fail, the
        // lease lapses. With it goes where the run stopped (a thrown run included: each step is safe to run again), for the
        // stalled-merge sweep; a run that ended early keeps the progress saved before it.
        const keep = !done && early === null;

        await call(references.releaseLease, { from, generation, ...(keep && { progress: progress() }) }, to);
    }

    // A step that stopped the merge (an erasure begun during the run) may have done so before the `global` step.
    if (early?.stopped === true || (done && state.stopped)) {
        await abandonPins();
    }

    if (early !== null) {
        return { moved: resume?.moved ?? 0, next: null, ...early };
    }

    if (done) {
        return { moved: state.moved, next: null, ...(state.stopped && { stopped: true }), ...(state.superseded && { superseded: true }) };
    }

    return { moved: state.moved, next: progress(), ...(state.deferMs !== null && { delayMs: state.deferMs }) };
};

/**
 * Clear one page of `table` on the guest's shard: the page is imported again before it is deleted, so a row written or
 * edited there since the table was copied arrives as it is now; only ids the new shard confirms are deleted. A row the
 * guest deleted after the read is gone before the delete: its copy is taken back from the new shard, unless the account
 * changed it since. `empty` when the table holds none of the guest's rows any more (one call), `page` after a page (three
 * calls, four with a row gone or changed since the read), `fenced` when another delivery already finished the merge,
 * `erasing` when its import found an erasure begun and stopped the merge ({@link stoppedForErasure}).
 * `calls`: how many it made.
 */
const clearPage = async (
    call: ShardCall,
    references: MergeReferences,
    table: string,
    { from, generation, to }: { from: string; generation: number; to: string },
): Promise<{ calls: number; outcome: "empty" | "erasing" | "fenced" | "page" }> => {
    const { digests, rows }: { digests: string[]; rows: Record<string, unknown>[] } = await call(
        references.listClear,
        KEEP_NEW_USERS.has(table) ? { from, ownedBy: from, table } : { from, table },
        from,
    );

    if (rows.length === 0) {
        return { calls: 1, outcome: "empty" };
    }

    const { erasing, fenced, present }: { erasing?: boolean; fenced: boolean; present: string[] } = await call(
        references.importRows,
        { clearing: true, from, generation, rows, table, to },
        to,
    );

    // An erasure began since the run's start: the merge stopped in that import, and the guest's rows of this page stay on its shard.
    if (erasing === true) {
        return { calls: 2, outcome: "erasing" };
    }

    // Another delivery finished this merge or took it over: nothing of this page is confirmed, so nothing of it is deleted.
    if (fenced) {
        return { calls: 2, outcome: "fenced" };
    }

    const confirmed = new Set(present);
    const deletable = rows
        .map((row, index) => {
            return { digest: digests[index]!, id: row._id as string };
        })
        .filter(({ id }) => confirmed.has(id));

    let calls = 2;

    if (deletable.length > 0) {
        const deleted: { changed: string[]; fenced: boolean; gone: string[] } = await call(
            references.deleteRows,
            { from, generation, rows: deletable, table },
            from,
        );

        calls += 1;

        if (deleted.fenced) {
            return { calls, outcome: "fenced" };
        }

        // Gone from the guest's shard since the read: the import just wrote what the guest no longer has. Changed since: the
        // clear reads it again, and until then the reconcile may take it back.
        if (deleted.gone.length > 0 || deleted.changed.length > 0) {
            const dropped: { fenced: boolean } = await call(
                references.dropGone,
                { changed: deleted.changed, from, generation, ids: deleted.gone, table, to },
                to,
            );

            calls += 1;

            if (dropped.fenced) {
                return { calls, outcome: "fenced" };
            }
        }
    }

    if (deletable.length < rows.length) {
        throw new Error(`the new shard of ${to} did not confirm ${String(rows.length - deletable.length)} ${table} rows of guest ${from}; they stay`);
    }

    return { calls, outcome: "page" };
};

/** The generated references `mergeGuestInto` calls (passed in, so this module does not import `_generated/api`). */
export interface MergeReferences {
    abandonPinsLeft: { __lunoraRef: string };
    acquireLease: { __lunoraRef: string };
    beginRun: { __lunoraRef: string };
    deleteGuest: { __lunoraRef: string };
    deleteRows: { __lunoraRef: string };
    dropGone: { __lunoraRef: string };
    dropMarkers: { __lunoraRef: string };
    handOverContributors: { __lunoraRef: string };
    importRows: { __lunoraRef: string };
    list: { __lunoraRef: string };
    listClear: { __lunoraRef: string };
    listPinRoutes: { __lunoraRef: string };
    listUncleared: { __lunoraRef: string };
    missingOnGuest: { __lunoraRef: string };
    movePinRoute: { __lunoraRef: string };
    nextPinRoute: { __lunoraRef: string };
    noteGeneration: { __lunoraRef: string };
    pinsLeft: { __lunoraRef: string };
    reassignFollows: { __lunoraRef: string };
    reassignGlobal: { __lunoraRef: string };
    reassignPins: { __lunoraRef: string };
    releaseLease: { __lunoraRef: string };
    resolvePinsLeft: { __lunoraRef: string };
    routeOwner: { __lunoraRef: string };
    stopKeepingGuest: { __lunoraRef: string };
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
        resume: v.optional(v.object({ ...vMergeProgressFields })),
        to: v.string(),
    })
    .output(v.object({ done: v.boolean(), moved: v.number() }))
    .action(async ({ args }) => {
        const { busyUntil, delayMs, moved, next, stopped, superseded } = await mergeGuestInto(
            async (reference, callArgs, shardKey) => (await callOnShard(reference as never, callArgs as never, { shardKey })) as never,
            {
                abandonPinsLeft: internal.lib.account_merge.abandonPinsLeft,
                acquireLease: internal.lib.account_merge.acquireMergeLease,
                beginRun: internal.lib.account_merge.beginMergeRun,
                deleteGuest: internal.auth.hooks.deleteMergedGuest,
                deleteRows: internal.lib.account_merge.deleteShardRows,
                dropGone: internal.lib.account_merge.dropRowsGoneFromGuest,
                dropMarkers: internal.lib.account_merge.dropImportMarkersPage,
                handOverContributors: internal.lib.account_merge.handOverOrganizationContributors,
                importRows: internal.lib.account_merge.importShardRows,
                list: internal.lib.account_merge.listShardRowsPage,
                listClear: internal.lib.account_merge.listShardRowsToClear,
                listPinRoutes: internal.chat.pins.functions.listSharedPinRoutesForExport,
                listUncleared: internal.lib.account_merge.listUnclearedImports,
                missingOnGuest: internal.lib.account_merge.listRowsMissingOnGuest,
                movePinRoute: internal.lib.account_merge.moveSharedPinRouteOf,
                nextPinRoute: internal.lib.account_merge.nextSharedPinRoute,
                noteGeneration: internal.lib.account_merge.noteMergeGeneration,
                pinsLeft: internal.lib.account_merge.pinsLeftShard,
                reassignFollows: internal.lib.account_merge.reassignThreadFollowsPage,
                reassignGlobal: internal.lib.account_merge.reassignGlobalRows,
                reassignPins: internal.chat.pins.functions.reassignUserPinsOnThread,
                releaseLease: internal.lib.account_merge.releaseMergeLease,
                resolvePinsLeft: internal.lib.account_merge.resolvePinsLeft,
                routeOwner: internal.lib.account_merge.sharedPinRouteOwner,
                stopKeepingGuest: internal.lib.account_merge.stopMergeKeepingGuest,
            },
            args.from,
            args.to,
            args.resume === undefined ? {} : { resume: args.resume },
        );

        if (busyUntil !== undefined) {
            // Another delivery is running this merge, or a pin write of the guest's is still in flight. Tried again once
            // that has lapsed, never dropped: should the other delivery die, this is what carries the merge on.
            await enqueueJob(internal.lib.account_merge.runGuestMerge, args, { delayMs: Math.max(1000, busyUntil - Date.now()), shardKey: args.to });

            return { done: false, moved };
        }

        if (next !== null) {
            // Queued before this run returns: should the send fail, the run fails and its redelivery repeats it.
            await enqueueJob(
                internal.lib.account_merge.runGuestMerge,
                { from: args.from, resume: next, to: args.to },
                { ...(delayMs !== undefined && { delayMs }), shardKey: args.to },
            );

            return { done: false, moved };
        }

        if (stopped === true) {
            authLogger.info(
                `[auth] stopped the merge of guest ${args.from} into ${args.to}, keeping the guest: an erasure of either account has begun, the new account is gone, or another merge it waited on stopped`,
            );

            return { done: true, moved };
        }

        if (superseded === true) {
            // Not this delivery's end to report: the one that finished the merge, or holds its newer lease, does.
            authLogger.info(`[auth] a delivery of the merge of guest ${args.from} into ${args.to} stopped: another delivery finished it or took it over`);

            return { done: true, moved };
        }

        authLogger.info(`[auth] moved ${String(moved)} rows from guest ${args.from} to ${args.to}`);

        return { done: true, moved };
    });
