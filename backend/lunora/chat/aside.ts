/**
 * A side question ("Ask aside"): the user asks something while a reply is
 * still streaming (or between turns) and gets a short answer in a panel,
 * without touching the thread.
 *
 * - `askAside` is ONE model call on a read-only snapshot of the thread (the
 *   newest usable rows of its active path, plus the end of the reply so far
 *   when one is running), with no tools. It writes no message, moves no
 *   branch, and nothing it reads or says reaches the running agent: the
 *   question and the answer live in the client's panel only. The answer comes
 *   back whole, not streamed.
 * - It runs on the thread's own model. A thread on a paired computer's coding
 *   agent must never reach a cloud model (`getFollowupSuggestions`), so there
 *   the utility model sees the QUESTION ALONE. A registry model the caller's
 *   plan cannot run, or a non-text thread, falls back to the utility model
 *   (those threads are already on hosted models). A thread on a CUSTOM
 *   endpoint is never sent anywhere else: if the caller cannot reach that
 *   endpoint (the owner deleted it, or the caller is a collaborator whose
 *   account has no such endpoint) or it runs in the owner's browser, the
 *   question is refused rather than rerouted to a hosted model with the chat.
 * - Billing follows the other one-off utility call (`chat/translate.ts`): the
 *   daily text quota is charged right before the model call, so a refusal or a
 *   failure while preparing it costs nothing, and the gateway meters the call
 *   per user and thread. The per-minute budget is the chat message family. A
 *   collaborator is charged as `/chat/start` charges one: the call names the
 *   thread, so it runs on the OWNER's shard and charges the caller's id there
 *   at the caller's tier. An aside on the thread's own model is recorded in
 *   the usage rollup (`usage/schedule.ts`); one on the utility model is not.
 * - `addAsideToThread` is the only write: ONE assistant row (question quoted,
 *   then the answer) under the name "Side question", as a new turn on the
 *   active branch. It takes the answer only with the token `askAside` signed
 *   for it, so the row's text is one the server produced; it is written once
 *   per side question (`ASIDE_ADD_SCOPE`), and refused while a reply is
 *   running, because a row landing after the run's pending row would split the
 *   reply across branches.
 */
import { isCustomModelId, MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";
import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { resolveLeafRow } from "../agent/branch-rows";
import { listActivePathPage } from "../agent/branches";
import { sumMessageCosts } from "../agent/message-cost";
import { addMessagesHandler, getMaxMessage, listMessagesByThreadIdHandler } from "../agent/messages";
import { extractText } from "../agent/shared";
import { patchThread } from "../agent/table-writes";
import { ASIDE_ADD_CLAIM_TTL_MS, ASIDE_ADD_SCOPE, claimOnce } from "../lib/claim-once";
import { authAction, authMutation, rateLimit } from "../lib/crpc";
import { chatLogger } from "../lib/logger";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel, NO_ALLOWED_UTILITY_MODEL_MESSAGE, NoAllowedUtilityModelError } from "../lib/utility-model";
import { MAX_LENGTH } from "../lib/validators";
import { isWorkerThread } from "../sub-agents/functions";
import { DEFAULT_SKILL_KEY, usageDayOf } from "../usage/activity-logic";
import { scheduleReplyUsage } from "../usage/schedule";
import { isAgentRunError, loadModelFilterRules, loadUserProviderKeys, resolveRunModel } from "./lib/agent-run";
import {
    ASIDE_AGENT_NAME,
    ASIDE_CONTEXT_CHARS,
    ASIDE_CONTEXT_ROWS,
    ASIDE_LIVE_CHUNK_ROWS,
    ASIDE_MAX_OUTPUT_TOKENS,
    ASIDE_MAX_WALKED_ROWS,
    ASIDE_SYSTEM_PROMPT,
    type AsideRow,
    buildAsidePrompt,
    classifyAsideFailure,
    fitAsideRows,
    formatAsideMessage,
    liveReplyTail,
    MAX_ASIDE_ANSWER_CHARS,
    MAX_ASIDE_QUESTION_CHARS,
    signAsideAnswer,
    verifyAsideAnswer,
} from "./lib/aside";
import { chargeDailyLimit } from "./lib/daily-limit";
import getAgent from "./lib/get-agent";
import { throwUnlessGranted, threadGateOutcome } from "./lib/thread-gate";
import { isHostRunThread } from "../acp/lib/host-thread";

/** A short answer; a hung gateway must not hold the action forever. */
const ASIDE_TIMEOUT_MS = 60_000;

const ASIDE_DAILY_LIMIT_MESSAGE = "You've reached your daily message limit. Side questions are available again tomorrow.";

/** `data.code` of the refusals the panel words on its own. */
const ASIDE_DAILY_LIMIT_CODE = "DAILY_MESSAGE_LIMIT_REACHED";
const ASIDE_NO_CREDITS_CODE = "INSUFFICIENT_CREDITS";
const ASIDE_RATE_LIMITED_CODE = "UPSTREAM_RATE_LIMITED";
const ASIDE_ALREADY_ADDED_CODE = "ASIDE_ALREADY_ADDED";

/**
 * Signs and checks the answer token. This is the secret the unlock proofs use
 * (`agent/thread-passcode.ts`): it is held by the backend alone, where
 * `LLM_GATEWAY_SIGNING_SECRET` is shared with the gateway Worker.
 */
const asideSecret = (): string => process.env.STORAGE_SIGNING_SECRET ?? "";

const vAsideRow = v.object({ role: v.union(v.literal("assistant"), v.literal("user")), text: v.string() });

type Reader = Pick<QueryCtx, "db">;

/** Streams of a thread looked at, newest first, to find the one that is really running. */
const LIVE_STREAM_CANDIDATES = 5;

/**
 * The reply being written in `threadId`: the newest pending or streaming stream that is not past its expiry (one
 * the reaper has not reached yet is dead, and must neither feed a question nor block "Add to thread").
 */
const findLiveStream = async (ctx: Reader, threadId: string, now: number, options: { hostRun?: boolean } = {}) => {
    // Expiry is part of the query: dead streams the reaper has not reached must not crowd a live one out of the page.
    // Except on a coding agent's thread: a host turn waiting on a permission prompt outlives `expiresAt`, and the
    // reaper extends it rather than ending it, so there any pending or streaming row is the reply still being written.
    const { page } = await ctx.db.persistentStreams.findMany({
        limit: LIVE_STREAM_CANDIDATES,
        orderBy: [{ _creationTime: "desc" }],
        where: { ...(!options.hostRun && { expiresAt: { gt: now } }), status: { in: ["pending", "streaming"] }, threadId },
    });

    return page[0];
};

/** Whether an edit of the thread is still streaming its reply (edits run on `streamingMessages`, not a persistent stream). */
const hasStreamingEdit = async (ctx: Reader, threadId: string): Promise<boolean> =>
    (await ctx.db
        .query("streamingMessages")
        .withIndex("threadId_state_order_stepOrder", (q) => q.eq("threadId", threadId as Id<"threads">).eq("stateKind", "streaming"))
        .first()) !== null;

/** A finished text row of the user or the assistant, as the snapshot carries it; tool traffic and unfinished rows are not. */
const usableRowOf = (row: Doc<"messages">): AsideRow | undefined => {
    const message = row.message as ModelMessage | undefined;
    const role = message?.role;
    const text = message ? extractText(message) : undefined;

    return row.status === "success" && !row.tool && (role === "user" || role === "assistant") && text ? { role, text } : undefined;
};

/**
 * The newest usable rows of the thread's active path, newest first. A branched walk returns every row of the path, tool
 * steps and unfinished ones included, so a page can hold few usable rows: it keeps walking, to a hard cap, until there
 * are enough.
 */
const readPathRows = async (ctx: QueryCtx, thread: Doc<"threads">, unlockProof: string | undefined): Promise<AsideRow[]> => {
    const paging = (cursor: string | null) => {
        return { cursor, numItems: ASIDE_CONTEXT_ROWS };
    };
    const branched = await listActivePathPage(ctx, thread, paging(null), unlockProof, false);
    const readPage = async (cursor: string | null) =>
        branched
            ? await listActivePathPage(ctx, thread, paging(cursor), unlockProof, false)
            : await listMessagesByThreadIdHandler(ctx, {
                  excludeToolMessages: true,
                  order: "desc",
                  paginationOpts: paging(cursor),
                  statuses: ["success"],
                  threadId: thread._id,
                  unlockProof,
              });
    const newestFirst: AsideRow[] = [];
    let chars = 0;
    let walked = 0;
    let page = branched ?? (await readPage(null));

    while (page) {
        for (const row of page.page) {
            const usable = usableRowOf(row);

            walked += 1;

            if (usable) {
                newestFirst.push(usable);
                chars += usable.text.length;
            }
        }

        if (page.isDone || newestFirst.length >= ASIDE_CONTEXT_ROWS || chars >= ASIDE_CONTEXT_CHARS || walked >= ASIDE_MAX_WALKED_ROWS) {
            break;
        }

        page = await readPage(page.continueCursor);
    }

    return newestFirst;
};

/** Only the end of a text reply is wanted, so only its newest chunks are read. */
const readLiveReply = async (ctx: Reader, live: Doc<"persistentStreams">): Promise<string | undefined> => {
    if (live.streamingConfig.contentType !== "text" || live.status !== "streaming") {
        return undefined;
    }

    const { page } = await ctx.db.persistentChunks.findMany({ limit: ASIDE_LIVE_CHUNK_ROWS, orderBy: [{ seq: "desc" }], where: { streamId: live._id } });

    return liveReplyTail(page);
};

/**
 * What a side question sees of a thread: the newest usable rows of its ACTIVE
 * path (finished, no tool traffic), clipped and fitted to the context budget,
 * oldest first, and the end of the reply being written, if any. Internal and
 * read-only; the action has already admitted the caller at `read` level,
 * locked chats included.
 */
export const readAsideSnapshot = internalQuery
    .input({ threadId: v.id("threads"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(v.object({ liveReply: v.optional(v.string()), rows: v.array(vAsideRow), running: v.boolean() }))
    .query(async ({ args: { threadId, unlockProof }, ctx }) => {
        const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });

        if (!thread) {
            return { rows: [], running: false };
        }

        const newestFirst = await readPathRows(ctx, thread, unlockProof);
        const rows = fitAsideRows(newestFirst.slice(0, ASIDE_CONTEXT_ROWS).toReversed());
        const live = await findLiveStream(ctx, threadId, Date.now());
        const liveReply = live ? await readLiveReply(ctx, live) : undefined;

        return { ...(liveReply !== undefined && { liveReply }), rows, running: live !== undefined };
    });

type AsideModel = { kind: "thread"; model: string } | { kind: "utility" };

/**
 * Which model answers. The thread's own, unless it cannot serve this caller or
 * is not a text model: then the utility model. A custom endpoint is never
 * replaced by a hosted model (see the header): an endpoint the caller cannot
 * reach refuses the question.
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

    if (isCustomModelId(model)) {
        if (parseCustomModelId(model) === null) {
            throw new LunoraError("BAD_REQUEST", "Side questions are not available for this chat.");
        }

        try {
            await resolveRunModel(ctx, model, userId);

            return { kind: "thread", model };
        } catch (error) {
            if (isAgentRunError(error, "local-endpoint")) {
                throw new LunoraError("BAD_REQUEST", "This chat runs on your own computer. Side questions are not available for it.");
            }

            if (isAgentRunError(error, "custom-endpoint")) {
                throw new LunoraError("BAD_REQUEST", "This chat runs on a custom endpoint you cannot reach, so side questions are not available for it.");
            }

            throw error;
        }
    }

    const definition = MODEL_LOOKUP.get(model);

    if (!definition || definition.provider === "external" || definition.enabled === false || (definition.mode ?? "text") !== "text") {
        return { kind: "utility" };
    }

    try {
        await resolveRunModel(ctx, model, userId);

        return { kind: "thread", model };
    } catch (error) {
        if (isAgentRunError(error, "plan-required")) {
            return { kind: "utility" };
        }

        throw error;
    }
};

export const askAside = authAction
    .use(rateLimit("chat/message"))
    .input({
        /** The panel's id for this side question: the key "Add to thread" is made idempotent on, and the usage record's. */
        entryId: v.string().max(MAX_LENGTH.short),
        question: v.string().max(MAX_LENGTH.text),
        threadId: v.id("threads"),
        /** A locked chat's passcode proof, as every call that names the thread carries it. */
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.object({
            answer: v.string(),
            /** Proof the server wrote `answer` for this question: "Add to thread" posts nothing without it. */
            token: v.string(),
            /** False when the model saw the question alone: a coding-agent thread's messages never go to a cloud model. */
            withThread: v.boolean(),
        }),
    )
    .action(async ({ args: { entryId, question: rawQuestion, threadId, unlockProof }, ctx }) => {
        const { plan, role, userId } = ctx.user;
        const question = rawQuestion.trim();

        if (!question || !entryId.trim()) {
            throw new LunoraError("BAD_REQUEST", "Ask a question first");
        }

        if (question.length > MAX_ASIDE_QUESTION_CHARS) {
            throw new LunoraError("BAD_REQUEST", "That question is too long for a side question. Ask it in the chat.");
        }

        const secret = asideSecret();

        if (!secret) {
            throw new LunoraError("INTERNAL", "Side questions are not configured on this server.");
        }

        const gate = await ctx.runQuery(internal.chat.functions.gateThreadAction, { level: "read", threadId, unlockProof, userId });

        throwUnlessGranted(gate.outcome, "Access denied to this thread");

        const hostRun = gate.hostRun === true;
        const thread = await ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId });
        const chosen: AsideModel = hostRun ? { kind: "utility" } : await chooseAsideModel(ctx, thread, userId);

        // A coding agent's thread keeps its messages off cloud models: the question goes alone.
        const snapshot = hostRun ? { rows: [], running: false } : await ctx.runQuery(internal.chat.aside.readAsideSnapshot, { threadId, unlockProof });
        const prompt = buildAsidePrompt(question, snapshot.rows, snapshot.liveReply);
        const gateway = gatewayFetch(ctx);

        let model: LanguageModel;
        let timezone: string | undefined;

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
            timezone = prefs.timezone;
        } else {
            model = await getUtilityModel(gateway, { rules: await loadModelFilterRules(ctx, userId), threadId, userId }).catch((error: unknown) => {
                throw error instanceof NoAllowedUtilityModelError ? new LunoraError("BAD_REQUEST", NO_ALLOWED_UTILITY_MODEL_MESSAGE) : error;
            });
        }

        // Charged only now that the call is certain to be made: a refusal above, or a failure while the model was
        // prepared, costs the user nothing.
        const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });
        const charge = await chargeDailyLimit(ctx, { _id: userId, isAnonymous: flags.isAnonymous, plan: plan ?? null, role: role ?? null }, "Text");

        if (!charge.ok) {
            throw new LunoraError("TOO_MANY_REQUESTS", ASIDE_DAILY_LIMIT_MESSAGE, {
                data: { code: ASIDE_DAILY_LIMIT_CODE, message: ASIDE_DAILY_LIMIT_MESSAGE, retryAfter: charge.retryAfter },
            });
        }

        try {
            const result = await generateText({
                abortSignal: AbortSignal.timeout(ASIDE_TIMEOUT_MS),
                maxOutputTokens: ASIDE_MAX_OUTPUT_TOKENS,
                maxRetries: 0,
                model,
                prompt,
                system: ASIDE_SYSTEM_PROMPT,
                temperature: 0.3,
            });
            const answer = result.text.trim();

            // Lengths and routing only: the question and the answer are the user's and stay out of the logs.
            ctx.log.event("chat.ask_aside", {
                answerChars: answer.length,
                questionChars: question.length,
                running: snapshot.running,
                userId,
                utility: chosen.kind === "utility",
            });

            // The usage page shows what the thread's own model spent; the utility model's calls are not a reply of the user's.
            if (chosen.kind === "thread") {
                const at = Date.now();
                const cost = sumMessageCosts((result.steps ?? []).map((step: { providerMetadata?: unknown }) => step.providerMetadata));

                scheduleReplyUsage(ctx.scheduler as never, {
                    at,
                    costMicrodollars: Math.round(cost?.microdollars ?? 0),
                    date: usageDayOf(at, timezone),
                    replyKey: `aside:${entryId}`,
                    skillKey: DEFAULT_SKILL_KEY,
                    tokens: result.totalUsage?.totalTokens ?? 0,
                    userId,
                });
            }

            return { answer, token: await signAsideAnswer({ answer, question, threadId, userId }, secret), withThread: !hostRun };
        } catch (error) {
            chatLogger.warn("[askAside] the call failed", { error: error instanceof Error ? error.message : String(error) });

            const failure = classifyAsideFailure(error);

            if (failure === "credits") {
                throw new LunoraError("UNPROCESSABLE", "There are no credits left to answer this question.", { data: { code: ASIDE_NO_CREDITS_CODE } });
            }

            if (failure === "rate-limited") {
                throw new LunoraError("TOO_MANY_REQUESTS", "The model is busy. Try again in a moment.", { data: { code: ASIDE_RATE_LIMITED_CODE } });
            }

            throw new LunoraError("INTERNAL", "Could not answer the question. Try again.");
        }
    });

/** The caller's side question and its answer, as the one message that goes into the thread. */
export const addAsideToThread = authMutation
    .use(rateLimit("chat/message"))
    .input({
        answer: v.string().max(MAX_LENGTH.text),
        /** The id the question was asked under (`askAside`): a second add of it is refused with `ASIDE_ALREADY_ADDED`. */
        entryId: v.string().max(MAX_LENGTH.short),
        question: v.string().max(MAX_LENGTH.text),
        threadId: v.id("threads"),
        /** What `askAside` returned with the answer. */
        token: v.string().max(MAX_LENGTH.short),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ messageId: v.string() }))
    .mutation(async ({ args: { answer, entryId, question, threadId, token, unlockProof }, ctx }) => {
        const { userId } = ctx.user;

        if (!question.trim() || !answer.trim() || !entryId.trim()) {
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

        // The text goes into the chat as the assistant's, so it must be the one `askAside` produced for this question.
        if (!(await verifyAsideAnswer({ answer, question, threadId, userId }, token, asideSecret()))) {
            throw new LunoraError("BAD_REQUEST", "This answer cannot be added to the thread");
        }

        // A worker's thread takes a turn only through `dispatchToWorker`.
        if (await isWorkerThread(ctx, threadId)) {
            throw new LunoraError("BAD_REQUEST", "This is a worker's thread. Message the worker from its thread instead.");
        }

        // A row that lands after a running reply's pending row would split that reply across two branches.
        if ((await findLiveStream(ctx, threadId, ctx.now, { hostRun: isHostRunThread(thread) })) || (await hasStreamingEdit(ctx, threadId))) {
            throw new LunoraError("CONFLICT", "Wait for the reply to finish before adding this to the thread");
        }

        const last = await getMaxMessage(ctx, threadId);
        // A branched thread: hang the row off the leaf the user is looking at.
        // An unbranched one needs no explicit parent (the previous row is it).
        const leaf = thread.activeLeafMessageId ? await resolveLeafRow(ctx, threadId, thread.activeLeafMessageId) : null;

        // Last, after every check that can refuse: a refused add leaves the claim free (and a throw below rolls it back
        // with the rest), so the same question can be added once the reply has finished.
        if (!(await claimOnce(ctx, ASIDE_ADD_SCOPE, `${userId}:${threadId}:${entryId}`, ASIDE_ADD_CLAIM_TTL_MS, userId))) {
            throw new LunoraError("CONFLICT", "This side question is already in the thread", { data: { code: ASIDE_ALREADY_ADDED_CODE } });
        }

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
