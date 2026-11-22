/**
 * The browser module's erasure and export. Erasure is for account deletion (called by `gdpr/steps/deletion-steps.ts`) and for a
 * deleted thread's ask rows (called by `agent/threads.ts`), plain functions over the caller's `ctx`. The export is read a page per
 * workflow step by `gdpr/workflows/export-workflow.ts` and stored as an object (`storeBrowserExportPage`), which the export file's
 * action reads back (`export-pages.ts`).
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/internal";
import { internalAction, internalQuery } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { withDependency } from "../lib/dependency";
import { MAX_LENGTH } from "../lib/validators";
import { browserExportUserPrefix } from "./export-pages";

/**
 * Deletes one batch of the sites a deleted thread's runs asked the person to clear; `true` when none are left. The
 * thread delete (`agent/threads.ts`) runs it page by page until then.
 */
export const deleteHumanChecksOfThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<boolean> => {
    const rows = await ctx.db
        .query("browserHumanChecks")
        .withIndex("by_threadId_site_run", (q) => q.eq("threadId", threadId))
        .take(BATCH + 1);
    const batch = rows.slice(0, BATCH);

    await Promise.all(batch.map((row) => ctx.db.delete("browserHumanChecks", row._id)));

    return rows.length <= BATCH;
};

/**
 * Browser sessions with their actions, the sites a run asked the user to clear, and the user's browser extensions.
 * The ask rows grow with use, so they go first, one {@link BATCH} per call (`hasMore` while any may remain); the
 * sessions and extensions go in the call that finds none left.
 */
export const eraseBrowserDataForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const humanChecks = await ctx.db
        .query("browserHumanChecks")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    if (humanChecks.length > 0) {
        await Promise.all(humanChecks.map((check) => ctx.db.delete("browserHumanChecks", check._id)));

        if (full(humanChecks)) {
            return { hasMore: true };
        }
    }

    // Delete browser sessions and their actions
    const sessions = await ctx.db
        .query("browserSessions")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();

    const allActions = await Promise.all(
        sessions.map((session) =>
            ctx.db
                .query("browserActions")
                .withIndex("by_sessionId_timestamp", (q) => q.eq("sessionId", session._id))
                .collect(),
        ),
    );

    // Delete browser extensions
    const extensions = await ctx.db
        .query("browserExtensions")
        .withIndex("by_userId_status", (q) => q.eq("userId", userId))
        .collect();

    await Promise.all([
        ...allActions.flat().map((a) => ctx.db.delete("browserActions", a._id)),
        ...sessions.map((s) => ctx.db.delete("browserSessions", s._id)),
        ...extensions.map((entry) => ctx.db.delete("browserExtensions", entry._id)),
    ]);

    return { hasMore: false };
};

/**
 * What one export page may cost. `PAGE_BYTES`: the JSON the page holds; it ends once that is spent, so it holds at most one read
 * ({@link BATCH} rows at {@link EXPORT_ROW_BYTES}) more, {@link PAGE_MAX_BYTES}. `READ_BYTES`: what its reads may cost, half of Lunora's
 * 32 MiB per transaction (`DEFAULT_TRANSACTION_LIMITS.maxReadBytes`), charged the whole row, a typed `value` included. `QUERIES`: the
 * reads it makes, so a walk over many empty sessions ends its page too.
 */
const PAGE_BYTES = 512 * 1024;
const READ_BYTES = 16 * 1024 * 1024;
const QUERIES = 100;

/**
 * What a read reckons each row it has not seen costs: the largest the page has read, never under `ROW_FLOOR_BYTES`, so small rows
 * are read a {@link BATCH} at a time and the other 16 MiB of the transaction covers rows a little larger than any seen. A page whose
 * read passes the transaction's limit all the same is read again `cautious`, at `STORED_ROW_BYTES` a row (the shard's SQLite caps a
 * row at 2 MB), which no read can pass.
 */
const ROW_FLOOR_BYTES = 64 * 1024;
const STORED_ROW_BYTES = 2 * 1024 * 1024;

/** The JSON of one exported string, or of a list of them; longer ones are cut and named in the row's `truncated`. */
export const EXPORT_FIELD_BYTES = 4096;

/** The most one exported row's JSON can be: every field at {@link EXPORT_FIELD_BYTES}, its names and `truncated` besides. */
export const EXPORT_ROW_BYTES = 48 * 1024;

/** The most a stored page can be: {@link PAGE_BYTES}, and the read that passed it. */
const PAGE_MAX_BYTES = PAGE_BYTES + BATCH * EXPORT_ROW_BYTES;

const ENCODER = new TextEncoder();
const jsonBytes = (value: unknown): number => ENCODER.encode(JSON.stringify(value)).length;

const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF]$/u;

/** `text` cut so its JSON fits `maxBytes`, never inside a surrogate pair. */
const cutText = (text: string, maxBytes = EXPORT_FIELD_BYTES): string => {
    let cut = text.slice(0, maxBytes);

    while (jsonBytes(cut) > maxBytes) {
        cut = cut.slice(0, Math.floor(cut.length * 0.75));
    }

    return LONE_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
};

/** The most items a list keeps: each needs its quotes and a comma, an empty string at the least. */
const LIST_ITEMS = Math.floor((EXPORT_FIELD_BYTES - 1) / 3);

/**
 * `items` whose JSON fits {@link EXPORT_FIELD_BYTES}, each item kept: the short ones whole, the long ones cut to an equal share of
 * what the short ones leave. `cut` lists the indices cut, and `"<n>-"` when the items from `n` on are left out (past {@link LIST_ITEMS}).
 */
const cutList = (items: string[]): { cut: string[]; kept: string[] } => {
    const listed = items.slice(0, LIST_ITEMS);
    // The JSON strings' bytes, without the brackets and commas.
    let left = EXPORT_FIELD_BYTES - 2 - Math.max(0, listed.length - 1);
    let share = left;
    let unsized = listed.length;

    const sizes = listed.map((item) => jsonBytes(item)).toSorted((a, b) => a - b);

    for (const size of sizes) {
        share = Math.floor(left / unsized);

        if (size > share) {
            break;
        }

        left -= size;
        unsized -= 1;
    }

    const cut: string[] = [];
    const kept = listed.map((item, index) => {
        if (jsonBytes(item) <= share) {
            return item;
        }

        cut.push(String(index));

        return cutText(item, share);
    });

    return { cut: listed.length < items.length ? [...cut, `${String(listed.length)}-`] : cut, kept };
};

/**
 * `row` with each string, and each list of strings, cut to {@link EXPORT_FIELD_BYTES}; `truncated` names the fields cut, a list's
 * with the items it cut (`capabilities[0,3]`), so the export says where it holds less than was stored.
 */
const capped = <R extends Record<string, unknown>>(row: R): R & { truncated?: string[] } => {
    const out: Record<string, unknown> = { ...row };
    const truncated: string[] = [];

    for (const [key, value] of Object.entries(row)) {
        if (typeof value === "string" && jsonBytes(value) > EXPORT_FIELD_BYTES) {
            out[key] = cutText(value);
            truncated.push(key);
        } else if (Array.isArray(value) && jsonBytes(value) > EXPORT_FIELD_BYTES) {
            const { cut, kept } = cutList(value as string[]);

            out[key] = kept;
            truncated.push(`${key}[${cut.join(",")}]`);
        }
    }

    return (truncated.length > 0 ? { ...out, truncated } : out) as R & { truncated?: string[] };
};

/** What the page has spent so far. */
interface Spent {
    bytes: number;
    queries: number;
    readBytes: number;
    /** What a row not yet read is reckoned to cost ({@link ROW_FLOOR_BYTES}). */
    rowBytes: number;
}

const spentNothing = (cautious: boolean): Spent => {
    return { bytes: 0, queries: 0, readBytes: 0, rowBytes: cautious ? STORED_ROW_BYTES : ROW_FLOOR_BYTES };
};

/**
 * The most rows the next read may take: none once the page has spent its queries or its output, and never so many that, each
 * at what a row is reckoned to cost, they would pass the page's read budget.
 */
const nextLimit = (spent: Spent): number => {
    if (spent.queries >= QUERIES || spent.bytes >= PAGE_BYTES) {
        return 0;
    }

    return Math.max(0, Math.min(BATCH, Math.floor((READ_BYTES - spent.readBytes) / spent.rowBytes)));
};

const charge = (spent: Spent, rows: ReadonlyArray<unknown>): void => {
    spent.queries += 1;

    for (const row of rows) {
        const bytes = jsonBytes(row);

        spent.readBytes += bytes;
        spent.rowBytes = Math.max(spent.rowBytes, bytes);
    }
};

/**
 * Where the next page starts: `phase` names the table, `page` the cursor in it (for `actions`, in the user's sessions, at the
 * session being read) and `inner` the cursor in that session's actions.
 */
const vBrowserExportCursor = v.object({
    inner: v.optional(v.string().max(MAX_LENGTH.cursor)),
    page: v.optional(v.string().max(MAX_LENGTH.cursor)),
    phase: v.union(v.literal("sessions"), v.literal("actions"), v.literal("humanChecks"), v.literal("extensions")),
});

export type BrowserExportCursor = Infer<typeof vBrowserExportCursor>;

/** The fields of a row cut to fit ({@link capped}); absent when none was. */
const vTruncated = v.optional(v.array(v.string()));

/**
 * What the export keeps of a session: when it ran, how it ended and the last page it showed. Left out: the renderer's connect
 * URL and session id (credentials for a browser), the in-flight holds and the live-view `control` claim (bookkeeping, and an
 * opaque holder of the person who drove).
 */
const vExportSession = v.object({
    completedAt: v.optional(v.number()),
    currentUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    id: v.string(),
    lastActivityAt: v.number(),
    source: v.optional(v.string()),
    startedAt: v.number(),
    status: v.string(),
    threadId: v.string(),
    truncated: vTruncated,
});

/** An action without its `value`: typed text can be a password the agent filled in. */
const vExportAction = v.object({
    action: v.string(),
    actor: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    sessionId: v.string(),
    success: v.boolean(),
    target: v.optional(v.string()),
    timestamp: v.number(),
    truncated: vTruncated,
});

const vExportHumanCheck = v.object({
    askedAt: v.number(),
    reported: v.optional(v.boolean()),
    site: v.string(),
    threadId: v.string(),
    truncated: vTruncated,
});

/** An extension without its pairing code, a credential for pairing it. */
const vExportExtension = v.object({
    browserInfo: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
    extensionId: v.string(),
    extensionVersion: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
    pairedAt: v.optional(v.number()),
    status: v.string(),
    truncated: vTruncated,
});

const vBrowserExportPage = v.object({
    actions: v.array(vExportAction),
    extensions: v.array(vExportExtension),
    humanChecks: v.array(vExportHumanCheck),
    next: v.optional(vBrowserExportCursor),
    sessions: v.array(vExportSession),
});

type BrowserExportPage = Infer<typeof vBrowserExportPage>;

const EMPTY_PAGE = { actions: [], extensions: [], humanChecks: [], sessions: [] };

/** An action as the export keeps it (`vExportAction`). */
const exportedAction = (row: Doc<"browserActions">, sessionId: string): Infer<typeof vExportAction> =>
    capped({
        action: row.action,
        sessionId,
        success: row.success === 1,
        timestamp: row.timestamp,
        ...(row.actor !== undefined && { actor: row.actor }),
        ...(row.durationMs !== undefined && { durationMs: row.durationMs }),
        ...(row.errorMessage !== undefined && { errorMessage: row.errorMessage }),
        ...(row.target !== undefined && { target: row.target }),
    });

const exportedSession = (row: Doc<"browserSessions">): Infer<typeof vExportSession> =>
    capped({
        id: row._id as string,
        lastActivityAt: row.lastActivityAt,
        startedAt: row.startedAt,
        status: row.status,
        threadId: row.threadId as string,
        ...(row.completedAt !== undefined && { completedAt: row.completedAt }),
        ...(row.currentUrl !== undefined && { currentUrl: row.currentUrl }),
        ...(row.errorMessage !== undefined && { errorMessage: row.errorMessage }),
        ...(row.source !== undefined && { source: row.source }),
    });

const exportedHumanCheck = (row: Doc<"browserHumanChecks">): Infer<typeof vExportHumanCheck> =>
    capped({
        askedAt: row.askedAt,
        site: row.site,
        threadId: row.threadId as string,
        ...(row.reported !== undefined && { reported: row.reported }),
    });

const exportedExtension = (row: Doc<"browserExtensions">): Infer<typeof vExportExtension> =>
    capped({
        extensionId: row.extensionId,
        status: row.status,
        ...(row.browserInfo !== undefined && { browserInfo: row.browserInfo }),
        ...(row.capabilities !== undefined && { capabilities: row.capabilities }),
        ...(row.extensionVersion !== undefined && { extensionVersion: row.extensionVersion }),
        ...(row.lastSeenAt !== undefined && { lastSeenAt: row.lastSeenAt }),
        ...(row.pairedAt !== undefined && { pairedAt: row.pairedAt }),
    });

type Read<R> = { continueCursor?: string | null; isDone: boolean; page: R[] };

/**
 * Reads one table from `cursor` in reads sized by {@link nextLimit} until it ends or the page's budget is spent; `next` is
 * where the rest starts, absent when the table is done.
 */
const collectRows = async <R, E>(
    read: (cursor: string | undefined, limit: number) => Promise<Read<R>>,
    exported: (row: R) => E,
    cursor: string | undefined,
    cautious: boolean,
): Promise<{ next?: string; rows: E[] }> => {
    const spent = spentNothing(cautious);
    const rows: E[] = [];
    let at = cursor;

    for (let limit = nextLimit(spent); limit > 0; limit = nextLimit(spent)) {
        const page = await read(at, limit);

        charge(spent, page.page);

        for (const row of page.page) {
            const value = exported(row);

            spent.bytes += jsonBytes(value);
            rows.push(value);
        }

        if (page.isDone || !page.continueCursor) {
            return { rows };
        }

        at = page.continueCursor;
    }

    return { next: at, rows };
};

/**
 * Walks the user's sessions from `cursor`, reading each one's actions in reads sized by {@link nextLimit}, until the page's
 * budget is spent. It stops only before a read, so the cursor names exactly where the next page starts.
 */
const collectActionsPage = async (ctx: Pick<QueryCtx, "db">, userId: string, cursor: BrowserExportCursor, cautious: boolean): Promise<BrowserExportPage> => {
    const spent = spentNothing(cautious);
    const actions: Infer<typeof vExportAction>[] = [];
    let sessionCursor = cursor.page;
    let actionCursor = cursor.inner;
    const stop = (): BrowserExportPage => {
        return {
            ...EMPTY_PAGE,
            actions,
            next: { phase: "actions", ...(actionCursor !== undefined && { inner: actionCursor }), ...(sessionCursor !== undefined && { page: sessionCursor }) },
        };
    };

    for (;;) {
        if (nextLimit(spent) === 0) {
            return stop();
        }

        const sessions = await ctx.db.browserSessions.findMany({ cursor: sessionCursor, limit: 1, where: { userId } });
        const [session] = sessions.page;

        charge(spent, sessions.page);

        if (!session) {
            return { ...EMPTY_PAGE, actions, next: { phase: "humanChecks" } };
        }

        for (;;) {
            const limit = nextLimit(spent);

            if (limit === 0) {
                return stop();
            }

            const page = await ctx.db.browserActions.findMany({
                cursor: actionCursor,
                limit,
                orderBy: [{ timestamp: "asc" }],
                where: { sessionId: session._id },
            });

            charge(spent, page.page);

            for (const row of page.page) {
                const exported = exportedAction(row, session._id as string);

                spent.bytes += jsonBytes(exported);
                actions.push(exported);
            }

            actionCursor = page.isDone ? undefined : (page.continueCursor ?? undefined);

            if (actionCursor === undefined) {
                break;
            }
        }

        if (sessions.isDone || !sessions.continueCursor) {
            return { ...EMPTY_PAGE, actions, next: { phase: "humanChecks" } };
        }

        sessionCursor = sessions.continueCursor;
    }
};

/**
 * One page of the user's browser export: their sessions, then each session's actions, then the sites a run asked them to clear,
 * then their extensions. `next` is absent on the last page; the workflow asks again with it until it is. Every page stays within
 * its budgets (`PAGE_BYTES`, `READ_BYTES`, `QUERIES`) and every page makes progress, so the export always finishes.
 */
export const collectBrowserForExport = internalQuery
    // `cautious`: each row reckoned at the largest a row can be, for a page whose read passed the transaction's limit.
    .input({ cautious: v.optional(v.boolean()), cursor: v.optional(vBrowserExportCursor), userId: v.string().max(MAX_LENGTH.id) })
    .output(vBrowserExportPage)
    .query(async ({ args: { cautious = false, cursor, userId }, ctx }) => {
        const phase = cursor?.phase ?? "sessions";

        if (phase === "actions") {
            return await collectActionsPage(ctx, userId, cursor ?? { phase }, cautious);
        }

        const at = cursor?.page;

        if (phase === "sessions") {
            const { next, rows } = await collectRows(
                async (from, limit) => await ctx.db.browserSessions.findMany({ cursor: from, limit, where: { userId } }),
                exportedSession,
                at,
                cautious,
            );

            return { ...EMPTY_PAGE, next: next === undefined ? { phase: "actions" } : { page: next, phase: "sessions" }, sessions: rows };
        }

        if (phase === "humanChecks") {
            const { next, rows } = await collectRows(
                async (from, limit) => await ctx.db.browserHumanChecks.findMany({ cursor: from, limit, where: { userId } }),
                exportedHumanCheck,
                at,
                cautious,
            );

            return { ...EMPTY_PAGE, humanChecks: rows, next: next === undefined ? { phase: "extensions" } : { page: next, phase: "humanChecks" } };
        }

        const { next, rows } = await collectRows(
            async (from, limit) => await ctx.db.browserExtensions.findMany({ cursor: from, limit, where: { userId } }),
            exportedExtension,
            at,
            cautious,
        );

        return { ...EMPTY_PAGE, extensions: rows, ...(next !== undefined && { next: { page: next, phase: "extensions" as const } }) };
    });

/** One page of the export, read in this action's own request and stored at `key`; only its `next` cursor goes back to the workflow. */
export const storeBrowserExportPage = internalAction
    .input({ cursor: v.optional(vBrowserExportCursor), key: v.string(), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ next: v.optional(vBrowserExportCursor) }))
    .action(async ({ args: { cursor, key, userId }, ctx }) => {
        const read = async (cautious: boolean): Promise<BrowserExportPage> =>
            (await ctx.runQuery(internal.browser.gdpr.collectBrowserForExport, { cautious, cursor, userId })) as BrowserExportPage;
        // A page whose rows were larger than any read before them can pass the transaction's read limit: read again, cautiously
        // (a read that fails for another reason fails again, and the step's retry takes over).
        const { next, ...rows } = await read(false).catch(async () => await read(true));
        const blob = new Blob([JSON.stringify(rows)], { type: "application/json" });

        await withDependency("file storage", () =>
            ctx.storage.store(key, blob, { allowedContentTypes: ["application/json"], contentType: "application/json", maxSize: PAGE_MAX_BYTES }),
        );

        return next === undefined ? {} : { next };
    });

/** Deletes every object under `prefix`, a listing at a time; none left is not an error. */
export const deleteObjectsUnder = async (
    storage: {
        delete: (key: string) => Promise<unknown>;
        list: (prefix: string, options: { limit: number }) => Promise<{ objects: { key: string }[]; truncated?: boolean }>;
    },
    prefix: string,
): Promise<void> => {
    for (;;) {
        const listing = await storage.list(prefix, { limit: 100 });

        await Promise.all(listing.objects.map(async (object) => await storage.delete(object.key)));

        if (!listing.truncated) {
            return;
        }
    }
};

/** Deletes every page object under a run's `prefix`; any terminal path of the export, and the sweep of a dead run, call it. */
export const deleteBrowserExportPages = internalAction
    .input({ prefix: v.string() })
    .output(v.null())
    .action(async ({ args: { prefix }, ctx }) => {
        await deleteObjectsUnder(ctx.storage, prefix);

        return null;
    });

/**
 * Account erasure: every browser page any of the user's export runs stored, under the user's prefix, so a run that was killed before
 * its cleanup leaves nothing past the deletion.
 */
export const deleteUserBrowserExportPages = internalAction
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .action(async ({ args: { userId }, ctx }) => {
        await deleteObjectsUnder(ctx.storage, browserExportUserPrefix(userId));

        return null;
    });
