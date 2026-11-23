/**
 * Whether a turn may use saved site logins: an ALLOWLIST. Every message the model is sent (the saved rows of the prompt's
 * path and the step's own messages), every tool it is offered and every piece of its system prompt must be of a kind this
 * file knows to be safe; anything else, including a row, part, tool, tag or context kind nobody classified yet, refuses.
 * Whoever can put text in front of the model could otherwise steer it to sign in as the owner, so a new source of text
 * gets no login until it is added here on purpose.
 *
 * Safe, and nothing else:
 * - the owner's own typed text: a user row of theirs, text parts only, with no mark, attachment, note or blockquote (a
 *   forward, a quoted reply and a pasted quote carry no mark, so any `>` line is not theirs). A draft from a link or
 *   someone else's saved prompt, and anything an admin acting as the owner wrote, is marked (`lib/not-typed-text.ts`);
 * - the lead model's own replies in this thread: assistant text, reasoning and tool calls, with no mark, sources,
 *   memories or file;
 * - rows named by the lead's model id only (`agentName`): a sub-agent's result, a side question, a goal round, a group
 *   speaker and a coding agent each carry a name of their own, which is no model id;
 * - the results of `SAFE_RESULT_TOOLS`, whose output cannot carry text from outside;
 * - built-in tools only (`toolSources`), and a system prompt of `SAFE_SYSTEM_CONTEXT` kinds only.
 *
 * `listUsableSiteLogins` and `siteLoginForFill` decide only through {@link siteLoginTurnVerdict}; so must the fill tool.
 */
import { MODEL_LOOKUP, parseCustomModelId } from "@neore/ai/models";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { ToolCtx } from "../agent/client/create-tool";
import { HOST_PROVIDER } from "../acp/lib/reply";
import { walkPath } from "../agent/branch-rows";
import { parseGoalReviewNote } from "../chat/goals/shared";
import { carriesQuotedLines, messageCarriesGuestText, messageCarriesOutsideAgentText, messagesCarryAttachedText } from "../chat/lib/attached-text";
import { readCompressedHistory } from "../chat/lib/compressed-history";
import { loadEligibleThread } from "../devices/internal";
import { computeTaint } from "../devices/lib/taint";
import { notTypedMarksOfMessage } from "../lib/not-typed-text";

/** A model message as the AI SDK holds it: a saved row's `message`, or one of `ToolExecutionOptions.messages`. */
export type SiteLoginMessage = { content?: unknown; providerOptions?: unknown; role?: unknown };

export type SiteLoginTurn = {
    headless: boolean;
    impersonated: boolean;
    origin: string;
    /**
     * The fill's own tool call, when it runs approved (`agent/client/tool-approval.ts` runs it with no messages): its step
     * is then read from the saved rows below the prompt, and that call's approval request is the one part admitted.
     */
    ownCallId?: string;
    promptMessageId: Id<"messages">;
    startedBy: string;
    /** The messages the model saw for the step (`ToolExecutionOptions.messages`), as they are: classified here. */
    stepMessages: ReadonlyArray<SiteLoginMessage>;
    /** Every kind of text in the run's system prompt (`SAFE_SYSTEM_CONTEXT` names the safe ones). */
    systemContext: ReadonlyArray<string>;
    /** The source of every tool the model is offered (`ToolSource`): an MCP, connector or device tool brings its own description. */
    toolSources: ReadonlyArray<string>;
};

export type SiteLoginVerdict = { allowed: false; reason: string } | { allowed: true; thread: Doc<"threads"> };

/**
 * Tools whose result is ours alone: a clock, a static list and the model's own task list. Kept short on purpose: a tool
 * that returns what a person, a provider, a page, a file or another model wrote is not here, nor is one this file is
 * unsure of (`askUser`, `listCurrencies`, whose codes come from an outside API, the media and document tools, MCP,
 * connectors, devices, sub-agents).
 */
export const SAFE_RESULT_TOOLS: ReadonlySet<string> = new Set(["dateTime", "listLanguages", "taskList"]);

/**
 * The kinds of system-prompt text a login turn may run with: the app's own instructions (required, so an empty list is
 * no answer), the owner's personalization, the instructions of the teammate the thread runs as (a login reaches a
 * teammate's thread only when the owner named that teammate on it), our own agent and search mode text, and the task
 * plan, which quotes only the prompt checked below (`chat/lib/system-context-kinds.ts#agentPromptKinds`). Knowledge,
 * memories, project context, the thread's stored or the request's instructions, skills, thread notes and anything else
 * refuse.
 */
export const SAFE_SYSTEM_CONTEXT: ReadonlySet<string> = new Set(["agent-mode", "instructions", "personalization", "search-mode", "task-plan", "teammate"]);

/** Tools whose description and schema are ours: an MCP server, a connector or a device writes its own. */
const SAFE_TOOL_SOURCES: ReadonlySet<string> = new Set(["builtin"]);

/** The only tag a chat the owner opened at the app carries (`chat/functions.ts`). */
const SAFE_THREAD_TAGS: ReadonlySet<string> = new Set(["chat"]);

/** Rows of the prompt's path read; a longer path refuses, since the rows not read cannot be vouched for. */
const PATH_ROWS = 3000;
const PATH_PAGE = 100;

type Part = { providerMetadata?: unknown; providerOptions?: unknown; text?: unknown; toolCallId?: unknown; toolName?: unknown; type?: unknown };

const hasNeoreMark = (meta: unknown): boolean => typeof meta === "object" && meta !== null && "neore" in meta;

/** Row-level metadata a plain lead reply carries: the provider's own and the gateway's cost record. Any other `neore…` key (an agent switch, a context reset, knowledge sources, a media job, a coding agent's run) is not a plain reply. */
const hasUnsafeRowMetadata = (meta: unknown): boolean =>
    typeof meta === "object" && meta !== null && Object.keys(meta).some((key) => key.startsWith("neore") && key !== "neoreGateway");

/**
 * The name the lead's own rows carry: the model id the run's agent is named for (`chat/lib/get-agent.ts#agentNameFor`),
 * a registry id or a custom endpoint's. Every other writer names itself (`Sub-agent`, `Side question`, `neore:goal`, a
 * group speaker), and none of those is a model id.
 */
export const isLeadAgentName = (name: string | undefined): boolean => name === undefined || MODEL_LOOKUP.has(name) || parseCustomModelId(name) !== null;

const textOf = (content: unknown): string[] =>
    typeof content === "string" ? [content] : (content as ReadonlyArray<Part>).flatMap((part) => (typeof part.text === "string" ? [part.text] : []));

const userMessageRefusal = (message: SiteLoginMessage): string | null => {
    const { content } = message;
    // Named before the generic `neore` mark below refuses them too: the composer's draft from a link or someone else's
    // saved prompt, and anything an admin acting as the owner wrote (`lib/not-typed-text.ts`).
    const notTyped = notTypedMarksOfMessage(message);

    if (notTyped.impersonated === true) {
        return "impersonated";
    }

    if (notTyped.draft !== undefined) {
        return `draft-${notTyped.draft}`;
    }

    const typedOnly =
        typeof content === "string" ||
        (Array.isArray(content) &&
            (content as ReadonlyArray<Part>).every(
                (part) => part.type === "text" && typeof part.text === "string" && !hasNeoreMark(part.providerOptions) && !hasNeoreMark(part.providerMetadata),
            ));

    if (!typedOnly) {
        return "not-typed";
    }

    const notOwn =
        readCompressedHistory(message) !== null ||
        textOf(content).some((text) => parseGoalReviewNote(text) !== null || carriesQuotedLines(text)) ||
        messageCarriesOutsideAgentText(message) ||
        messageCarriesGuestText(message) ||
        messagesCarryAttachedText([message]) ||
        computeTaint([message]).length > 0;

    return notOwn ? "not-typed" : null;
};

const ASSISTANT_PART_TYPES: ReadonlySet<unknown> = new Set(["reasoning", "text", "tool-call"]);

const assistantMessageRefusal = (message: SiteLoginMessage, ownCallId: string | undefined): string | null => {
    if (typeof message.content === "string") {
        return null;
    }

    // The approval request of the fill's own call, and no other: one for another call stands for a call not run yet.
    const own = (message.content as ReadonlyArray<Part>).every(
        (part) =>
            (part.type === "tool-approval-request" && ownCallId !== undefined && part.toolCallId === ownCallId) ||
            (ASSISTANT_PART_TYPES.has(part.type) && (part.type !== "text" || (!hasNeoreMark(part.providerOptions) && !hasNeoreMark(part.providerMetadata)))),
    );

    return own ? null : "assistant-part";
};

const toolMessageRefusal = (message: SiteLoginMessage): string | null =>
    Array.isArray(message.content) &&
    (message.content as ReadonlyArray<Part>).every(
        (part) => part.type === "tool-result" && typeof part.toolName === "string" && SAFE_RESULT_TOOLS.has(part.toolName),
    )
        ? null
        : "tool-result";

/**
 * Why one model message is not safe, or `null` when it is: typed user text, the model's own reply, or a safe tool's
 * result. Any other role (a `system` message among the messages), a part nobody classified, or no content refuses.
 */
export const messageRefusal = (message: SiteLoginMessage | undefined, ownCallId?: string): string | null => {
    if (!message || (typeof message.content !== "string" && !Array.isArray(message.content))) {
        return "no-content";
    }

    // A message the app put in front of the model from elsewhere (a search hit, `agent/client/search.ts`) is marked on
    // the message itself: it reads like a row of this path, so the mark is all that tells it apart.
    if (hasNeoreMark(message.providerOptions)) {
        return "retrieved";
    }

    switch (message.role) {
        case "assistant": {
            return assistantMessageRefusal(message, ownCallId);
        }
        case "tool": {
            return toolMessageRefusal(message);
        }
        case "user": {
            return userMessageRefusal(message);
        }
        default: {
            return "unknown-role";
        }
    }
};

/**
 * Why one saved row on the prompt's path is not safe, or `null` when it is: the owner's row, named for the lead's model
 * or not at all, with no group speaker, coding agent, metadata of the app's own, file, sources or memories, and a
 * message {@link messageRefusal} admits.
 */
export const pathRowRefusal = (row: Doc<"messages">, userId: string, ownCallId?: string): string | null => {
    if (row.userId !== userId) {
        return "not-owner";
    }

    if (!isLeadAgentName(row.agentName) || row.speakerSkillId !== undefined || row.provider === HOST_PROVIDER || hasUnsafeRowMetadata(row.providerMetadata)) {
        return "agent-row";
    }

    if ((row.fileIds?.length ?? 0) > 0 || (row.retrievedMemories?.length ?? 0) > 0 || (Array.isArray(row.sources) && row.sources.length > 0)) {
        return "row-context";
    }

    return messageRefusal(row.message as SiteLoginMessage | undefined, ownCallId);
};

/**
 * Why the thread is not one a login may be used in, or `null`: it must be the owner's alone (`loadEligibleThread`), a
 * chat they opened at the app (tagged `chat` and nothing else), never a sub-agent's, worker's, trigger's, task's, eval's,
 * coding agent's, messenger's, imported, handed over, branched or otherwise derived thread, nor one with a context
 * summary (model-written notes in the system prompt). An untagged thread (a temporary chat from the composer, a branch,
 * the prompt optimizer's) refuses too.
 */
const threadVerdict = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">, userId: string): Promise<SiteLoginVerdict> => {
    const thread = await loadEligibleThread(ctx, threadId, userId);

    if (!thread) {
        return { allowed: false, reason: "thread-not-eligible" };
    }

    const tags = thread.tags ?? [];

    if (
        tags.length === 0 ||
        tags.some((tag) => !SAFE_THREAD_TAGS.has(tag)) ||
        thread.runner !== undefined ||
        thread.hasHandoff === true ||
        (thread.parentThreadIds?.length ?? 0) > 0 ||
        (thread.createdBy !== undefined && thread.createdBy !== userId)
    ) {
        return { allowed: false, reason: "thread-kind" };
    }

    // A branch, a continuation, a comparison or a sub-agent's thread starts from rows another thread wrote.
    const relation = await ctx.db
        .query("threadRelationships")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .first();

    if (relation) {
        return { allowed: false, reason: "thread-derived" };
    }

    // A summary reaches the model as notes in its system prompt, written by a model from rows nobody re-reads here.
    const summary = await ctx.db
        .query("threadContextSummaries")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .first();

    return summary ? { allowed: false, reason: "thread-summary" } : { allowed: true, thread };
};

/**
 * The turn a tool call belongs to, from its tool context (`ToolCtx`) and the call's own `messages` and offered tools, or
 * `null` when the run recorded no turn (`runTurn` unset: a run path or snapshot without it), which refuses.
 */
export const siteLoginTurnOf = (
    context: Pick<ToolCtx, "dispatchOrigin" | "headless" | "runTurn" | "startedBy">,
    call: { ownCallId?: string; stepMessages: ReadonlyArray<SiteLoginMessage>; toolSources: ReadonlyArray<string> },
): SiteLoginTurn | null => {
    const { runTurn } = context;

    if (runTurn === undefined || context.startedBy === undefined || context.dispatchOrigin === undefined) {
        return null;
    }

    return {
        headless: context.headless === true,
        impersonated: runTurn.impersonated,
        origin: context.dispatchOrigin,
        ...(call.ownCallId !== undefined && { ownCallId: call.ownCallId }),
        promptMessageId: runTurn.promptMessageId as Id<"messages">,
        startedBy: context.startedBy,
        stepMessages: call.stepMessages,
        systemContext: runTurn.systemContext,
        toolSources: call.toolSources,
    };
};

/** The owner's own turn at the app: they started it, signed in as themselves, in the lead chat, with somebody watching. */
export const isOwnInteractiveTurn = (turn: SiteLoginTurn, userId: string): boolean =>
    turn.startedBy === userId && turn.origin === "lead" && turn.headless === false && turn.impersonated === false;

const turnRefusal = (turn: SiteLoginTurn, userId: string): string | null => {
    if (!isOwnInteractiveTurn(turn, userId)) {
        return "turn";
    }

    if (!turn.systemContext.includes("instructions") || turn.systemContext.some((kind) => !SAFE_SYSTEM_CONTEXT.has(kind))) {
        return "system-context";
    }

    if (turn.toolSources.some((source) => !SAFE_TOOL_SOURCES.has(source))) {
        return "tools";
    }

    // The step's messages hold this run's own steps, which are not on the saved path above the prompt. An approved call's
    // step is read from the saved rows instead (`approvedStepRefusal`).
    if (turn.stepMessages.length === 0 && turn.ownCallId !== undefined) {
        return null;
    }

    const step =
        turn.stepMessages.length === 0
            ? "no-step-messages"
            : turn.stepMessages.map((message) => messageRefusal(message, turn.ownCallId)).find((reason) => reason !== null);

    return step ? `step:${step}` : null;
};

/**
 * Why the step of an approved call is not safe, or `null`. The call ran outside the step that made it, with no messages:
 * the step is the saved rows from the prompt down to the row holding the call's approval request, on the prompt's own
 * path, each classified as a row of the path is. A request not found, or not below the prompt, refuses.
 */
const approvedStepRefusal = async (
    ctx: Pick<QueryCtx, "db">,
    threadId: Id<"threads">,
    prompt: Doc<"messages">,
    callId: string,
    userId: string,
): Promise<string | null> => {
    const holdsRequest = (row: Doc<"messages">): boolean => {
        const content = (row.message as SiteLoginMessage | undefined)?.content;

        return Array.isArray(content) && (content as ReadonlyArray<Part>).some((part) => part.type === "tool-approval-request" && part.toolCallId === callId);
    };

    // Paged, newest first, as far as a turn's path is ever read (`PATH_ROWS`): a busy turn's request may sit below a page.
    let asking: Doc<"messages"> | undefined;
    let cursor: string | null = null;
    let searched = 0;

    do {
        const page = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId).gte("order", prompt.order))
            .order("desc")
            .paginate({ cursor, numItems: PATH_PAGE });
        const rows = page.page as unknown as Doc<"messages">[];

        asking = rows.find((row) => holdsRequest(row));
        searched += rows.length;
        cursor = page.isDone ? null : page.continueCursor;
    } while (!asking && cursor !== null && searched < PATH_ROWS);

    if (!asking) {
        return "approval-not-found";
    }

    // Up from the request to the prompt, a page at a time within the same limit; every row read is classified, and a path
    // that does not reach the prompt in it refuses.
    let from: Doc<"messages"> | null = asking;
    let walked = 0;

    while (from && from._id !== prompt._id) {
        if (walked >= PATH_ROWS) {
            return "approval-path";
        }

        const { next, rows } = await walkPath(ctx, threadId, from, { limit: PATH_PAGE, stopAtId: prompt._id });
        const reason = rows.map((row) => pathRowRefusal(row, userId, callId)).find((refusal) => refusal !== null);

        if (reason) {
            return reason;
        }

        walked += rows.length;
        from = next;
    }

    return from?._id === prompt._id ? null : "approval-path";
};

/**
 * Whether a run of `threadId` may use saved logins, and why not. Checks the turn, the thread, then walks the prompt's
 * path from the prompt up: the prompt must be the owner's own typed row of this thread, and every row above it safe.
 */
export const siteLoginTurnVerdict = async (
    ctx: Pick<QueryCtx, "db">,
    args: { threadId: Id<"threads">; turn: SiteLoginTurn; userId: string },
): Promise<SiteLoginVerdict> => {
    const { threadId, turn, userId } = args;
    const refused = turnRefusal(turn, userId);

    if (refused) {
        return { allowed: false, reason: refused };
    }

    const thread = await threadVerdict(ctx, threadId, userId);

    if (!thread.allowed) {
        return thread;
    }

    const prompt = await ctx.db.get("messages", turn.promptMessageId);

    if (prompt?.threadId !== threadId || (prompt.message as SiteLoginMessage | undefined)?.role !== "user") {
        return { allowed: false, reason: "prompt" };
    }

    if (turn.stepMessages.length === 0 && turn.ownCallId !== undefined) {
        const step = await approvedStepRefusal(ctx, threadId, prompt, turn.ownCallId, userId);

        if (step) {
            return { allowed: false, reason: `step:${step}` };
        }
    }

    let cursor: Doc<"messages"> | null = prompt;
    let rowsRead = 0;

    while (cursor && rowsRead < PATH_ROWS) {
        const { next, rows } = await walkPath(ctx, threadId, cursor, { limit: PATH_PAGE });

        for (const row of rows) {
            const reason = pathRowRefusal(row, userId);

            if (reason) {
                return { allowed: false, reason: row._id === prompt._id ? `prompt:${reason}` : `path:${reason}` };
            }
        }

        rowsRead += rows.length;
        cursor = next;
    }

    return cursor ? { allowed: false, reason: "path-too-long" } : thread;
};
