/**
 * Retired memories: rows that stopped being current (revised, merged, compressed, expired, decayed, contradicted) but
 * were kept as history. Memory settings lists them with the reason and lets the person bring one back. A deleted memory
 * is gone (`deleteMemoryRows`) and never listed here.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { MAX_LENGTH, paginationOptionsValidator } from "../lib/validators";
import { isExpired } from "./dates";
import { reembedRewordedMemory, requireOwnMemory, userTimeZone } from "./functions";
import { logRedaction, redactMemoryText } from "./redact";
import { DECAY_STEP, localDayOf, type ReflectionOp, RETIRE_BELOW_CONFIDENCE } from "./reflection-logic";

export type MemoryRetiredReason = NonNullable<Doc<"memories">["retiredReason"]>;

/** Why reflection retired a row, read from the op's shape (`reflection-logic.ts`). */
export const reflectionRetiredReason = (op: Extract<ReflectionOp, { kind: "supersede" }>): MemoryRetiredReason => {
    if (op.byMemoryId === op.memoryId) {
        return op.expiredOn === undefined ? "decayed" : "expired";
    }

    return op.merge === true ? "merged" : "contradicted";
};

/** Rows one page of the retired list holds by default, and at most. */
const RETIRED_PAGE = 25;
const RETIRED_PAGE_MAX = 50;

/**
 * A brought-back row's confidence floor: one decay step above the retirement line, so the next reflection does not
 * retire a decayed row again the night it came back.
 */
export const BROUGHT_BACK_CONFIDENCE = RETIRE_BELOW_CONFIDENCE + DECAY_STEP;

/**
 * The caller's retired memories, newest retirement first, a page at a time. Each carries why it was retired (absent for
 * a row retired before reasons were kept) and, when another of the caller's rows replaced it, that row's text. No
 * evidence quotes: those stay behind `getMemorySource` and its lock checks.
 */
export const listRetiredMemories = authQuery
    .input({ paginationOpts: v.optional(paginationOptionsValidator) })
    .output(
        v.object({
            // `null` once the last page was read.
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(
                v.object({
                    _id: v.string(),
                    botName: v.optional(v.string()),
                    fromBot: v.boolean(),
                    memory: v.string(),
                    retiredAt: v.number(),
                    retiredReason: v.optional(
                        v.union(
                            v.literal("revised"),
                            v.literal("merged"),
                            v.literal("compressed"),
                            v.literal("expired"),
                            v.literal("decayed"),
                            v.literal("contradicted"),
                        ),
                    ),
                    successor: v.optional(v.string()),
                    type: v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience")),
                }),
            ),
        }),
    )
    .query(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const options = args.paginationOpts ?? { cursor: null, numItems: RETIRED_PAGE };
        const result = await ctx.db
            .query("memories")
            .withIndex("by_userId_retiredAt", (q) => q.eq("userId", userId).gt("retiredAt", 0))
            .order("desc")
            .paginate({ ...options, numItems: Math.min(Math.max(1, options.numItems), RETIRED_PAGE_MAX) });
        const rows = result.page.filter((row) => row.supersededBy !== undefined && row.retiredAt !== undefined);

        // One read per distinct successor and per distinct bot on the page; only the caller's own are named.
        const successorIds = [...new Set(rows.flatMap((row) => (row.supersededBy && row.supersededBy !== row._id ? [row.supersededBy] : [])))];
        const successors = await Promise.all(successorIds.map(async (id) => ctx.db.get("memories", id)));
        const successorText = new Map(successors.flatMap((row) => (row?.userId === userId ? [[row._id as string, row.memory] as const] : [])));
        const botIds = [...new Set(rows.flatMap((row) => (row.botId ? [row.botId] : [])))];
        const bots = await Promise.all(botIds.map(async (id) => ctx.db.get("bots", id)));
        const botNames = new Map(bots.flatMap((bot) => (bot?.userId === userId ? [[bot._id as string, bot.name] as const] : [])));

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            page: rows.map((row) => {
                return {
                    _id: row._id as string,
                    botName: row.botId ? botNames.get(row.botId as string) : undefined,
                    fromBot: row.botId !== undefined,
                    memory: row.memory,
                    retiredAt: row.retiredAt ?? 0,
                    retiredReason: row.retiredReason ?? undefined,
                    successor: row.supersededBy ? successorText.get(row.supersededBy as string) : undefined,
                    type: row.type,
                };
            }),
        };
    });

/**
 * Makes one of the caller's retired memories current again. The row is active from this write on, confirmed now (so
 * decay does not take it straight back), and re-embedded on the owner's shard (its vector went when it was retired).
 * A row past its end date loses that end date: bringing it back is the person's newest statement that it holds.
 * Whatever replaced it stays as it is: both are active, and dedup and reflection handle the pair later.
 * Works with memory off, as edit and delete do: it is the person's own data.
 */
export const bringBackMemory = authMutation
    .use(rateLimit("memory/update"))
    .input({ memoryId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const row = await requireOwnMemory(ctx, args.memoryId, userId);

        if (!row.supersededBy) {
            throw new LunoraError("BAD_REQUEST", "This memory is not retired");
        }

        // The backstop every write runs: a row stored before redaction may hold a secret it must not carry back.
        const text = redactMemoryText(row.memory);

        if (text === null) {
            throw new LunoraError("BAD_REQUEST", "A memory can't hold only a password, key or token");
        }

        const { now } = ctx;
        const expired = isExpired(row, localDayOf(now, await userTimeZone(ctx, userId)));

        await patchRow(ctx.db, "memories", row, {
            lastConfirmedAt: now,
            retiredAt: undefined,
            retiredReason: undefined,
            supersededBy: undefined,
            updatedAt: now,
            ...(text !== row.memory && { memory: text }),
            ...(row.confidence !== undefined && row.confidence < BROUGHT_BACK_CONFIDENCE && { confidence: BROUGHT_BACK_CONFIDENCE }),
            ...(expired && { validUntil: undefined }),
        });
        await reembedRewordedMemory(ctx, row._id, userId);

        logRedaction(ctx.log, "edit", { dropped: 0, redacted: text === row.memory ? 0 : 1 });
        ctx.log.event("memory.bring_back", { expired, reason: row.retiredReason ?? "unknown" });

        return null;
    });
