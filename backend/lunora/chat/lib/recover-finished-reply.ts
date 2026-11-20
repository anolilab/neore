/**
 * What a reply gets when the watchdog closes it because its worker died after saving the whole answer
 * (`inspectRun`, `finished`): the work the run's own end would have done, which the dead worker never reached. The close
 * itself (the stream, the thread, the usage record, the goal's review) is the watchdog's transaction; this is the rest,
 * best effort and once, because the stream is closed and nothing looks at it again.
 *
 * - the MCP tool calls are stamped with their real names (`stampSavedToolCalls`), from the labels the run registered;
 * - the thread's reply stamp and the follow-up suggestions, as a normal finish leaves them (not for a goal's thread);
 * - `afterRun` runs as it does after a normal finish: memory extraction, the nightly-reflection stamp, the thread
 *   summary, the Daily Brief activity. Its usage record is skipped (the close recorded it) and so is the timing (the
 *   start of the dead run is not known).
 */
import { internal } from "../../_generated/internal";
import { typedTextOf } from "./attached-text";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { callOnShard } from "../../lib/cross-shard";
import { streamLogger } from "../../lib/logger";
import { afterRun, mayExtractMemory, stampSavedToolCalls } from "./agent-run";
import type { McpToolLabels } from "./mcp-tool-labels";

export interface FinishedReply {
    /** A goal holds the thread: its review follows, so the thread's reply stamp and follow-ups are left to the goal. */
    goal: boolean;
    labels?: McpToolLabels;
    messageId: string;
    /** `outside_agent`: an outside agent wrote the prompt, so none of it is quoted as the user's words. */
    origin?: "lead" | "outside_agent";
    replyRowIds: string[];
    skill?: { id?: string; name: string };
    /** The steer rows delivered into the reply, in order (`interrupted.ts`): the steers the run's own end would have read. */
    steerRowIds?: string[];
    /** Each delivered steer, in order: when it was sent and the length of its text, to split its row (`splitSteerRow`). */
    steers?: { messageId: string; sentAt?: number; textLength?: number }[];
    threadId: string;
    timeZone?: string;
    userId: string;
    userPrompt: string;
}

/**
 * The steers one row holds, each with when it was sent. Steers delivered together share a row (joined a blank line apart),
 * so the row is cut at each steer's text length. A row without the lengths (or whose lengths do not add up to its text) is
 * one steer, dated by the row, as before.
 */
export const splitSteerRow = (
    text: string,
    steers: ReadonlyArray<{ sentAt?: number; textLength?: number }>,
    rowAt: number,
): { sentAt: number; text: string }[] => {
    const lengths = steers.map((steer) => steer.textLength);
    const whole = [{ sentAt: steers[0]?.sentAt ?? rowAt, text }];

    if (steers.length <= 1) {
        return whole;
    }

    const known = lengths.every((length): length is number => length !== undefined);
    const total = known ? lengths.reduce((sum, length) => sum + length, 0) + 2 * (steers.length - 1) : -1;

    if (!known || total !== text.length) {
        return [{ sentAt: rowAt, text }];
    }

    let from = 0;

    return steers.map((steer, index) => {
        const end = from + (lengths[index] ?? 0);
        const part = { sentAt: steer.sentAt ?? rowAt, text: text.slice(from, end) };

        from = end + 2;

        return part;
    });
};

export const recoverFinishedReply = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery" | "scheduler">, reply: FinishedReply): Promise<void> => {
    const { goal, labels, messageId, origin, replyRowIds, skill, steerRowIds = [], steers = [], threadId, timeZone, userId, userPrompt } = reply;
    const found = await ctx.runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: replyRowIds as Id<"messages">[] });
    const rows = found.filter((row) => row !== null);
    // The steers are read from their own rows: the stream's entries keep no text once delivered. Each steer is dated by when it
    // was sent (`steers`), which the run's own end would have given it; a row with no such times is dated by the row.
    const steerRows =
        steerRowIds.length > 0 ? await ctx.runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: steerRowIds as Id<"messages">[] }) : [];
    const steered = steerRows.flatMap((row) => {
        const text = typeof row?.message?.content === "string" ? row.message.content : "";

        if (!row || !text) {
            return [];
        }

        const rowId = row._id as string;
        const own = steers.filter((steer) => steer.messageId === rowId);

        return splitSteerRow(text, own, row._creationTime).map((part) => {
            return { ...part, messageId: rowId };
        });
    });

    if (labels && Object.keys(labels).length > 0) {
        await stampSavedToolCalls(ctx, { mcpLabels: labels, savedMessages: rows, userId }).catch((error: unknown) => {
            streamLogger.warn("[BgAgent] Could not stamp the tool calls of a recovered reply:", error);
        });
    }

    // The person's own settings, on their own shard; the thread and its prompt row on this one.
    const [prefs, thread, prompt, settings] = await Promise.all([
        // A failed read only costs the memory and the summary: the other work still runs.
        callOnShard(internal.auth.functions.getUserPreferencesQuery, { userId }, { shardKey: userId }).catch(() => null),
        ctx.runQuery(internal.agent.threads.getThreadInternal, { threadId: threadId as Id<"threads"> }),
        ctx.runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: [messageId as Id<"messages">] }),
        ctx.runQuery(internal.chat.functions.getThreadSettings, { threadId }),
    ]);
    // As a normal finish decides it (`mayExtractMemory`).
    const extractMemory = mayExtractMemory(prefs?.memoryEnabled === true, thread, prompt[0]);
    // The bot gate a run applies (`agent-run.ts`): a bot counts only when the run's user owns it. Without it a collaborator's
    // recovered turn would write its memory into the owner's bot, where a live run writes it user-wide.
    const bot = settings?.botId ? await ctx.runQuery(internal.bots.functions.getBotForRun, { botId: settings.botId, userId }) : null;

    // What the normal end settles besides the thread's status (the close did that): the reply is stamped (`lastReplyAt`, which
    // the home and the activity views read) and follow-up suggestions are queued. A goal's thread is its own until it ends.
    if (!goal) {
        const at = Date.now();

        await ctx
            .runMutation(internal.agent.threads.updateThread, { patch: { lastReplyAt: at, updatedAt: at }, threadId: threadId as Id<"threads"> })
            .catch((error: unknown) => {
                streamLogger.warn("[BgAgent] Could not stamp the reply of a recovered thread:", error);
            });
        await ctx.scheduler.runAfter(0, internal.chat.functions.generateFollowupSuggestionsForThread, { threadId, userId }).catch(() => undefined);
    }

    await afterRun(ctx, {
        ...(bot && settings?.botId && { botId: settings.botId }),
        extractMemory,
        firstTokenTime: undefined,
        prompt: userPrompt,
        // Relative dates read against the prompt's day, whoever wrote it.
        ...(prompt[0] && { promptAt: prompt[0]._creationTime }),
        // Only the user's own words are quoted, as at a normal finish.
        ...(origin !== "outside_agent" &&
            (prompt[0]?.userId === undefined || prompt[0].userId === userId) && {
                promptMessageId: messageId,
                quotablePrompt: typedTextOf(prompt[0]?.message),
            }),
        recordUsage: false,
        savedMessages: rows,
        ...(skill && { skill }),
        ...(steered.length > 0 && { steered }),
        summarizeThread: prefs?.threadSummariesEnabled === true,
        threadId,
        ...(timeZone && { timeZone }),
        userId,
    });
};
