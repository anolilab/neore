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
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { callOnShard } from "../../lib/cross-shard";
import { streamLogger } from "../../lib/logger";
import { isThreadLocked } from "../../lib/thread-lock";
import { GOAL_CONTINUATION_AGENT } from "../goals/shared";
import { messageCarriesGuestText } from "./attached-text";
import { afterRun, stampSavedToolCalls } from "./agent-run";
import type { McpToolLabels } from "./mcp-tool-labels";

export interface FinishedReply {
    /** A goal holds the thread: its review follows, so the thread's reply stamp and follow-ups are left to the goal. */
    goal: boolean;
    labels?: McpToolLabels;
    messageId: string;
    replyRowIds: string[];
    skill?: { id?: string; name: string };
    threadId: string;
    timeZone?: string;
    userId: string;
    userPrompt: string;
}

export const recoverFinishedReply = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery" | "scheduler">, reply: FinishedReply): Promise<void> => {
    const { goal, labels, messageId, replyRowIds, skill, threadId, timeZone, userId, userPrompt } = reply;
    const found = await ctx.runQuery(internal.agent.messages.getMessagesByIdsUnfiltered, { messageIds: replyRowIds as Id<"messages">[] });
    const rows = found.filter((row) => row !== null);

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
    // As a normal finish decides it: a locked chat's content, a goal round's instruction and a guest's note the owner sent on are
    // never mined for memory.
    const extractMemory =
        prefs?.memoryEnabled === true &&
        thread !== null &&
        !isThreadLocked(thread) &&
        !messageCarriesGuestText(prompt[0]?.message as Parameters<typeof messageCarriesGuestText>[0]) &&
        prompt[0]?.agentName !== GOAL_CONTINUATION_AGENT;

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
        ...(settings?.botId && { botId: settings.botId }),
        extractMemory,
        firstTokenTime: undefined,
        prompt: userPrompt,
        recordUsage: false,
        savedMessages: rows,
        ...(skill && { skill }),
        summarizeThread: prefs?.threadSummariesEnabled === true,
        threadId,
        ...(timeZone && { timeZone }),
        userId,
    });
};
