/**
 * The browser module's erasure and export. Erasure is for account deletion (called by `gdpr/steps/deletion-steps.ts`) and for a
 * deleted thread's ask rows (called by `agent/threads.ts`), plain functions over the caller's `ctx`. The export is read a page per
 * workflow step by `gdpr/workflows/export-workflow.ts` (`export-pages.ts#collectAllBrowserPages`).
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { MAX_LENGTH } from "../lib/validators";

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

/** Rows one export page reads, sessions walked included, and the JSON it returns: a step's stored result stays far under 1 MiB. */
const EXPORT_SCAN_BUDGET = 1000;
const EXPORT_PAGE_BYTES = 400_000;

const ENCODER = new TextEncoder();
const jsonBytes = (value: unknown): number => ENCODER.encode(JSON.stringify(value)).length;

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
});

const vExportHumanCheck = v.object({
    askedAt: v.number(),
    reported: v.optional(v.boolean()),
    site: v.string(),
    threadId: v.string(),
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
const exportedAction = (row: Doc<"browserActions">, sessionId: string): Infer<typeof vExportAction> => {
    return {
        action: row.action,
        sessionId,
        success: row.success === 1,
        timestamp: row.timestamp,
        ...(row.actor !== undefined && { actor: row.actor }),
        ...(row.durationMs !== undefined && { durationMs: row.durationMs }),
        ...(row.errorMessage !== undefined && { errorMessage: row.errorMessage }),
        ...(row.target !== undefined && { target: row.target }),
    };
};

/** Walks the user's sessions from `cursor`, reading each one's actions a page at a time until the page's budget is spent. */
const collectActionsPage = async (ctx: Pick<QueryCtx, "db">, userId: string, cursor: BrowserExportCursor): Promise<BrowserExportPage> => {
    const actions: Infer<typeof vExportAction>[] = [];
    let sessionCursor = cursor.page;
    let actionCursor = cursor.inner;
    let scanned = 0;
    let bytes = 0;

    for (;;) {
        const sessions = await ctx.db.browserSessions.findMany({ cursor: sessionCursor, limit: 1, where: { userId } });
        const [session] = sessions.page;

        if (!session) {
            return { ...EMPTY_PAGE, actions, next: { phase: "humanChecks" } };
        }

        scanned += 1;

        for (;;) {
            const page = await ctx.db.browserActions.findMany({
                cursor: actionCursor,
                limit: BATCH,
                orderBy: [{ timestamp: "asc" }],
                where: { sessionId: session._id },
            });

            for (const row of page.page) {
                const exported = exportedAction(row, session._id as string);

                bytes += jsonBytes(exported);
                actions.push(exported);
            }

            scanned += page.page.length;
            actionCursor = page.isDone ? undefined : (page.continueCursor ?? undefined);

            if (actionCursor === undefined) {
                break;
            }

            // Cut between action pages only, so the cursor names exactly where the next page starts.
            if (scanned >= EXPORT_SCAN_BUDGET || bytes >= EXPORT_PAGE_BYTES) {
                return { ...EMPTY_PAGE, actions, next: { inner: actionCursor, phase: "actions", ...(sessionCursor !== undefined && { page: sessionCursor }) } };
            }
        }

        if (sessions.isDone || !sessions.continueCursor) {
            return { ...EMPTY_PAGE, actions, next: { phase: "humanChecks" } };
        }

        sessionCursor = sessions.continueCursor;

        if (scanned >= EXPORT_SCAN_BUDGET || bytes >= EXPORT_PAGE_BYTES) {
            return { ...EMPTY_PAGE, actions, next: { page: sessionCursor, phase: "actions" } };
        }
    }
};

/**
 * One page of the user's browser export: their sessions, then each session's actions, then the sites a run asked them to clear,
 * then their extensions. `next` is absent on the last page; the workflow asks again with it until it is.
 */
export const collectBrowserForExport = internalQuery
    .input({ cursor: v.optional(vBrowserExportCursor), userId: v.string().max(MAX_LENGTH.id) })
    .output(vBrowserExportPage)
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const phase = cursor?.phase ?? "sessions";

        if (phase === "actions") {
            return await collectActionsPage(ctx, userId, cursor ?? { phase });
        }

        const at = cursor?.page;

        if (phase === "sessions") {
            const page = await ctx.db.browserSessions.findMany({ cursor: at, limit: BATCH, where: { userId } });

            return {
                ...EMPTY_PAGE,
                next: page.isDone || !page.continueCursor ? { phase: "actions" } : { page: page.continueCursor, phase: "sessions" },
                sessions: page.page.map((row) => {
                    return {
                        id: row._id as string,
                        lastActivityAt: row.lastActivityAt,
                        startedAt: row.startedAt,
                        status: row.status,
                        threadId: row.threadId as string,
                        ...(row.completedAt !== undefined && { completedAt: row.completedAt }),
                        ...(row.currentUrl !== undefined && { currentUrl: row.currentUrl }),
                        ...(row.errorMessage !== undefined && { errorMessage: row.errorMessage }),
                        ...(row.source !== undefined && { source: row.source }),
                    };
                }),
            };
        }

        if (phase === "humanChecks") {
            const page = await ctx.db.browserHumanChecks.findMany({ cursor: at, limit: BATCH, where: { userId } });

            return {
                ...EMPTY_PAGE,
                humanChecks: page.page.map((row) => {
                    return {
                        askedAt: row.askedAt,
                        site: row.site,
                        threadId: row.threadId as string,
                        ...(row.reported !== undefined && { reported: row.reported }),
                    };
                }),
                next: page.isDone || !page.continueCursor ? { phase: "extensions" } : { page: page.continueCursor, phase: "humanChecks" },
            };
        }

        const page = await ctx.db.browserExtensions.findMany({ cursor: at, limit: BATCH, where: { userId } });

        return {
            ...EMPTY_PAGE,
            extensions: page.page.map((row) => {
                return {
                    extensionId: row.extensionId,
                    status: row.status,
                    ...(row.browserInfo !== undefined && { browserInfo: row.browserInfo }),
                    ...(row.capabilities !== undefined && { capabilities: row.capabilities }),
                    ...(row.extensionVersion !== undefined && { extensionVersion: row.extensionVersion }),
                    ...(row.lastSeenAt !== undefined && { lastSeenAt: row.lastSeenAt }),
                    ...(row.pairedAt !== undefined && { pairedAt: row.pairedAt }),
                };
            }),
            ...(!page.isDone && page.continueCursor && { next: { page: page.continueCursor, phase: "extensions" as const } }),
        };
    });
