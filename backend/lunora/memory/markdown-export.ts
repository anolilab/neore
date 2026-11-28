/**
 * The user's own memories, read for the Markdown download in Memory settings and the messenger `/memory` digest
 * (`./export-format.ts` writes both). Only active rows: superseded history is in the account data export
 * (`./gdpr.ts`). It works with memory off, so the user can still see what is stored.
 *
 * The newest {@link MEMORY_EXPORT_SCAN_ROWS} active rows (there is no pinned index), read a page per call and split in
 * memory: every pinned row among them, and the {@link MEMORY_EXPORT_MAX_ROWS} newest others. "Newest" is when a row was saved, not when
 * it was last confirmed: a deliberate bound, so a cut drops the oldest saved rows and the file says it is cut.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { authAction, rateLimit } from "../lib/crpc";
import { isThreadLocked } from "../lib/thread-lock";
import { botOwnerRows } from "./bot-owner";
import {
    type BotLabel,
    exportDayOf,
    type ExportMemoryRow,
    formatMemoryMarkdown,
    MEMORY_DIGEST_SOURCE_CHECKS,
    MEMORY_EXPORT_MAX_ROWS,
    MEMORY_EXPORT_SCAN_ROWS,
} from "./export-format";
import { vImportApp } from "./import-logic";
import { lastConfirmedOf, vMemoryType } from "./taxonomy";

const vExportRow = v.object({
    botId: v.optional(v.string()),
    eventEnd: v.optional(v.string()),
    eventStart: v.optional(v.string()),
    importance: v.optional(v.number()),
    importedFrom: v.optional(vImportApp),
    lastConfirmedAt: v.number(),
    memory: v.string(),
    pinned: v.boolean(),
    source: v.optional(v.string()),
    sourceThreadId: v.optional(v.string()),
    type: vMemoryType,
    validUntil: v.optional(v.string()),
});

const toExportRow = (m: Doc<"memories">): ExportMemoryRow => {
    return {
        ...(m.botId !== undefined && { botId: m.botId as string }),
        ...(m.eventEnd !== undefined && { eventEnd: m.eventEnd }),
        ...(m.eventStart !== undefined && { eventStart: m.eventStart }),
        ...(m.importance !== undefined && { importance: m.importance }),
        ...(m.importedFrom !== undefined && { importedFrom: m.importedFrom }),
        lastConfirmedAt: lastConfirmedOf(m),
        memory: m.memory,
        pinned: m.pinned === true,
        ...(m.source !== undefined && { source: m.source }),
        // The chat `getMemorySource` links to: the evidence's, else the row's own.
        ...((m.evidence?.threadId ?? m.threadId) !== undefined && { sourceThreadId: (m.evidence?.threadId ?? m.threadId) as string }),
        type: m.type,
        ...(m.validUntil !== undefined && { validUntil: m.validUntil }),
    };
};

/** Rows one `readMemoryExportPage` call reads at most: six of them cover the scan and the row past it. */
export const MEMORY_EXPORT_PAGE_ROWS = 1000;

/** One page of the user's active memories, newest first. */
export const readMemoryExportPage = internalQuery
    .input({
        cursor: v.union(v.string(), v.null()),
        numItems: v.number().check((n) => Number.isSafeInteger(n) && n > 0 && n <= MEMORY_EXPORT_PAGE_ROWS, { message: "numItems out of range" }),
        userId: v.string(),
    })
    .output(v.object({ cursor: v.union(v.string(), v.null()), isDone: v.boolean(), rows: v.array(vExportRow) }))
    .query(async ({ args, ctx }) => {
        const page = await ctx.db
            .query("memories")
            .withIndex("by_userId_supersededBy", (q) => q.eq("userId", args.userId).eq("supersededBy", null))
            .order("desc")
            .paginate({ cursor: args.cursor, numItems: args.numItems });

        return { cursor: page.continueCursor, isDone: page.isDone, rows: page.page.map((m) => toExportRow(m)) };
    });

/**
 * Which of these source chats the messenger digest must not quote from: locked, in the trash, or not a chat of the
 * user's on this shard (deleted, or another person's shared chat). Bounded by the digest's own check count.
 */
export const readHiddenSourceThreads = internalQuery
    .input({ threadIds: v.array(v.string()).check((ids) => ids.length <= MEMORY_DIGEST_SOURCE_CHECKS, { message: "too many threads" }), userId: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => {
        const threads = await Promise.all(args.threadIds.map(async (id) => await ctx.db.get("threads", id as Id<"threads">)));

        return args.threadIds.filter((_, index) => {
            const thread = threads[index];

            return thread === null || thread === undefined || thread.userId !== args.userId || thread.deleted === true || isThreadLocked(thread);
        });
    });

/** Bots read at once by `resolveMemoryBotLabels`, so a user with many bots never builds one oversized read. */
const BOT_LABEL_BATCH = 100;

/**
 * What each bot of the user's memories is called: the user's own bot by name; otherwise its `botOwners` row says
 * whether another user owns it (a shared chat's bot) or it was deleted, and no row leaves it unknown.
 */
export const resolveMemoryBotLabels = internalQuery
    .input({ botIds: v.array(v.string()), userId: v.string() })
    .output(
        v.array(
            v.object({
                botId: v.string(),
                kind: v.union(v.literal("deleted"), v.literal("named"), v.literal("shared"), v.literal("unknown")),
                name: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const bots: (Doc<"bots"> | null)[] = [];

        // Every bot of the export in this one call, read a batch at a time (`botOwnerRows` batches its own reads).
        for (let start = 0; start < args.botIds.length; start += BOT_LABEL_BATCH) {
            bots.push(...(await Promise.all(args.botIds.slice(start, start + BOT_LABEL_BATCH).map(async (id) => await ctx.db.get("bots", id as Id<"bots">)))));
        }

        const names = new Map(bots.filter((bot): bot is Doc<"bots"> => bot !== null && bot.userId === args.userId).map((bot) => [bot._id as string, bot.name]));
        const owners = await botOwnerRows(
            ctx,
            args.botIds.filter((id) => !names.has(id)),
        );

        return args.botIds.map((botId) => {
            const name = names.get(botId);

            if (name !== undefined) {
                return { botId, kind: "named" as const, name };
            }

            const owner = owners.get(botId);

            if (owner === undefined) {
                return { botId, kind: "unknown" as const };
            }

            return { botId, kind: owner.ownerId !== args.userId && !owner.deleted ? ("shared" as const) : ("deleted" as const) };
        });
    });

/**
 * The user's pinned memories and newest unpinned ones among their newest {@link MEMORY_EXPORT_SCAN_ROWS} active rows,
 * and whether any active row was left out. Read a page of at most {@link MEMORY_EXPORT_PAGE_ROWS} per call, so no
 * single read grows with the account; one row past the scan is read, so exactly the scan is not reported as cut.
 */
export const readExportMemories = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<{ rows: ExportMemoryRow[]; truncated: boolean }> => {
    const pinned: ExportMemoryRow[] = [];
    const unpinned: ExportMemoryRow[] = [];
    let cursor: string | null = null;
    let read = 0;

    while (read <= MEMORY_EXPORT_SCAN_ROWS) {
        const page: { cursor: string | null; isDone: boolean; rows: ExportMemoryRow[] } = await ctx.runQuery(
            internal.memory.markdown_export.readMemoryExportPage,
            { cursor, numItems: Math.min(MEMORY_EXPORT_PAGE_ROWS, MEMORY_EXPORT_SCAN_ROWS + 1 - read), userId },
        );

        for (const row of page.rows) {
            read += 1;

            if (read <= MEMORY_EXPORT_SCAN_ROWS) {
                (row.pinned ? pinned : unpinned).push(row);
            }
        }

        if (page.isDone || page.rows.length === 0) {
            break;
        }

        cursor = page.cursor;
    }

    return {
        rows: [...pinned, ...unpinned.slice(0, MEMORY_EXPORT_MAX_ROWS)],
        truncated: read > MEMORY_EXPORT_SCAN_ROWS || unpinned.length > MEMORY_EXPORT_MAX_ROWS,
    };
};

/** The error Lunora throws when one transaction reads past its limit (`maxReadBytes`, 32 MiB). */
const isTransactionLimit = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "TRANSACTION_LIMIT_EXCEEDED";

/**
 * Every distinct bot of the rows, labelled in ONE call: the action's calls stay fixed however many bots there are. A
 * bot row can hold up to 2 MB of instructions, so a user with many large bots can pass the read limit: then every bot
 * is labelled "a bot" (`labelsCut`), and the file is still made.
 */
export const readBotLabels = async (
    ctx: Pick<ActionCtx, "runQuery">,
    userId: string,
    rows: ReadonlyArray<ExportMemoryRow>,
): Promise<{ labels: Map<string, BotLabel>; labelsCut: boolean }> => {
    const botIds = [...new Set(rows.map((row) => row.botId).filter((id): id is string => id !== undefined))];

    if (botIds.length === 0) {
        return { labels: new Map(), labelsCut: false };
    }

    let labelsCut = false;
    const labels = await ctx.runQuery(internal.memory.markdown_export.resolveMemoryBotLabels, { botIds, userId }).catch((error: unknown) => {
        if (!isTransactionLimit(error)) {
            throw error;
        }

        labelsCut = true;

        return botIds.map((botId) => {
            return { botId, kind: "unknown" as const, name: undefined };
        });
    });

    return {
        labels: new Map(labels.map(({ botId, kind, name }): [string, BotLabel] => [botId, kind === "named" ? { kind, name: name ?? "" } : { kind }])),
        labelsCut,
    };
};

/**
 * The caller's active memories as a Markdown file: pinned first, then by type, each with its dates (calendar days in
 * the user's timezone, UTC when unset), source and bot scope. No evidence quotes. Works while memory is off.
 */
export const exportMemoriesMarkdown = authAction
    .use(rateLimit("memory/export"))
    // `day`: the local day the file is dated, so its name matches its header.
    .output(v.object({ count: v.number(), day: v.string(), markdown: v.string(), truncated: v.boolean() }))
    .action(async ({ ctx }) => {
        const { userId } = ctx.user;
        const [{ rows, truncated }, timeZone] = await Promise.all([
            readExportMemories(ctx, userId),
            ctx.runQuery(internal.memory.functions.getUserTimeZone, { userId }),
        ]);
        const { labels: bots, labelsCut } = await readBotLabels(ctx, userId, rows);
        const now = Date.now();

        ctx.log.event("memory.export_markdown", { count: rows.length, labelsCut, truncated, userId });

        return {
            count: rows.length,
            day: exportDayOf(now, timeZone),
            markdown: formatMemoryMarkdown(rows, { bots, now, timeZone, truncated }),
            truncated,
        };
    });
