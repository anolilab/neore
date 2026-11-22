import { MODEL_LOOKUP } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { DEFAULT_THREAD_PERMISSION_MODE, type ThreadPermissionMode } from "../chat/lib/thread-permission-mode";
import { listBuiltInTools } from "../chat/lib/tool-builder";
import { deleteBotConnectorAccess } from "../connectors/access";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow, withoutUndefined } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";
import { INSTRUCTION_READ_TOOL } from "../projects/rule-files";
import { SUB_AGENT_MAX_DEPTH } from "../sub-agents/logic";
import { isTaskModelAllowed } from "../tasks/logic";
import { markBotOwnerDeleted } from "./owner";
import type { BotToolSelection } from "./tool-selectors";
import { readRunToolSelection, savedServerUrlsOf } from "./run-tool-selection";
import { BOT_TOOL_SELECTOR_MAX_COUNT, BOT_TOOL_SELECTOR_MAX_LENGTH, normalizeBotToolSelection } from "./tool-selectors";

const vPermissionMode = v.union(v.literal("supervised"), v.literal("auto"), v.literal("full"));

const vToolSelection = v.object({ allow: v.optional(v.array(v.string())), exclude: v.array(v.string()) });

/** A selection as a client sends it: capped here, normalized by `normalizeBotToolSelection`. */
const vToolSelectionInput = v.object({
    allow: v.optional(v.array(v.string().max(BOT_TOOL_SELECTOR_MAX_LENGTH)).max(BOT_TOOL_SELECTOR_MAX_COUNT)),
    exclude: v.array(v.string().max(BOT_TOOL_SELECTOR_MAX_LENGTH)).max(BOT_TOOL_SELECTOR_MAX_COUNT),
});

const vBot = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    computerEnabled: v.boolean(),
    createdAt: v.number(),
    description: v.optional(v.string()),
    instructions: v.string(),
    instructionsByImpersonator: v.optional(v.literal(true)),
    model: v.string(),
    name: v.string(),
    permissionMode: v.optional(vPermissionMode),
    toolSelection: v.optional(vToolSelection),
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

/** Clearing a selection or an exclusion gives the bot's runs more tools: like `full`, the owner's to give, never an admin acting as them. */
const assertToolSelectionChangeAllowed = (context: { user: { impersonatedBy?: string | null } }, selection: BotToolSelection | null | undefined): void => {
    if (selection !== undefined && context.user.impersonatedBy) {
        throw new LunoraError("FORBIDDEN", "The tool selection cannot be changed while impersonating");
    }
};

/** How big a selection is, for the audit event: counts only, never the selectors, which carry server addresses. */
const selectionCounts = (selection: BotToolSelection | undefined): { allowed: number | "all"; excluded: number } => {
    return { allowed: selection?.allow?.length ?? "all", excluded: selection?.exclude.length ?? 0 };
};

/** Whether two lists name the same selectors, whatever their order or repeats. An absent allow list stays apart from an empty one. */
const sameList = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined): boolean => {
    if (a === undefined || b === undefined) {
        return a === b;
    }

    const left = new Set(a);
    const right = new Set(b);

    return left.size === right.size && [...left].every((selector) => right.has(selector));
};

/** Whether two selections keep the same tools: each list compared as a set; `null` and absent are every tool. */
const sameSelection = (a: BotToolSelection | null | undefined, b: BotToolSelection | null | undefined): boolean => {
    if (!a || !b) {
        return !a && !b;
    }

    return sameList(a.allow, b.allow) && sameList(a.exclude, b.exclude);
};

/**
 * `null` = every tool, stored as no selection; anything else is normalized, or refused when it breaks a cap or names a
 * built-in tool that does not exist (available here or not: a tool missing its key is still a real name).
 */
const storedToolSelection = (selection: BotToolSelection | null): BotToolSelection | undefined => {
    if (selection === null) {
        return undefined;
    }

    // `instruction_read` is not in the tool list (it exists only in a run with a project's `auto` files), but an exclusion may name it.
    const normalized = normalizeBotToolSelection(selection, new Set([...listBuiltInTools().map((tool) => tool.name as string), INSTRUCTION_READ_TOOL]));

    if ("error" in normalized) {
        throw new LunoraError("BAD_REQUEST", normalized.error);
    }

    return normalized.selection ?? undefined;
};

const assertUsableModel = (model: string): void => {
    if (!isTaskModelAllowed(model, (id) => MODEL_LOOKUP.get(id))) {
        throw new LunoraError("INVALID_ARGUMENT", `The model '${model}' is not available for bots.`);
    }
};

/** Whether a patch changes the bot's text the system prompt carries: its name and its instructions (`chat/lib/agent-run.ts`). */
const changesPromptText = (bot: { instructions: string; name: string }, patch: { instructions?: string; name?: string }): boolean =>
    (patch.instructions !== undefined && patch.instructions !== bot.instructions) || (patch.name !== undefined && patch.name !== bot.name);

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
        toolSelection: v.optional(vToolSelectionInput),
    })
    .output(v.string())
    .mutation(async ({ args, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;

        assertUsableModel(args.model);
        assertModeChangeAllowed(context, args.permissionMode);
        assertToolSelectionChangeAllowed(context, args.toolSelection);

        const toolSelection = args.toolSelection && storedToolSelection(args.toolSelection);

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
            ...(context.user.impersonatedBy && { instructionsByImpersonator: true as const }),
            model: args.model,
            name: args.name,
            ...(args.permissionMode && args.permissionMode !== DEFAULT_THREAD_PERMISSION_MODE && { permissionMode: args.permissionMode }),
            ...(toolSelection && { toolSelection }),
            updatedAt: now,
            userId,
        });

        // The owner outlives a deleted bot, so a memory it taught still names whoever made the bot (`botOwners`).
        await context.db.insert("botOwners", { botId, createdAt: now, ownerId: userId });

        context.log.event("bots.create_bot", {
            botId,
            computerEnabled: args.computerEnabled,
            permissionMode: args.permissionMode ?? DEFAULT_THREAD_PERMISSION_MODE,
            toolSelection: toolSelection !== undefined,
        });

        if (toolSelection !== undefined) {
            // Which bot was limited to which tools, and by whom: counts in the request log for a later investigation.
            const to = selectionCounts(toolSelection);

            context.log.event("bots.bot_tool_selection_changed", {
                botId,
                fromAllowed: "all",
                fromExcluded: 0,
                toAllowed: to.allowed,
                toExcluded: to.excluded,
            });
        }

        return botId as string;
    });

export const updateBot = authMutation
    .use(rateLimit("bots/update"))
    .input({
        botId: v.id("bots"),
        // The tool selection the change was made from (`null` = every tool): a save is refused when the stored one differs,
        // so an editor open since before another save cannot overwrite it.
        expectedToolSelection: v.optional(v.union(vToolSelectionInput, v.null())),
        patch: v.object({
            computerEnabled: v.optional(v.boolean()),
            description: v.optional(v.string().max(MAX_LENGTH.long)),
            instructions: v.optional(v.string().max(MAX_LENGTH.document)),
            model: v.optional(v.string().max(MAX_LENGTH.short)),
            name: v.optional(v.string().max(MAX_LENGTH.short)),
            permissionMode: v.optional(vPermissionMode),
            // `null` = back to every tool.
            toolSelection: v.optional(v.union(vToolSelectionInput, v.null())),
        }),
    })
    // The bot's tool selection as stored after the patch (`null` = every tool), so the client can show it before its list refreshes.
    .output(v.object({ toolSelection: v.union(vToolSelection, v.null()) }))
    .mutation(async ({ args: { botId, expectedToolSelection, patch }, ctx: context }) => {
        const { userId } = context.user;
        const bot = await context.db.get("bots", botId as Id<"bots">);

        if (!bot || bot.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        if (expectedToolSelection !== undefined && !sameSelection(bot.toolSelection, expectedToolSelection)) {
            throw new LunoraError("CONFLICT", "The bot's tools were changed elsewhere. Reload them and try again.");
        }

        if (patch.model !== undefined) {
            assertUsableModel(patch.model);
        }

        assertModeChangeAllowed(context, patch.permissionMode);

        if ((patch.name !== undefined && patch.name.trim() === "") || (patch.instructions !== undefined && patch.instructions.trim() === "")) {
            throw new LunoraError("INVALID_ARGUMENT", "A bot needs a name and instructions.");
        }

        const { permissionMode, toolSelection, ...rest } = patch;

        assertToolSelectionChangeAllowed(context, toolSelection);

        const nextSelection = toolSelection === undefined ? bot.toolSelection : storedToolSelection(toolSelection);

        await patchRow(context.db, "bots", bot, {
            ...withoutUndefined({ ...rest, updatedAt: context.now }),
            // The default is stored as no mode, as on create, so the bot keeps following the default.
            ...(permissionMode !== undefined && { permissionMode: permissionMode === DEFAULT_THREAD_PERMISSION_MODE ? undefined : permissionMode }),
            ...(toolSelection !== undefined && { toolSelection: nextSelection }),
            // A name or instructions an admin acting as the owner changed are not the owner's words: the mark stays (`schema.ts`).
            ...(context.user.impersonatedBy && changesPromptText(bot, rest) && { instructionsByImpersonator: true as const }),
        });

        context.log.event("bots.update_bot", { computerEnabled: patch.computerEnabled, toolSelectionChanged: toolSelection !== undefined });

        if (!sameSelection(bot.toolSelection, nextSelection)) {
            // Which bot gained or lost tools: counts before and after, never the selectors (they carry server addresses).
            const from = selectionCounts(bot.toolSelection);
            const to = selectionCounts(nextSelection);

            context.log.event("bots.bot_tool_selection_changed", {
                botId: bot._id,
                fromAllowed: from.allowed,
                fromExcluded: from.excluded,
                toAllowed: to.allowed,
                toExcluded: to.excluded,
            });
        }

        if (permissionMode !== undefined && permissionMode !== (bot.permissionMode ?? DEFAULT_THREAD_PERMISSION_MODE)) {
            // Who changed which bot's default tool permissions, and from what: kept in the request log for a later investigation.
            context.log.event("bots.bot_permission_mode_changed", {
                botId: bot._id,
                from: bot.permissionMode ?? DEFAULT_THREAD_PERMISSION_MODE,
                to: permissionMode,
            });
        }

        return { toolSelection: nextSelection ?? null };
    });

/**
 * The owner's review of a bot an admin wrote while acting as them: "Keep as mine" drops `instructionsByImpersonator`, so
 * the bot's name and instructions count as the owner's own again (`chat/lib/system-context-kinds.ts`). An own edit never
 * clears the mark; only this does, and never from an impersonated session.
 */
export const keepBotInstructions = authMutation
    .use(rateLimit("bots/update"))
    .input({ botId: v.id("bots") })
    .output(v.null())
    .mutation(async ({ args: { botId }, ctx: context }) => {
        if (context.user.impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "A bot cannot be kept as the owner's while impersonating");
        }

        const bot = await context.db.get("bots", botId as Id<"bots">);

        if (!bot || bot.userId !== context.user.userId) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        if (bot.instructionsByImpersonator) {
            await patchRow(context.db, "bots", bot, { instructionsByImpersonator: undefined });
            context.log.event("bots.keep_bot_instructions", { botId: bot._id });
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

        // Its tombstone tells the memory list the bot is gone.
        await markBotOwnerDeleted(context, bot._id, context.now);

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
                instructionsByImpersonator: v.boolean(),
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
            instructionsByImpersonator: bot.instructionsByImpersonator === true,
            model: bot.model,
            name: bot.name,
            ...(bot.permissionMode && { permissionMode: bot.permissionMode }),
        };
    });

/**
 * The bot a run belongs to: the bot it names, else the bot of the thread it continues (a task's round on a bot's
 * chat), or `null` when neither leads to a bot of the caller's. A sub-agent child's thread names no bot, so the chain is followed
 * up to its lead, at most one step per nesting level.
 */
const findRunBot = async (ctx: QueryCtx, { botId, threadId, userId }: { botId?: string; threadId?: string; userId: string }) => {
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

    return bot?.userId === userId ? bot : null;
};

/** The permission mode of the bot a run belongs to ({@link findRunBot}). Internal: `chat/lib/headless-run.ts`, `chat/lib/agent-run.ts`. */
export const getBotPermissionModeForRun = internalQuery
    .input({ botId: v.optional(v.string().max(MAX_LENGTH.id)), threadId: v.optional(v.string().max(MAX_LENGTH.id)), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(vPermissionMode, v.null()))
    .query(async ({ args, ctx }) => {
        const bot = await findRunBot(ctx, args);

        return bot?.permissionMode ?? null;
    });

/** `readRunToolSelection` (`run-tool-selection.ts`) for an action. Internal: `chat/lib/agent-tools.ts`, which applies it to every run's tools. */
export const getBotToolSelectionForRun = internalQuery
    .input({
        botId: v.optional(v.string().max(MAX_LENGTH.id)),
        ownerId: v.optional(v.string().max(MAX_LENGTH.id)),
        threadId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.union(v.object({ ownerId: v.string(), ownerServerKeys: v.array(v.string()), selection: vToolSelection }), v.null()))
    .query(async ({ args, ctx }) => await readRunToolSelection(ctx, args));

/**
 * The addresses of the servers a user saved. Internal: `chat/lib/mcp-apps.ts`, which tells by them whether a key stands for one
 * server alone. Unlike `getMCPServersQuery` a failed read throws, so the app call is refused rather than read as none saved.
 */
export const getSavedMcpServerUrls = internalQuery
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.array(v.string()))
    .query(async ({ args: { userId }, ctx }) => await savedServerUrlsOf(ctx, userId));

/**
 * Whether any of the user's bots has a tool selection. Internal: `chat/lib/mcp-apps.ts`, which refuses an app call that names
 * no chat for such a user, since without the chat it cannot tell which bot's selection holds.
 */
export const hasBotWithToolSelection = internalQuery
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .query(async ({ args: { userId }, ctx }) => {
        const bots = await ctx.db
            .query("bots")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(MAX_BOTS_PER_USER);

        return bots.some((bot) => bot.toolSelection !== undefined);
    });
