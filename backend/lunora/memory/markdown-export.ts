/**
 * The user's own memories, read for the Markdown download in Memory settings (`./export-format.ts` writes it). Only
 * active rows: superseded history is in the account data export (`./gdpr.ts`). It works with memory off, so the user
 * can still see what is stored.
 *
 * One read of the newest {@link MEMORY_EXPORT_SCAN_ROWS} active rows (there is no pinned index), split in memory: every
 * pinned row among them, and the {@link MEMORY_EXPORT_MAX_ROWS} newest others. "Newest" is when a row was saved, not when
 * it was last confirmed: a deliberate bound, so a cut drops the oldest saved rows and the file says it is cut.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { authAction, rateLimit } from "../lib/crpc";
import { botOwnerRows } from "./bot-owner";
import { type BotLabel, exportDayOf, type ExportMemoryRow, formatMemoryMarkdown, MEMORY_EXPORT_MAX_ROWS, MEMORY_EXPORT_SCAN_ROWS } from "./export-format";
import { vImportApp } from "./import-logic";
import { lastConfirmedOf, vMemoryType } from "./taxonomy";

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

/**
 * The user's pinned memories and newest unpinned ones among their newest {@link MEMORY_EXPORT_SCAN_ROWS} active rows,
 * and whether any active row was left out. One row past the scan is read, so exactly the scan is not reported as cut.
 */
export const readMemoryExportRows = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ rows: v.array(vExportRow), truncated: v.boolean() }))
    .query(async ({ args, ctx }) => {
        const scanned = await ctx.db
            .query("memories")
            .withIndex("by_userId_supersededBy", (q) => q.eq("userId", args.userId).eq("supersededBy", null))
            .order("desc")
            .take(MEMORY_EXPORT_SCAN_ROWS + 1);
        const read = scanned.slice(0, MEMORY_EXPORT_SCAN_ROWS);
        const unpinned = read.filter((m) => m.pinned !== true);

        return {
            rows: [...read.filter((m) => m.pinned === true), ...unpinned.slice(0, MEMORY_EXPORT_MAX_ROWS)].map((m) => toExportRow(m)),
            truncated: scanned.length > MEMORY_EXPORT_SCAN_ROWS || unpinned.length > MEMORY_EXPORT_MAX_ROWS,
        };
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

/** The rows an export holds, pinned first (`readMemoryExportRows`). */
export const readExportMemories = async (ctx: Pick<ActionCtx, "runQuery">, userId: string): Promise<{ rows: ExportMemoryRow[]; truncated: boolean }> =>
    await ctx.runQuery(internal.memory.markdown_export.readMemoryExportRows, { userId });

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
    // `day`: the local day the file is dated, so its name matches its header.
    .output(v.object({ count: v.number(), day: v.string(), markdown: v.string(), truncated: v.boolean() }))
    .action(async ({ ctx }) => {
        const { userId } = ctx.user;
        const [{ rows, truncated }, timeZone] = await Promise.all([
            readExportMemories(ctx, userId),
            ctx.runQuery(internal.memory.functions.getUserTimeZone, { userId }),
        ]);
        const bots = await readBotLabels(ctx, userId, rows);
        const now = Date.now();

        ctx.log.event("memory.export_markdown", { count: rows.length, truncated, userId });

        return {
            count: rows.length,
            day: exportDayOf(now, timeZone),
            markdown: formatMemoryMarkdown(rows, { bots, now, timeZone, truncated }),
            truncated,
        };
    });
