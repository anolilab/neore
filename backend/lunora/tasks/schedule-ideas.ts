/**
 * The daily schedule-ideas job: once a day, for a user who turned the feature on (and memory), one utility-model call
 * over their own recent typed messages proposes a few recurring tasks, which {@link insertTaskSuggestions} validates and
 * stores for the person to accept or dismiss. Nothing here creates a task.
 *
 * - **Trigger**: `dispatchScheduleIdeas`, a housekeeping sweep (`shardSweeps()`), on the user's own shard. It enqueues the
 *   job when the user's day is not yet taken; no cron of its own.
 * - **A skipped run does not spend the day**: when a switch is off at delivery, the action answers `{ skipped: true }`,
 *   `runJobOnce` gives its claim back, and the day's own claim is released, so turning the feature back on the same UTC
 *   day runs the job. The queued-day mark is NOT deleted by the action: `runJobOnce` gives its job claim back only after
 *   the action returned, and a replacement sent in between would be dropped by that claim while its own fresh mark
 *   blocked every later sweep. The action marks the queued-day mark `skipped` instead, and the sweep replaces a
 *   `skipped` mark only once the job claim is gone (`dispatchScheduleIdeas`).
 * - **Once a day**: `prepareScheduleIdeas` takes the day's claim (`idempotencyClaims`) in the same mutation that reads the
 *   messages, so a redelivery, or a sweep that enqueued twice before the job ran, does nothing a second time. The job is
 *   also queued `once`, a paid call that is never made twice. A day whose model call fails is not retried until tomorrow.
 * - **The day is the queued day**: the sweep puts its UTC day in the job's arguments, and every step (claim, queued mark,
 *   release) uses that day, never the delivery time: a job queued before midnight and delivered after it spends its own
 *   day and leaves the next one to the next sweep.
 * - **Input**: the person's typed words only (`messages.typedText` of user rows), from the chats `readable` allows;
 *   never an assistant reply, tool output, file or attachment.
 *   Bounded in `schedule-ideas-logic.ts`. A message with a privacy marker or a secret is left out.
 * - **Logs** carry counts only, never message text.
 */
import { generateText, Output } from "ai";
import { v } from "lunorash/server";
import z from "zod/v4";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalAction, internalMutation } from "../_generated/server";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { claimOnce, claimRow, hasClaim, recordClaimResult, releaseClaim } from "../lib/claim-once";
import { enqueueJob } from "../lib/job-queue";
import { JOB_SCOPE } from "../lib/job-once";
import { gatewayFetch } from "../lib/services";
import { currentUserShard } from "../lib/shard-context";
import { isThreadLocked } from "../lib/thread-lock";
import { getUtilityModel } from "../lib/utility-model";
import { readMemoryEnabled } from "../memory/functions";
import { hasPrivacyMarker } from "../memory/gate";
import {
    buildIdeasPrompt,
    IDEA_ROWS_READ_PER_THREAD,
    IDEA_THREADS_SCANNED,
    type IdeaSource,
    isScheduleIdeasDay,
    MAX_IDEA_SOURCE_MESSAGES,
    MAX_IDEA_SOURCE_THREADS,
    SCHEDULE_IDEAS_CLAIM_SCOPE,
    SCHEDULE_IDEAS_CLAIM_TTL_MS,
    SCHEDULE_IDEAS_QUEUED_SCOPE,
    SCHEDULE_IDEAS_SKIPPED,
    SCHEDULE_IDEAS_SYSTEM_PROMPT,
    SCHEDULE_IDEAS_WINDOW_MS,
    scheduleIdeasDay,
    scheduleIdeasDayKeyFor,
    takeIdeaSources,
    toSuggestions,
    turnTexts,
} from "./schedule-ideas-logic";
import { readScheduleIdeasEnabled } from "./suggestions";

/** A stalled gateway call must not hold the job: it fails and the day is spent. */
const IDEAS_CALL_TIMEOUT_MS = 60_000;
const IDEAS_MAX_OUTPUT_TOKENS = 1500;

/** Whether the person has both switches on: the feature, and memory (the same opt-in the other background jobs read). */
const jobsAllowed = async (ctx: Parameters<typeof readScheduleIdeasEnabled>[0], userId: string): Promise<boolean> =>
    (await readScheduleIdeasEnabled(ctx, userId)) && (await readMemoryEnabled(ctx, userId));

/** Whether a stored message (typed `any`) is a user-role one. */
const isUserRole = (message: unknown): boolean => typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user";

/**
 * Chats the person typed in: the composer's `chat` tag alone (both ways a chat is started write it; an untagged thread is
 * server-made, a prompt-optimiser or headless run). A run thread (`task`, `trigger`, `eval`,
 * `sub-agent`, `worker`), a host or local-model chat, a pull request thread and a messenger chat carry another tag,
 * and a messenger or bridged chat also names its connection, external id or source; their user-role rows hold a
 * prompt a job wrote or words another person sent, not the owner's own. Temporary, locked, deleted (or being deleted),
 * stateless and host-run chats are left out too.
 */
const readable = (thread: Doc<"threads">): boolean => {
    const tags = thread.tags ?? [];
    const typedHere = tags.length === 1 && tags[0] === "chat";

    return (
        typedHere &&
        thread.messengerConnectionId === undefined &&
        thread.externalThreadId === undefined &&
        thread.source === undefined &&
        thread.botId === undefined &&
        thread.deleted !== true &&
        thread.deletingAt === undefined &&
        thread.isTemporary !== true &&
        thread.statelessMode !== true &&
        thread.runner !== "host" &&
        !isThreadLocked(thread)
    );
};

/**
 * Gives a skipped job's queued-day mark its `skipped` state (see the header): the sweep may replace it once the job claim
 * is gone. Not a delete, because `runJobOnce` is still holding that claim while the action runs.
 */
const markQueuedSkipped = async (ctx: Parameters<typeof claimOnce>[0], key: string): Promise<void> => {
    const queued = await claimRow(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key);

    if (queued) {
        await recordClaimResult(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key, queued.claimedAt, SCHEDULE_IDEAS_SKIPPED);
    }
};

/**
 * Housekeeping sweep (`shardSweeps()`): queues the day's job for the shard's own user when the feature and memory are on
 * and the day is not taken yet, once: a queued-day mark is taken in the same step, so passes before delivery send
 * nothing. Cheap to run every pass: it reads two settings and three claims. A failed enqueue gives the mark back, so the
 * next pass tries again.
 *
 * Nothing is sent while the day's job claim (`runJobOnce`) is held, in flight or done: the copy would be dropped by it.
 * A mark a skipped job left (`skipped`) is replaced once that claim is back, which is what lets a replacement run.
 */
export const dispatchScheduleIdeas = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (!userId || !(await jobsAllowed(ctx, userId))) {
            return null;
        }

        const day = scheduleIdeasDay(ctx.now);
        const key = scheduleIdeasDayKeyFor(userId, day);

        if ((await hasClaim(ctx, SCHEDULE_IDEAS_CLAIM_SCOPE, key)) || (await hasClaim(ctx, JOB_SCOPE, `schedule-ideas:${key}`))) {
            return null;
        }

        const queued = await claimRow(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key);

        if (queued) {
            if (queued.result !== SCHEDULE_IDEAS_SKIPPED) {
                return null;
            }

            await releaseClaim(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key, queued.claimedAt);
        }

        // Marked queued BEFORE the send: a queue that is slow to deliver would otherwise get one more copy from every pass.
        if (!(await claimOnce(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key, SCHEDULE_IDEAS_CLAIM_TTL_MS, userId))) {
            return null;
        }

        try {
            await enqueueJob(internal.tasks.schedule_ideas.generateScheduleIdeas, { day, userId }, { once: { jobId: `schedule-ideas:${key}`, userId } });
        } catch (error) {
            console.warn("[tasks/schedule-ideas] The job could not be queued; the next pass tries again:", error);
            await releaseClaim(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key);
        }

        return null;
    });

/**
 * Takes the user's `day` (the one the job was queued for) and reads what the model may see. Empty when a switch is off (then
 * `skipped`, and the day's queued mark is marked `skipped` so the sweep can queue it again once the switch is on), the day was
 * already taken, or there is nothing typed to read. The claim comes first, in this transaction: a second call gets no messages.
 */
export const prepareScheduleIdeas = internalMutation
    .input({ day: v.string(), userId: v.string() })
    .output(v.object({ messages: v.array(v.object({ text: v.string(), threadId: v.id("threads") })), skipped: v.optional(v.boolean()) }))
    .mutation(async ({ args: { day, userId }, ctx }) => {
        const key = scheduleIdeasDayKeyFor(userId, day);

        // Nothing is claimed while a switch is off: the caller is told, so the job's own claim is given back too.
        if (!(await jobsAllowed(ctx, userId))) {
            await markQueuedSkipped(ctx, key);

            return { messages: [], skipped: true };
        }

        if (!(await claimOnce(ctx, SCHEDULE_IDEAS_CLAIM_SCOPE, key, SCHEDULE_IDEAS_CLAIM_TTL_MS, userId))) {
            return { messages: [] };
        }

        const since = ctx.now - SCHEDULE_IDEAS_WINDOW_MS;
        // Newest first, and the filter runs BEFORE the cap: a person with many run threads (a trigger or task opens one per
        // run) would otherwise fill the cap with threads that are never read. The scan itself is bounded.
        const scanned = await ctx.db
            .query("threads")
            .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId).gte("updatedAt", since))
            .order("desc")
            .take(IDEA_THREADS_SCANNED);
        const threads = scanned.filter((thread) => readable(thread)).slice(0, MAX_IDEA_SOURCE_THREADS);
        const candidates: IdeaSource<Id<"threads">>[] = [];

        for (const thread of threads) {
            if (candidates.length >= MAX_IDEA_SOURCE_MESSAGES) {
                break;
            }

            const rows = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", thread._id))
                .order("desc")
                .take(IDEA_ROWS_READ_PER_THREAD);

            for (const row of rows) {
                const typed = row.typedText;

                if (
                    typed !== undefined &&
                    // A privacy marker anywhere in the turn (typed words, a quote, an attachment's text) drops the whole turn.
                    turnTexts(row).every((text) => !hasPrivacyMarker(text)) &&
                    row.tool === false &&
                    row.userId === userId &&
                    isUserRole(row.message) &&
                    (row.createdAt ?? row._creationTime) >= since
                ) {
                    candidates.push({ text: typed, threadId: thread._id });
                }
            }
        }

        const messages = takeIdeaSources(candidates);

        ctx.log.event("tasks.schedule_ideas_read", {
            candidates: candidates.length,
            chats: threads.length,
            messages: messages.length,
            scanned: scanned.length,
        });

        return { messages };
    });

/**
 * Right before the model call: whether both switches are still on, and which of the chats the messages came from are still
 * readable (`readable`: a chat locked, deleted or being deleted meanwhile is not). When a switch went off since
 * {@link prepareScheduleIdeas}, the day's claim is released (nothing was sent, so nothing is spent), the queued mark is
 * marked `skipped`, and `confirmed` is false. Otherwise `threadIds` are the chats whose messages may still be sent; the
 * caller drops the rest, and sends nothing when none is left. One bounded read of at most
 * {@link MAX_IDEA_SOURCE_THREADS} chats, in the same transaction as the switch check. A chat can still be locked between this
 * answer and the gateway call; what was already sent cannot be taken back, and the insert re-checks the switches.
 */
export const confirmScheduleIdeas = internalMutation
    .input({ day: v.string(), threadIds: v.array(v.id("threads")), userId: v.string() })
    .output(v.object({ confirmed: v.boolean(), threadIds: v.array(v.id("threads")) }))
    .mutation(async ({ args: { day, threadIds, userId }, ctx }) => {
        if (!(await jobsAllowed(ctx, userId))) {
            const key = scheduleIdeasDayKeyFor(userId, day);

            await releaseClaim(ctx, SCHEDULE_IDEAS_CLAIM_SCOPE, key);
            await markQueuedSkipped(ctx, key);

            return { confirmed: false, threadIds: [] };
        }

        const stillReadable: Id<"threads">[] = [];

        for (const threadId of [...new Set(threadIds)].slice(0, MAX_IDEA_SOURCE_THREADS)) {
            const row = await ctx.db.get("threads", threadId);

            if (row && row.userId === userId && readable(row)) {
                stillReadable.push(threadId);
            }
        }

        return { confirmed: true, threadIds: stillReadable };
    });

const ideasSchema = z.object({
    // No `.max`: a model that returns one idea too many must not fail the parse and spend the day; `toSuggestions` cuts the list.
    ideas: z.array(
        z.object({
            cronExpression: z.string(),
            instructions: z.string(),
            sources: z.array(z.number()),
            title: z.string(),
        }),
    ),
});

/**
 * The day's job (queued `once` by {@link dispatchScheduleIdeas}). Never throws: a failed day changes nothing. A user
 * whose model filter rules allow no utility model, or whose rules cannot be read, is skipped like every other
 * background job; the day stays taken.
 *
 * `jobId` is the claim key `runJobOnce` adds to every target's arguments; it is not read. `day` is the UTC day the sweep
 * queued the job for; it is used for every claim, whenever the job is delivered. A switch that is off, before
 * or after the messages are read, answers `{ skipped: true }`: `runJobOnce` then gives its own claim back instead of
 * completing it, so the same day can run once the person turns the feature on again.
 */
export const generateScheduleIdeas = internalAction
    .input({ day: v.string(), jobId: v.optional(v.string()), userId: v.string() })
    .output(v.union(v.null(), v.object({ skipped: v.literal(true) })))
    .action(async ({ args: { day, userId }, ctx }) => {
        if (!isScheduleIdeasDay(day)) {
            ctx.log.event("tasks.schedule_ideas_failed", { error: "bad_day", messages: 0 });

            return null;
        }

        const { messages: prepared, skipped } = await ctx.runMutation(internal.tasks.schedule_ideas.prepareScheduleIdeas, { day, userId });

        if (skipped) {
            return { skipped: true as const };
        }

        let messages = prepared;

        if (messages.length === 0) {
            return null;
        }

        try {
            const model = await getUtilityModel(gatewayFetch(ctx), { rules: await loadModelFilterRules(ctx, userId), userId });

            // Model selection takes time: a switch turned off, or a source chat locked or deleted, meanwhile must stop that
            // text before it is sent.
            const confirmation = await ctx.runMutation(internal.tasks.schedule_ideas.confirmScheduleIdeas, {
                day,
                threadIds: [...new Set(messages.map((message) => message.threadId))],
                userId,
            });

            if (!confirmation.confirmed) {
                return { skipped: true as const };
            }

            const readableNow = new Set<string>(confirmation.threadIds);

            messages = messages.filter((message) => readableNow.has(message.threadId));

            if (messages.length === 0) {
                ctx.log.event("tasks.schedule_ideas_done", { inserted: 0, messages: 0, proposed: 0 });

                return null;
            }

            const result = await generateText({
                abortSignal: AbortSignal.timeout(IDEAS_CALL_TIMEOUT_MS),
                maxOutputTokens: IDEAS_MAX_OUTPUT_TOKENS,
                model,
                output: Output.object({ schema: ideasSchema }),
                prompt: buildIdeasPrompt(messages),
                system: SCHEDULE_IDEAS_SYSTEM_PROMPT,
            });
            const suggestions = toSuggestions(result.output?.ideas ?? [], messages);
            const { inserted } =
                suggestions.length > 0 ? await ctx.runMutation(internal.tasks.suggestions.insertTaskSuggestions, { suggestions, userId }) : { inserted: 0 };

            ctx.log.event("tasks.schedule_ideas_done", { inserted, messages: messages.length, proposed: suggestions.length });
        } catch (error) {
            // The error may quote the prompt: log its kind only.
            ctx.log.event("tasks.schedule_ideas_failed", { error: error instanceof Error ? error.name : "unknown", messages: messages.length });
        }

        return null;
    });
