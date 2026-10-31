/**
 * A side question ("Ask aside"): the user asks something while a reply is
 * still streaming (or between turns) and gets a short answer in a panel,
 * without touching the thread.
 *
 * - `askAside` is ONE model call on a read-only snapshot of the thread (the
 *   newest rows of its active path, plus the reply so far when one is running),
 *   with no tools. It writes no message, moves no branch, and nothing it reads
 *   or says reaches the running agent: the question and the answer live in the
 *   client's panel only.
 * - It runs on the thread's own model. A thread on a paired computer's coding
 *   agent must never reach a cloud model (`getFollowupSuggestions`), so there
 *   the utility model sees the QUESTION ALONE. A model the caller cannot run
 *   (a lapsed plan, a deleted endpoint) or a non-text thread falls back to the
 *   utility model too; a thread on the user's own `local-browser` endpoint is
 *   refused, because its prompts are kept off hosted models.
 * - Billing follows the other one-off utility call (`chat/translate.ts`): the
 *   daily text quota, charged once the call is certain to be made, and the
 *   gateway meters the call per user and thread. The per-minute budget is the
 *   chat message family. An aside is not a reply row, so it has no
 *   `scheduleReplyUsage` entry.
 * - `addAsideToThread` is the only write: ONE assistant row (question quoted,
 *   then the answer) under the name "Side question", as a new turn on the
 *   active branch. It is refused while a reply is running, because a row
 *   landing after the run's pending row would split the reply across branches.
 */
import { MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";
import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import { resolveLeafRow } from "../agent/branch-rows";
import { listActivePathPage } from "../agent/branches";
import { addMessagesHandler, getMaxMessage, listMessagesByThreadIdHandler } from "../agent/messages";
import { extractText } from "../agent/shared";
import { patchThread } from "../agent/table-writes";
import { authAction, authMutation, rateLimit } from "../lib/crpc";
import { chatLogger } from "../lib/logger";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import { MAX_LENGTH } from "../lib/validators";
import { isWorkerThread } from "../sub-agents/functions";
import { chargeDailyLimit } from "./lib/daily-limit";
import {
    ASIDE_AGENT_NAME,
    ASIDE_CONTEXT_ROWS,
    ASIDE_MAX_OUTPUT_TOKENS,
    ASIDE_SYSTEM_PROMPT,
    type AsideRow,
    buildAsidePrompt,
    fitAsideRows,
    formatAsideMessage,
    MAX_ASIDE_ANSWER_CHARS,
    MAX_ASIDE_QUESTION_CHARS,
} from "./lib/aside";
import { isAgentRunError, loadModelFilterRules, loadUserProviderKeys, resolveRunModel } from "./lib/agent-run";
import getAgent from "./lib/get-agent";
import { throwUnlessGranted, threadGateOutcome } from "./lib/thread-gate";

/** A short answer; a hung gateway must not hold the action forever. */
const ASIDE_TIMEOUT_MS = 60_000;

const ASIDE_DAILY_LIMIT_MESSAGE = "You've reached your daily message limit. Side questions are available again tomorrow.";

const vAsideRow = v.object({ role: v.union(v.literal("assistant"), v.literal("user")), text: v.string() });

/**
 * What a side question sees of a thread: the newest rows of its ACTIVE path
 * (finished, no tool traffic), oldest first, and the id of the reply being
 * written, if any. Internal and read-only; the action has already admitted the
 * caller at `read` level, locked chats included.
 */
export const readAsideSnapshot = internalQuery
    .input({ threadId: v.id("threads"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(v.object({ liveStreamId: v.optional(v.id("persistentStreams")), rows: v.array(vAsideRow) }))
    .query(async ({ args: { threadId, unlockProof }, ctx }) => {
        const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });

        if (!thread) {
            return { rows: [] };
        }

        const paging = { cursor: null, numItems: ASIDE_CONTEXT_ROWS };
        const branched = await listActivePathPage(ctx, thread, paging, unlockProof, false);
        const linear = branched
            ? undefined
            : await listMessagesByThreadIdHandler(ctx, {
                  excludeToolMessages: true,
                  order: "desc",
                  paginationOpts: paging,
                  statuses: ["success"],
                  threadId,
                  unlockProof,
              });
        const page = branched?.page ?? linear?.page ?? [];

        const rows: AsideRow[] = [];

        for (const row of page.toReversed()) {
            const message = row.message as ModelMessage | undefined;
            const role = message?.role;
            const text = message ? extractText(message) : undefined;

            if (row.status === "success" && !row.tool && (role === "user" || role === "assistant") && text) {
                rows.push({ role, text });
            }
        }

        const live = await ctx.db.persistentStreams.findFirst({
            orderBy: [{ _creationTime: "asc" }],
            where: { status: { in: ["pending", "streaming"] }, threadId },
        });

        return { ...(live?.streamingConfig.contentType === "text" && { liveStreamId: live._id }), rows };
    });

type AsideModel = { kind: "thread"; model: string } | { kind: "utility" };

/**
 * Which model answers. The thread's own, unless it cannot serve this caller or
 * is not a text model — then the utility model. A model that runs only in the
 * user's browser is refused outright.
 */
const chooseAsideModel = async (
    ctx: Parameters<typeof resolveRunModel>[0],
    thread: { mode?: string; model?: string } | null,
    userId: string,
): Promise<AsideModel> => {
    const model = thread?.model;

    if (!model) {
        return { kind: "utility" };
    }

    const custom = parseCustomModelId(model) !== null;
    const definition = custom ? undefined : MODEL_LOOKUP.get(model);

    if (!custom && (!definition || definition.provider === "external" || definition.enabled === false || (definition.mode ?? "text") !== "text")) {
        return { kind: "utility" };
    }

    try {
        await resolveRunModel(ctx, model, userId);

        return { kind: "thread", model };
    } catch (error) {
        if (isAgentRunError(error, "local-endpoint")) {
            throw new LunoraError("BAD_REQUEST", "This chat runs on your own computer. Side questions are not available for it.");
        }

        if (isAgentRunError(error, "plan-required") || isAgentRunError(error, "custom-endpoint")) {
            return { kind: "utility" };
        }

        throw error;
    }
};

export const askAside = authAction
    .use(rateLimit("chat/message"))
    .input({
        question: v.string().max(MAX_LENGTH.text),
        threadId: v.id("threads"),
        /** A locked chat's passcode proof, as every call that names the thread carries it. */
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.object({
            answer: v.string(),
            /** False when the model saw the question alone: a coding-agent thread's messages never go to a cloud model. */
            withThread: v.boolean(),
        }),
    )
    .action(async ({ args: { question: rawQuestion, threadId, unlockProof }, ctx }) => {
        const { plan, role, userId } = ctx.user;
        const question = rawQuestion.trim();

        if (!question) {
            throw new LunoraError("BAD_REQUEST", "Ask a question first");
        }

        if (question.length > MAX_ASIDE_QUESTION_CHARS) {
            throw new LunoraError("BAD_REQUEST", "That question is too long for a side question. Ask it in the chat.");
        }

        const gate = await ctx.runQuery(internal.chat.functions.gateThreadAction, { level: "read", threadId, unlockProof, userId });

        throwUnlessGranted(gate.outcome, "Access denied to this thread");

        const hostRun = gate.hostRun === true;
        const thread = await ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId });
        const chosen: AsideModel = hostRun ? { kind: "utility" } : await chooseAsideModel(ctx, thread, userId);

        const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });
        const charge = await chargeDailyLimit(ctx, { _id: userId, isAnonymous: flags.isAnonymous, plan: plan ?? null, role: role ?? null }, "Text");

        if (!charge.ok) {
            throw new LunoraError("TOO_MANY_REQUESTS", ASIDE_DAILY_LIMIT_MESSAGE, {
                data: { code: "TOO_MANY_REQUESTS", message: ASIDE_DAILY_LIMIT_MESSAGE, retryAfter: charge.retryAfter },
            });
        }

        // A coding agent's thread keeps its messages off cloud models: the question goes alone.
        const snapshot = hostRun ? { rows: [] } : await ctx.runQuery(internal.chat.aside.readAsideSnapshot, { threadId, unlockProof });
        const live = snapshot.liveStreamId
            ? await ctx.runQuery(internal.chat.streaming.persistent.library.getStreamText, { streamId: snapshot.liveStreamId })
            : undefined;

        const prompt = buildAsidePrompt(question, fitAsideRows(snapshot.rows), live?.text);
        const gateway = gatewayFetch(ctx);

        let model: LanguageModel;

        if (chosen.kind === "thread") {
            const [prefs, userProviderKeys, modelFilterRules, runModel] = await Promise.all([
                ctx.runQuery(internal.auth.functions.getUserPreferencesQuery, { userId }),
                loadUserProviderKeys(ctx, userId),
                loadModelFilterRules(ctx, userId),
                resolveRunModel(ctx, chosen.model, userId),
            ]);
            const agent = await getAgent(chosen.model, {
                customProvider: runModel.customProvider,
                gateway,
                language: prefs.language,
                modelFilterRules,
                threadId,
                timezone: prefs.timezone,
                userId,
                userProviderKeys,
            });

            model = agent.options.languageModel as LanguageModel;
        } else {
            model = await getUtilityModel(gateway, { threadId, userId });
        }

        try {
            const { text } = await generateText({
                abortSignal: AbortSignal.timeout(ASIDE_TIMEOUT_MS),
                maxOutputTokens: ASIDE_MAX_OUTPUT_TOKENS,
                maxRetries: 0,
                model,
                prompt,
                system: ASIDE_SYSTEM_PROMPT,
                temperature: 0.3,
            });

            // Lengths and routing only: the question and the answer are the user's and stay out of the logs.
            ctx.log.event("chat.ask_aside", {
                answerChars: text.length,
                questionChars: question.length,
                running: snapshot.liveStreamId !== undefined,
                userId,
                utility: chosen.kind === "utility",
            });

            return { answer: text.trim(), withThread: !hostRun };
        } catch (error) {
            chatLogger.warn("[askAside] the call failed", { error: error instanceof Error ? error.message : String(error) });

            throw new LunoraError("INTERNAL", "Could not answer the question. Try again.");
        }
    });

/** The caller's side question and its answer, as the one message that goes into the thread. */
export const addAsideToThread = authMutation
    .use(rateLimit("chat/message"))
    .input({
        answer: v.string().max(MAX_LENGTH.text),
        question: v.string().max(MAX_LENGTH.text),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ messageId: v.string() }))
    .mutation(async ({ args: { answer, question, threadId, unlockProof }, ctx }) => {
        const { userId } = ctx.user;

        if (!question.trim() || !answer.trim()) {
            throw new LunoraError("BAD_REQUEST", "There is nothing to add");
        }

        if (question.length > MAX_ASIDE_QUESTION_CHARS || answer.length > MAX_ASIDE_ANSWER_CHARS) {
            throw new LunoraError("BAD_REQUEST", "This side question is too long to add to the thread");
        }

        // The same gate as every other write to the chat: a locked chat needs its proof.
        throwUnlessGranted(await threadGateOutcome(ctx, { level: "write", threadId, unlockProof, userId }), "Write access denied to this thread");

        // Admitted by the gate above, so readable through row-level security.
        const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });

        if (!thread || thread.deleted) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        // The row reads as the assistant's own, and a later run reads it as such, so only the owner posts it
        // (as `saveLocalTurn` does with the text a browser supplies): a collaborator with write access does not.
        if (thread.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Only the owner of a chat can add to it from here");
        }

        // A worker's thread takes a turn only through `dispatchToWorker`.
        if (await isWorkerThread(ctx, threadId)) {
            throw new LunoraError("BAD_REQUEST", "This is a worker's thread. Message the worker from its thread instead.");
        }

        // A row that lands after a running reply's pending row would split that reply across two branches.
        const running = await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId } });

        if (running) {
            throw new LunoraError("CONFLICT", "Wait for the reply to finish before adding this to the thread");
        }

        const last = await getMaxMessage(ctx, threadId);
        // A branched thread: hang the row off the leaf the user is looking at.
        // An unbranched one needs no explicit parent (the previous row is it).
        const leaf = thread.activeLeafMessageId ? await resolveLeafRow(ctx, threadId, thread.activeLeafMessageId) : null;

        const { messages } = await addMessagesHandler(ctx, {
            agentName: ASIDE_AGENT_NAME,
            messages: [{ message: { content: formatAsideMessage(question, answer), role: "assistant" }, status: "success" }],
            overrideOrder: (last?.order ?? -1) + 1,
            ...(leaf && { parentMessageId: leaf._id }),
            threadId,
            userId,
        });
        const [row] = messages;

        if (!row) {
            throw new LunoraError("INTERNAL", "Failed to add the answer to the thread");
        }

        await patchThread(ctx.db, threadId, { updatedAt: ctx.now });

        ctx.log.event("chat.add_aside", { answerChars: answer.length });

        return { messageId: row._id };
    });
