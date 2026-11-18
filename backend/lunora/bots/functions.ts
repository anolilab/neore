import { MODEL_LOOKUP } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import type { ThreadPermissionMode } from "../chat/lib/thread-permission-mode";
import { deleteBotConnectorAccess } from "../connectors/access";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow, withoutUndefined } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";
import { SUB_AGENT_MAX_DEPTH } from "../sub-agents/logic";
import { isTaskModelAllowed } from "../tasks/logic";

const vPermissionMode = v.union(v.literal("supervised"), v.literal("auto"), v.literal("full"));

const vBot = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    computerEnabled: v.boolean(),
    createdAt: v.number(),
    description: v.optional(v.string()),
    instructions: v.string(),
    model: v.string(),
    name: v.string(),
    permissionMode: v.optional(vPermissionMode),
    updatedAt: v.number(),
    userId: v.string(),
});

/** A listing returns at most this many, so a bot past it would be unreachable from the UI. */
export const MAX_BOTS_PER_USER = 100;

/** `full` lets the owner's tools run unasked: an admin acting as the owner must not widen what the owner's runs may do. */
const assertModeChangeAllowed = (context: { user: { impersonatedBy?: string | null } }, mode: ThreadPermissionMode | undefined): void => {
    if (mode !== undefined && context.user.impersonatedBy) {
        throw new LunoraError("FORBIDDEN", "The permission mode cannot be changed while impersonating");
    }
};

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
        permissionMode: v.optional(vPermissionMode),
    })
    .output(v.string())
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;

        assertUsableModel(args.model);
        assertModeChangeAllowed(context, args.permissionMode);

        // The web form trims its fields, but an API caller sends them raw: a blank name or instruction is refused here.
        if (args.name.trim() === "" || args.instructions.trim() === "") {
            throw new LunoraError("INVALID_ARGUMENT", "A bot needs a name and instructions.");
        }

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
            ...(args.permissionMode && { permissionMode: args.permissionMode }),
            updatedAt: now,
            userId,
        });

        context.log.event("bots.create_bot", { computerEnabled: args.computerEnabled, permissionMode: args.permissionMode ?? "auto" });

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
            permissionMode: v.optional(vPermissionMode),
        }),
    })
    .output(v.null())
    .mutation(async ({ args: { botId, patch }, ctx: context }) => {
        const { userId } = context.user;
        const bot = await context.db.get("bots", botId as Id<"bots">);

        if (!bot || bot.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        if (patch.model !== undefined) {
            assertUsableModel(patch.model);
        }

        assertModeChangeAllowed(context, patch.permissionMode);

        if ((patch.name !== undefined && patch.name.trim() === "") || (patch.instructions !== undefined && patch.instructions.trim() === "")) {
            throw new LunoraError("INVALID_ARGUMENT", "A bot needs a name and instructions.");
        }

        await patchRow(context.db, "bots", bot, withoutUndefined({ ...patch, updatedAt: context.now }));

        context.log.event("bots.update_bot", { computerEnabled: patch.computerEnabled });

        if (patch.permissionMode !== undefined && patch.permissionMode !== (bot.permissionMode ?? "auto")) {
            // Who changed which bot's default tool permissions, and from what: kept in the request log for a later investigation.
            context.log.event("bots.bot_permission_mode_changed", { botId: bot._id, from: bot.permissionMode ?? "auto", to: patch.permissionMode });
        }

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
        const bot = await context.db.get("bots", botId as Id<"bots">);

        if (!bot || bot.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        // The computer goes with the bot: its sandbox is killed, not paused.
        await context.runMutation(internal.sandbox.functions.retireBotComputers, { botId: bot._id });

        // The teammate's connection settings go with it: a retained thread must not keep applying them.
        await deleteBotConnectorAccess(context, bot._id);

        // Threads, routines and memories that name this bot keep the id. Readers
        // treat a missing bot as the plain assistant, so nothing is rewritten here.
        await context.db.delete("bots", bot._id);

        context.log.event("bots.delete_bot", {});

        return null;
    });

/** Every bot id a user owns, for a run that works through each bot's own memories (`memory/reflection.ts`). */
export const listBotIdsForUser = internalQuery
    .input({ userId: v.string().max(MAX_LENGTH.id) })
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
    .input({ botId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.union(
            v.object({
                computerEnabled: v.boolean(),
                instructions: v.string(),
                model: v.string(),
                name: v.string(),
                permissionMode: v.optional(vPermissionMode),
            }),
            v.null(),
        ),
    )
    .query(async ({ args: { botId, userId }, ctx }) => {
        const bot = await ctx.db.get("bots", botId as Id<"bots">);

        if (!bot || bot.userId !== userId) {
            return null;
        }

        return {
            computerEnabled: bot.computerEnabled,
            instructions: bot.instructions,
            model: bot.model,
            name: bot.name,
            ...(bot.permissionMode && { permissionMode: bot.permissionMode }),
        };
    });

/**
 * The permission mode of the bot an unattended run belongs to: the bot it names, else the bot of the thread it continues (a task's
 * round on a bot's chat), or `null` when neither leads to a bot of the caller's. A sub-agent child's thread names no bot, so the
 * chain is followed up to its lead, at most one step per nesting level. Internal: `chat/lib/headless-run.ts`, `chat/lib/agent-run.ts`.
 */
export const getBotPermissionModeForRun = internalQuery
    .input({ botId: v.optional(v.string().max(MAX_LENGTH.id)), threadId: v.optional(v.string().max(MAX_LENGTH.id)), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(vPermissionMode, v.null()))
    .query(async ({ args: { botId, threadId, userId }, ctx }) => {
        let id = botId;
        let next = id === undefined ? threadId : undefined;

        for (let step = 0; next !== undefined && step <= SUB_AGENT_MAX_DEPTH; step += 1) {
            const normalized = ctx.db.normalizeId("threads", next);
            const thread = normalized ? await ctx.db.get("threads", normalized) : null;

            if (thread?.userId !== userId) {
                break;
            }

            id = thread.botId;

            const childOf: string = next;
            const run =
                id === undefined
                    ? await ctx.db
                          .query("subAgentRuns")
                          .withIndex("by_childThreadId", (q) => q.eq("childThreadId", childOf))
                          .first()
                    : null;

            next = run?.userId === userId ? run.parentThreadId : undefined;
        }

        const bot = id === undefined ? null : await ctx.db.get("bots", id as Id<"bots">);

        return bot?.userId === userId ? (bot.permissionMode ?? null) : null;
    });
