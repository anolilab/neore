/**
 * The user's own memories, read for the Markdown download in Memory settings (`./export-format.ts` writes it). Only
 * active rows: superseded history is in the account data export (`./gdpr.ts`). It works with memory off, so the user
 * can still see what is stored.
 *
 * Pinned rows are read first, by one bounded scan; the others are paged newest first by a cursor, a page per
 * `runQuery`, up to {@link MEMORY_EXPORT_MAX_ROWS}. So a cut drops the oldest unpinned rows, never a pinned or a
 * recent one, and the file says it is cut.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { authAction, rateLimit } from "../lib/crpc";
import { botOwnerRows } from "./bot-owner";
import { type BotLabel, type ExportMemoryRow, formatMemoryMarkdown, MEMORY_EXPORT_MAX_ROWS } from "./export-format";
import { vImportApp } from "./import-logic";
import { lastConfirmedOf, vMemoryType } from "./taxonomy";

/** Rows one `readMemoryExportPage` call returns. */
export const MEMORY_EXPORT_PAGE_ROWS = 500;
/** Active rows the pinned scan reads at most (there is no pinned index): the account export's own memory cap. */
export const MEMORY_EXPORT_PINNED_SCAN_ROWS = 5000;

const vExportRow = v.object({
    botId: v.optional(v.string()),
    eventEnd: v.optional(v.string()),
    eventStart: v.optional(v.string()),
    importedFrom: v.optional(vImportApp),
    lastConfirmedAt: v.number(),
    memory: v.string(),
    pinned: v.boolean(),
    source: v.optional(v.string()),
    type: vMemoryType,
    validUntil: v.optional(v.string()),
});

const toExportRow = (m: Doc<"memories">): ExportMemoryRow => {
    return {
        ...(m.botId !== undefined && { botId: m.botId as string }),
        ...(m.eventEnd !== undefined && { eventEnd: m.eventEnd }),
        ...(m.eventStart !== undefined && { eventStart: m.eventStart }),
        ...(m.importedFrom !== undefined && { importedFrom: m.importedFrom }),
        lastConfirmedAt: lastConfirmedOf(m),
        memory: m.memory,
        pinned: m.pinned === true,
        ...(m.source !== undefined && { source: m.source }),
        type: m.type,
        ...(m.validUntil !== undefined && { validUntil: m.validUntil }),
    };
};

/** One page of the user's active memories, newest first; only its unpinned rows are returned (`readPinnedMemories` has the rest). */
export const readMemoryExportPage = internalQuery
    .input({ cursor: v.union(v.string(), v.null()), userId: v.string() })
    .output(v.object({ cursor: v.union(v.string(), v.null()), isDone: v.boolean(), rows: v.array(vExportRow) }))
    .query(async ({ args, ctx }) => {
        const page = await ctx.db
            .query("memories")
            .withIndex("by_userId_supersededBy", (q) => q.eq("userId", args.userId).eq("supersededBy", null))
            .order("desc")
            .paginate({ cursor: args.cursor, numItems: MEMORY_EXPORT_PAGE_ROWS });

        return { cursor: page.continueCursor, isDone: page.isDone, rows: page.page.filter((m) => m.pinned !== true).map((m) => toExportRow(m)) };
    });

/** The user's pinned active memories among the newest {@link MEMORY_EXPORT_PINNED_SCAN_ROWS}, and whether that was all of them. */
export const readPinnedMemories = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ complete: v.boolean(), rows: v.array(vExportRow) }))
    .query(async ({ args, ctx }) => {
        const scanned = await ctx.db
            .query("memories")
            .withIndex("by_userId_supersededBy", (q) => q.eq("userId", args.userId).eq("supersededBy", null))
            .order("desc")
            .take(MEMORY_EXPORT_PINNED_SCAN_ROWS);

        return { complete: scanned.length < MEMORY_EXPORT_PINNED_SCAN_ROWS, rows: scanned.filter((m) => m.pinned === true).map((m) => toExportRow(m)) };
    });

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
        const bots = await Promise.all(args.botIds.map(async (id) => await ctx.db.get("bots", id as Id<"bots">)));
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

/** Bot ids one label lookup takes, so a user with many bots never builds one oversized read. */
const BOT_LABEL_BATCH = 100;

/**
 * The user's pinned memories, then their newest unpinned ones up to {@link MEMORY_EXPORT_MAX_ROWS}, with whether any
 * active row was left out.
 */
export const readExportMemories = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<{ rows: ExportMemoryRow[]; truncated: boolean }> => {
    const pinned = await ctx.runQuery(internal.memory.markdown_export.readPinnedMemories, { userId });
    const unpinned: ExportMemoryRow[] = [];
    let cursor: string | null = null;

    // At the cap itself one more page is read, so exactly the cap is not reported as cut.
    while (unpinned.length <= MEMORY_EXPORT_MAX_ROWS) {
        const page: { cursor: string | null; isDone: boolean; rows: ExportMemoryRow[] } = await ctx.runQuery(
            internal.memory.markdown_export.readMemoryExportPage,
            { cursor, userId },
        );

        unpinned.push(...page.rows);

        if (page.isDone) {
            break;
        }

        cursor = page.cursor;
    }

    return {
        rows: [...pinned.rows, ...unpinned.slice(0, MEMORY_EXPORT_MAX_ROWS)],
        truncated: !pinned.complete || unpinned.length > MEMORY_EXPORT_MAX_ROWS,
    };
};

const readBotLabels = async (ctx: Pick<ActionCtx, "runQuery">, userId: string, rows: ReadonlyArray<ExportMemoryRow>): Promise<Map<string, BotLabel>> => {
    const botIds = [...new Set(rows.map((row) => row.botId).filter((id): id is string => id !== undefined))];
    const labels = new Map<string, BotLabel>();

    for (let start = 0; start < botIds.length; start += BOT_LABEL_BATCH) {
        const batch = await ctx.runQuery(internal.memory.markdown_export.resolveMemoryBotLabels, {
            botIds: botIds.slice(start, start + BOT_LABEL_BATCH),
            userId,
        });

        for (const { botId, kind, name } of batch) {
            labels.set(botId, kind === "named" ? { kind, name: name ?? "" } : { kind });
        }
    }

    return labels;
};

/**
 * The caller's active memories as a Markdown file: pinned first, then by type, each with its dates (calendar days in
 * the user's timezone, UTC when unset), source and bot scope. No evidence quotes. Works while memory is off.
 */
export const exportMemoriesMarkdown = authAction
    .use(rateLimit("memory/export"))
    .output(v.object({ count: v.number(), markdown: v.string(), truncated: v.boolean() }))
    .action(async ({ ctx }) => {
        const { userId } = ctx.user;
        const [{ rows, truncated }, timeZone] = await Promise.all([
            readExportMemories(ctx, userId),
            ctx.runQuery(internal.memory.functions.getUserTimeZone, { userId }),
        ]);
        const bots = await readBotLabels(ctx, userId, rows);

        ctx.log.event("memory.export_markdown", { count: rows.length, truncated, userId });

        return { count: rows.length, markdown: formatMemoryMarkdown(rows, { bots, now: Date.now(), timeZone, truncated }), truncated };
    });
