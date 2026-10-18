import { MODEL_LOOKUP } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow, withoutUndefined } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";
import { isTaskModelAllowed } from "../tasks/logic";

const vBot = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    computerEnabled: v.boolean(),
    createdAt: v.number(),
    description: v.optional(v.string()),
    instructions: v.string(),
    model: v.string(),
    name: v.string(),
    updatedAt: v.number(),
    userId: v.string(),
});

/** A listing returns at most this many, so a bot past it would be unreachable from the UI. */
export const MAX_BOTS_PER_USER = 100;

const assertUsableModel = (model: string): void => {
    if (!isTaskModelAllowed(model, (id) => MODEL_LOOKUP.get(id))) {
        throw new LunoraError("INVALID_ARGUMENT", `The model '${model}' is not available for bots.`);
    }
};

export const listBots = authQuery.output(v.array(vBot)).query(async ({ ctx: context }) => {
    const { userId } = context.user;

    return await context.db
        .query("bots")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .order("desc")
        .take(MAX_BOTS_PER_USER);
});

export const createBot = authMutation
    .use(rateLimit("bots/create"))
    .input({
        computerEnabled: v.boolean(),
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        instructions: v.string().max(MAX_LENGTH.document),
        model: v.string().max(MAX_LENGTH.short),
        name: v.string().max(MAX_LENGTH.short),
    })
    .output(v.string())
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;

        assertUsableModel(args.model);

        const owned = await context.db
            .query("bots")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(MAX_BOTS_PER_USER);

        if (owned.length >= MAX_BOTS_PER_USER) {
            throw new LunoraError("INVALID_ARGUMENT", `You can have at most ${MAX_BOTS_PER_USER} bots.`);
        }

        const botId = await context.db.insert("bots", {
            computerEnabled: args.computerEnabled,
            createdAt: now,
            description: args.description,
            instructions: args.instructions,
            model: args.model,
            name: args.name,
            updatedAt: now,
            userId,
        });

        context.log.event("bots.create_bot", { computerEnabled: args.computerEnabled });

        return botId as string;
    });

export const updateBot = authMutation
    .use(rateLimit("bots/update"))
    .input({
        botId: v.id("bots"),
        patch: v.object({
            computerEnabled: v.optional(v.boolean()),
            description: v.optional(v.string().max(MAX_LENGTH.long)),
            instructions: v.optional(v.string().max(MAX_LENGTH.document)),
            model: v.optional(v.string().max(MAX_LENGTH.short)),
            name: v.optional(v.string().max(MAX_LENGTH.short)),
        }),
    })
    .output(v.null())
    .mutation(async ({ args: { botId, patch }, ctx: context }) => {
        const { userId } = context.user;
        const bot = await context.db.get(botId as Id<"bots">);

        if (!bot || bot.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        if (patch.model !== undefined) {
            assertUsableModel(patch.model);
        }

        await patchRow(context.db, bot, withoutUndefined({ ...patch, updatedAt: context.now }));

        context.log.event("bots.update_bot", { computerEnabled: patch.computerEnabled });

        return null;
    });

export const deleteBot = authMutation
    .use(rateLimit("bots/delete"))
    .input({
        botId: v.id("bots"),
    })
    .output(v.null())
    .mutation(async ({ args: { botId }, ctx: context }) => {
        const { userId } = context.user;
        const bot = await context.db.get(botId as Id<"bots">);

        if (!bot || bot.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        // The computer goes with the bot: its sandbox is killed, not paused.
        await context.runMutation(internal.sandbox.functions.retireBotComputers, { botId: bot._id });

        // Threads, routines and memories that name this bot keep the id. Readers
        // treat a missing bot as the plain assistant, so nothing is rewritten here.
        await context.db.delete(bot._id);

        context.log.event("bots.delete_bot", {});

        return null;
    });

/** Every bot id a user owns, for a run that works through each bot's own memories (`memory/reflection.ts`). */
export const listBotIdsForUser = internalQuery
    .input({ userId: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args: { userId }, ctx }) => {
        const bots = await ctx.db
            .query("bots")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(MAX_BOTS_PER_USER);

        return bots.map((bot) => bot._id as string);
    });

/**
 * A bot as a run reads it, or null when the bot is gone or not the caller's.
 * Internal: `chat/functions.ts#createThread` (refuses a bot it cannot read) and
 * `chat/lib/agent-run.ts` (a missing bot reads as a plain chat).
 */
export const getBotForRun = internalQuery
    .input({ botId: v.string(), userId: v.string() })
    .output(v.union(v.object({ computerEnabled: v.boolean(), instructions: v.string(), model: v.string(), name: v.string() }), v.null()))
    .query(async ({ args: { botId, userId }, ctx }) => {
        const bot = await ctx.db.get(botId as Id<"bots">);

        if (!bot || bot.userId !== userId) {
            return null;
        }

        return { computerEnabled: bot.computerEnabled, instructions: bot.instructions, model: bot.model, name: bot.name };
    });
