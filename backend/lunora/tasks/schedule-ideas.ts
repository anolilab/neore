/**
 * The daily schedule-ideas job: once a day, for a user who turned the feature on (and memory), one utility-model call
 * over their own recent typed messages proposes a few recurring tasks, which {@link insertTaskSuggestions} validates and
 * stores for the person to accept or dismiss. Nothing here creates a task.
 *
 * - **Trigger**: `dispatchScheduleIdeas`, a housekeeping sweep (`shardSweeps()`), on the user's own shard. It enqueues the
 *   job when the user's day is not yet taken; no cron of its own.
 * - **A skipped run does not spend the day**: when a switch is off at delivery, the action answers `{ skipped: true }`,
 *   `runJobOnce` gives its claim back, and the day's own claim is released, so turning the feature back on the same UTC
 *   day runs the job.
 * - **Once a day**: `prepareScheduleIdeas` takes the day's claim (`idempotencyClaims`) in the same mutation that reads the
 *   messages, so a redelivery, or a sweep that enqueued twice before the job ran, does nothing a second time. The job is
 *   also queued `once`, a paid call that is never made twice. A day whose model call fails is not retried until tomorrow.
 * - **Input**: the person's typed words only (`messages.typedText` of user rows), from the chats `readable` allows;
 *   never an assistant reply, tool output, file or attachment.
 *   Bounded in `schedule-ideas-logic.ts`. A message with a privacy marker or a secret is left out.
 * - **Logs** carry counts only, never message text.
 */
import { generateText, Output } from "ai";
import { v } from "lunorash/server";
import z from "zod/v4";

import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalAction, internalMutation } from "../_generated/server";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { claimOnce, hasClaim, releaseClaim } from "../lib/claim-once";
import { enqueueJob } from "../lib/job-queue";
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
    MAX_IDEA_SOURCE_MESSAGES,
    MAX_IDEA_SOURCE_THREADS,
    SCHEDULE_IDEAS_CLAIM_SCOPE,
    SCHEDULE_IDEAS_CLAIM_TTL_MS,
    SCHEDULE_IDEAS_QUEUED_SCOPE,
    SCHEDULE_IDEAS_SYSTEM_PROMPT,
    SCHEDULE_IDEAS_WINDOW_MS,
    scheduleIdeasDayKey,
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
 * Housekeeping sweep (`shardSweeps()`): queues the day's job for the shard's own user when the feature and memory are on
 * and the day is not taken yet, once: a queued-day mark is taken in the same step, so passes before delivery send
 * nothing. Cheap to run every pass: it reads two settings and two claims. A failed enqueue gives the mark back, so the
 * next pass tries again.
 */
export const dispatchScheduleIdeas = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (!userId || !(await jobsAllowed(ctx, userId))) {
            return null;
        }

        const key = scheduleIdeasDayKey(userId, ctx.now);

        if (await hasClaim(ctx, SCHEDULE_IDEAS_CLAIM_SCOPE, key)) {
            return null;
        }

        // Marked queued BEFORE the send: a queue that is slow to deliver would otherwise get one more copy from every pass.
        if (!(await claimOnce(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key, SCHEDULE_IDEAS_CLAIM_TTL_MS, userId))) {
            return null;
        }

        try {
            await enqueueJob(internal.tasks.schedule_ideas.generateScheduleIdeas, { userId }, { once: { jobId: `schedule-ideas:${key}`, userId } });
        } catch (error) {
            console.warn("[tasks/schedule-ideas] The job could not be queued; the next pass tries again:", error);
            await releaseClaim(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key);
        }

        return null;
    });

/**
 * Takes the user's day and reads what the model may see. Empty when a switch is off (then `skipped`, and the day's
 * queued mark is given back so the sweep can queue it again once the switch is on), the day was
 * already taken, or there is nothing typed to read. The claim comes first, in this transaction: a second call gets no messages.
 */
export const prepareScheduleIdeas = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ messages: v.array(v.object({ text: v.string(), threadId: v.string() })), skipped: v.optional(v.boolean()) }))
    .mutation(async ({ args: { userId }, ctx }) => {
        // Nothing is claimed while a switch is off: the caller is told, so the job's own claim is given back too.
        if (!(await jobsAllowed(ctx, userId))) {
            await releaseClaim(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, scheduleIdeasDayKey(userId, ctx.now));

            return { messages: [], skipped: true };
        }

        if (!(await claimOnce(ctx, SCHEDULE_IDEAS_CLAIM_SCOPE, scheduleIdeasDayKey(userId, ctx.now), SCHEDULE_IDEAS_CLAIM_TTL_MS, userId))) {
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
        const candidates: IdeaSource[] = [];

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
 * Right before the model call: whether both switches are still on. When one went off since {@link prepareScheduleIdeas},
 * the day's claim is released (nothing was sent, so nothing is spent) and the answer is false. The switch can still go off
 * between this check and the gateway call; what was already sent cannot be taken back, and the insert re-checks the
 * switch, so nothing is stored.
 */
export const confirmScheduleIdeas = internalMutation
    .input({ userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args: { userId }, ctx }) => {
        if (await jobsAllowed(ctx, userId)) {
            return true;
        }

        const key = scheduleIdeasDayKey(userId, ctx.now);

        await releaseClaim(ctx, SCHEDULE_IDEAS_CLAIM_SCOPE, key);
        await releaseClaim(ctx, SCHEDULE_IDEAS_QUEUED_SCOPE, key);

        return false;
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
 * `jobId` is the claim key `runJobOnce` adds to every target's arguments; it is not read. A switch that is off, before
 * or after the messages are read, answers `{ skipped: true }`: `runJobOnce` then gives its own claim back instead of
 * completing it, so the same day can run once the person turns the feature on again.
 */
export const generateScheduleIdeas = internalAction
    .input({ jobId: v.optional(v.string()), userId: v.string() })
    .output(v.union(v.null(), v.object({ skipped: v.literal(true) })))
    .action(async ({ args: { userId }, ctx }) => {
        const { messages, skipped } = await ctx.runMutation(internal.tasks.schedule_ideas.prepareScheduleIdeas, { userId });

        if (skipped) {
            return { skipped: true as const };
        }

        if (messages.length === 0) {
            return null;
        }

        try {
            const model = await getUtilityModel(gatewayFetch(ctx), { rules: await loadModelFilterRules(ctx, userId), userId });

            // Model selection takes time: a switch turned off meanwhile must stop the prepared text before it is sent.
            if (!(await ctx.runMutation(internal.tasks.schedule_ideas.confirmScheduleIdeas, { userId }))) {
                return { skipped: true as const };
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
