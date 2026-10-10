/**
 * Persistence for chats run against a `local-browser` endpoint.
 *
 * The browser streams the reply straight from the user's own Ollama / LM
 * Studio (`apps/web/src/features/local-models`) — the backend cannot reach
 * localhost and the SSRF guard keeps it that way — then hands the finished
 * turn here: the prompt and the reply text, nothing else. No tools ran, no
 * title model is called (the prompt stays off hosted models), no memory
 * extraction is scheduled, and no credits move.
 *
 * Regenerate and edit follow the in-thread branching rules
 * (`agent/branch-tree.ts`) exactly as the gateway path does: a regenerate is a
 * reply with `promptMessageId` = the prompt and `failPendingSteps`, after
 * pointing the thread at it (so it lands as a SIBLING of the earlier reply); an edit saves the new prompt
 * through `saveEditedSiblingHandler`, then the reply under it.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx as MutationContext } from "../_generated/server";
import { getThreadRow } from "../agent/branch-rows";
import { saveEditedSiblingHandler } from "../agent/branches";
import { addMessagesHandler } from "../agent/messages";
import { insertThread, patchThread } from "../agent/table-writes";
import { authMutation, rateLimit } from "../lib/crpc";
import type { StoredCustomProvider } from "./lib/custom-providers";
import {
    buildLocalPromptMessage,
    buildLocalReplyMessage,
    deriveLocalThreadTitle,
    type LocalTurnOutcome,
    MAX_LOCAL_ERROR_CHARS,
    MAX_LOCAL_PROMPT_CHARS,
    MAX_LOCAL_REPLY_CHARS,
    resolveLocalModel,
} from "./lib/local-turn";
import { admitOwnedThread } from "../agent/thread-read-access";

/** Regenerate the reply to `messageId` (a prompt), or save an edit of it. Requires `threadId`. */
export interface LocalTurnBranch {
    kind: "edit" | "regenerate";
    messageId: Id<"messages">;
}

export interface SaveLocalTurnArgs {
    branch?: LocalTurnBranch;
    error?: string;
    language?: string;
    model: string;
    outcome: LocalTurnOutcome;
    prompt: string;
    reasoning?: string;
    reply: string;
    threadId?: Id<"threads">;
}

export interface SaveLocalTurnResult {
    assistantMessageId: string;
    threadId: string;
    userMessageId: string;
}

/** The caller's custom endpoints — `customAIProviders` is `v.any()` at rest. */
const loadProviders = async (ctx: MutationContext, userId: string): Promise<Record<string, StoredCustomProvider>> => {
    const prefs = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
    const raw = prefs?.customAIProviders;

    return raw && typeof raw === "object" ? (raw as Record<string, StoredCustomProvider>) : {};
};

/** Exported for the harness test; the procedure below adds auth and the rate limit. */
export const saveLocalTurnHandler = async (ctx: MutationContext, userId: string, args: SaveLocalTurnArgs): Promise<SaveLocalTurnResult> => {
    if (!args.prompt.trim()) {
        throw new LunoraError("BAD_REQUEST", "The prompt is empty");
    }

    const resolved = resolveLocalModel(args.model, await loadProviders(ctx, userId));

    if ("error" in resolved) {
        throw new LunoraError("BAD_REQUEST", resolved.error);
    }

    if (args.branch && !args.threadId) {
        throw new LunoraError("BAD_REQUEST", "Regenerate and edit need a thread");
    }

    const now = Date.now();
    let threadId: Id<"threads">;

    if (args.threadId) {
        const thread = await ctx.db.get(args.threadId);

        if (!thread || thread.deleted) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        if (thread.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot write to another user's thread");
        }

        admitOwnedThread(ctx, thread, userId);

        threadId = args.threadId;
        await patchThread(ctx.db, threadId, { model: args.model, updatedAt: now });
    } else {
        threadId = (await insertThread(ctx.db, {
            createdBy: userId,
            ...(args.language && { language: args.language }),
            mode: "text",
            model: args.model,
            status: "active",
            tags: ["chat", "local"],
            title: deriveLocalThreadTitle(args.prompt),
            updatedAt: now,
            userId,
        })) as Id<"threads">;
    }

    const userMessage = buildLocalPromptMessage(args.prompt);
    const replyMessage = buildLocalReplyMessage({
        error: args.error,
        modelId: resolved.modelId,
        outcome: args.outcome,
        prompt: args.prompt,
        reasoning: args.reasoning,
        reply: args.reply,
    });

    if (args.branch) {
        const target = await getThreadRow(ctx, threadId, args.branch.messageId);

        if ((target?.message as { role?: string } | undefined)?.role !== "user") {
            throw new LunoraError("BAD_REQUEST", "Regenerate and edit take a prompt of this thread");
        }

        let promptId = args.branch.messageId;

        if (args.branch.kind === "edit") {
            promptId = await saveEditedSiblingHandler(ctx, { message: userMessage.message, originalMessageId: promptId, userId });
        } else {
            // As the gateway's regenerate: the new reply is then the prompt's latest
            // child, and `addMessagesHandler` advances the leaf onto it.
            await patchThread(ctx.db, threadId, { activeLeafMessageId: promptId });
        }

        // `failPendingSteps` marks a fresh reply to an existing prompt — what makes
        // it a sibling of the earlier reply rather than its child (`resolveBranchParent`).
        const { messages } = await addMessagesHandler(ctx, { failPendingSteps: true, messages: [replyMessage], promptMessageId: promptId, threadId, userId });
        const [replyRow] = messages;

        if (!replyRow) {
            throw new LunoraError("INTERNAL", "Failed to save the local reply");
        }

        return { assistantMessageId: replyRow._id, threadId, userMessageId: promptId };
    }

    const { messages } = await addMessagesHandler(ctx, { messages: [userMessage, replyMessage], threadId, userId });
    const [userRow, assistantRow] = messages;

    if (!userRow || !assistantRow) {
        throw new LunoraError("INTERNAL", "Failed to save the local turn");
    }

    return { assistantMessageId: assistantRow._id, threadId, userMessageId: userRow._id };
};

export const saveLocalTurn = authMutation
    // Same family as a hosted message: this writes two rows per call.
    .use(rateLimit("chat/message"))
    .input({
        /** Regenerate the reply to a prompt, or save an edit of it, as a sibling branch. */
        branch: v.optional(v.object({ kind: v.union(v.literal("regenerate"), v.literal("edit")), messageId: v.id("messages") })),
        error: v.optional(v.string().check((value) => value.length <= MAX_LOCAL_ERROR_CHARS * 4, { message: "Error too long" })),
        language: v.optional(v.string().check((value) => value.length <= 20, { message: "Invalid language" })),
        /** `custom:<providerId>/<modelId>` naming the caller's own `local-browser` endpoint. */
        model: v.string().check((value) => value.length <= 300, { message: "Invalid model id" }),
        outcome: v.union(v.literal("complete"), v.literal("aborted"), v.literal("failed")),
        prompt: v.string().check((value) => value.length <= MAX_LOCAL_PROMPT_CHARS, { message: "Prompt too long" }),
        reasoning: v.optional(v.string().check((value) => value.length <= MAX_LOCAL_REPLY_CHARS, { message: "Reasoning too long" })),
        reply: v.string().check((value) => value.length <= MAX_LOCAL_REPLY_CHARS, { message: "Reply too long" }),
        /** Omit to start a new thread. */
        threadId: v.optional(v.id("threads")),
    })
    .output(v.object({ assistantMessageId: v.string(), threadId: v.string(), userMessageId: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const result = await saveLocalTurnHandler(ctx, ctx.user.userId, args);

        ctx.log.event("chat.save_local_turn", { branched: args.branch !== undefined, newThread: args.threadId === undefined, outcome: args.outcome });

        return result;
    });
