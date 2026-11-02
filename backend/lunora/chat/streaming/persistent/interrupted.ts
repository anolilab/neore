/**
 * Resuming a run whose worker died (`chat/lib/interrupted-run.ts` holds the rules).
 *
 * A run registers once it is about to generate (`registerResumableRun`): its job arguments go on the stream, it beats
 * while it lives (`beatRun`), and a watchdog (`interrupted-watch.ts`) looks at it every minute. A claimed stream
 * that is not waiting out a rate limit and has missed its beats is dead; `inspectRun` then either queues the SAME
 * resume job a rate-limit pause queues (a `pause` with reason `interrupted`, claimed by `claimRunResume`), or fails
 * the run. At-least-once safety lives in that claim: the resume runs once, from rows that are already saved, and the
 * reply is recorded once (usage is keyed on its first row).
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../../../_generated/dataModel";
import { internal } from "../../../_generated/internal";
import { internalMutation } from "../../../_generated/server";
import { patchRow } from "../../../lib/patch";
import { interruptionMessage, planInterruption, RUN_STALE_MS, RUN_WATCH_MS, type SavedRow, settleSavedRows } from "../../lib/interrupted-run";
import { recordPausedRunUsage } from "../../lib/pause-usage";
import { assertCurrentRun, assertRunHeld, epochOf, RUN_REPLACED } from "../../lib/run-epoch";
import type { SteerEntry } from "../../lib/steer-queue";
import { runStreamingAgentFields } from "../../lib/streaming-run-args";
import { endPausedRun, enqueueRunResume, isEmptyPlaceholder, isLiveStream, isSuperseded, removeEmptyPending, STREAM_TTL_MS } from "./library";

/**
 * The run that holds a stream registers it for resuming: the job's own arguments are stored (a resume re-enters the same
 * job), the first beat is set, and, the first time, the watchdog is started. A resume registers again to beat, not to
 * start a second watchdog. `resumable` is the person's setting, read by the run's own action (on the stream's shard the
 * row of a collaborator on a shared thread is absent). `false` when the stream is not live or was never claimed; a run
 * a newer one replaced is refused (`RUN_REPLACED`).
 */
export const registerResumableRun = internalMutation
    .input({
        epoch: v.number(),
        reply: v.object({ skill: v.optional(v.object({ id: v.optional(v.string()), name: v.string() })), timeZone: v.optional(v.string()) }),
        resumable: v.boolean(),
        run: v.object({ ...runStreamingAgentFields }),
        streamId: v.id("persistentStreams"),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (!stream || !isLiveStream(stream) || stream.runClaimedAt === undefined) {
            return false;
        }

        assertCurrentRun(stream, args.epoch);

        const run = Object.fromEntries(Object.entries(args.run).filter(([key]) => key !== "resume")) as typeof args.run;

        await ctx.db.patch("persistentStreams", stream._id, {
            beatAt: ctx.now,
            expiresAt: Math.max(stream.expiresAt, ctx.now + STREAM_TTL_MS),
            replyContext: args.reply,
            resumable: args.resumable,
            runArgs: run,
        });

        if (stream.runArgs === undefined) {
            await ctx.scheduler.runAfter(RUN_WATCH_MS, internal.chat.streaming.persistent.interrupted_watch.watchRun, { streamId: stream._id });
        }

        return true;
    });

/**
 * The run is alive. Written about once a minute, never faster: it patches the stream row, which re-runs the live
 * stream query for every viewer (the reason chunks keep no counter there). Ignored while paused or when not live. A beat
 * from a run a newer one replaced is refused (`RUN_REPLACED`): that run stops.
 */
export const beatRun = internalMutation
    .input({ epoch: v.number(), streamId: v.id("persistentStreams") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (stream && isLiveStream(stream)) {
            assertCurrentRun(stream, args.epoch);
        }

        if (stream && isLiveStream(stream) && stream.pause === undefined) {
            // The stream's expiry moves with the beat (the same write), so a death late in its window is the watchdog's to see, not the sweep's.
            await ctx.db.patch("persistentStreams", stream._id, { beatAt: ctx.now, expiresAt: Math.max(stream.expiresAt, ctx.now + STREAM_TTL_MS) });
        }

        return null;
    });

/**
 * A tool call begins (`+1`) or its step is saved and the calls in it end (`-n`). A worker that dies with one open may
 * have paid for or changed something and leaves no row, so `inspectRun` refuses to resume it. A begin on a stream that is
 * no longer live is refused, so the tool does not run unmarked; so is any mark from a run a newer one replaced
 * (`RUN_REPLACED`), which would otherwise corrupt the newer run's count.
 */
export const markToolRun = internalMutation
    .input({ delta: v.number(), epoch: v.number(), streamId: v.id("persistentStreams") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (!stream || !isLiveStream(stream)) {
            if (args.delta > 0) {
                throw new LunoraError("CONFLICT", "The stream is no longer live");
            }

            return null;
        }

        assertCurrentRun(stream, args.epoch);

        // A tool starts only on a run that holds the stream: never one that is paused or being resumed.
        if (args.delta > 0 && stream.pause !== undefined) {
            throw new LunoraError(RUN_REPLACED, "The run is paused or being resumed");
        }

        const next = Math.max(0, (stream.toolsInFlight ?? 0) + args.delta);

        await patchRow(ctx.db, "persistentStreams", stream, { toolsInFlight: next === 0 ? undefined : next });

        return null;
    });

/**
 * A step is about to be saved: refused if a newer run holds the stream, so a slow old run lands no rows beside the
 * resume's. Checked right before the save (`beforeStepSave`).
 */
export const assertRunEpoch = internalMutation
    .input({ epoch: v.number(), streamId: v.id("persistentStreams") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await assertRunHeld(ctx, { epoch: args.epoch, streamId: args.streamId });

        return null;
    });

/**
 * When the stream's reply ends: the creation time of the thread's next stream (a new message, a regenerate, an edit
 * starts one), `Infinity` when there is none. `0` when the thread has so many newer streams that the next one is not
 * in view: nothing is then read as this reply's.
 */
const replyEndOf = async (ctx: { db: Record<string, any> }, stream: Doc<"persistentStreams">): Promise<number> => {
    const { page } = (await ctx.db.persistentStreams.findMany({
        limit: 4,
        orderBy: [{ _creationTime: "desc" }],
        where: { threadId: stream.threadId },
    })) as { page: Doc<"persistentStreams">[] };
    const newer = page.filter((other) => other._id !== stream._id && other._creationTime >= stream._creationTime);

    if (newer.length === 0) {
        return Infinity;
    }

    return page.some((other) => other._id === stream._id) ? Math.min(...newer.map((other) => other._creationTime)) : 0;
};

/** The rows this reply saved since its stream began (every invocation of it), as `settleSavedRows` reads them. */
const savedRowsOf = async (
    ctx: { db: { get: (table: "messages", id: Id<"messages">) => Promise<Doc<"messages"> | null> } & Record<string, any> },
    stream: Doc<"persistentStreams">,
): Promise<SavedRow[]> => {
    const prompt = await ctx.db.get("messages", stream.messageId as Id<"messages">);

    if (!prompt) {
        return [];
    }

    // Rows of a newer stream (a new message, a regenerate, an edit) are another reply's: they are never this one's anchor, steps or usage.
    const until = await replyEndOf(ctx, stream);
    const rows: Doc<"messages">[] = await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", stream.threadId).gte("order", prompt.order))
        .collect();

    return rows
        .filter((row) => row._id !== prompt._id && row._creationTime >= stream._creationTime && row._creationTime < until)
        .map((row) => {
            const message = row.message as { content?: unknown; role?: string } | undefined;

            return {
                callsTools: Array.isArray(message?.content) && message.content.some((part: { type?: string }) => part?.type === "tool-call"),
                empty: isEmptyPlaceholder(row),
                id: row._id,
                order: row.order,
                role: message?.role,
                status: row.status,
                stepOrder: row.stepOrder,
            };
        });
};

const vVerdict = v.union(
    v.object({ kind: v.literal("gone") }),
    v.object({ kind: v.literal("fresh") }),
    v.object({ kind: v.literal("finished") }),
    v.object({ kind: v.literal("resumed") }),
    v.object({ kind: v.literal("fail"), message: v.string(), threadId: v.string() }),
);

/**
 * The watchdog's look at one stream. `gone`: nothing left to watch (also a run a newer stream superseded, which ends
 * quietly). `fresh`: alive (or waiting out a rate limit): look again later. `finished`: the worker died after saving
 * the whole answer, so the run was closed here instead of asking the model again. `resumed`: the worker was dead, the
 * resume is queued. `fail`: dead and not safe to resume; the caller ends the run with the message (`failRun`), after
 * the rows it saved were recorded here as one reply.
 */
export const inspectRun = internalMutation
    .input({ streamId: v.id("persistentStreams") })
    .output(vVerdict)
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (!stream || !isLiveStream(stream) || stream.producer === "host" || stream.runClaimedAt === undefined || stream.runArgs === undefined) {
            return { kind: "gone" as const };
        }

        const { now } = ctx;
        const { pause } = stream;

        if (pause) {
            // A resume that was queued and never claimed (a lost job) is queued again; the claim lets only one run.
            if (stream.pauseCause === "interrupted" && pause.retryAt < now - RUN_WATCH_MS) {
                const due = { ...pause, retryAt: now };

                await ctx.db.patch("persistentStreams", stream._id, { pause: due });
                await enqueueRunResume(due, 0);
            }

            return { kind: "fresh" as const };
        }

        // The usual case, and the cheap one: a run that beat lately is alive, and no message is read for it.
        const beatAt = stream.beatAt ?? stream.runClaimedAt;

        if (now - beatAt < RUN_STALE_MS) {
            return { kind: "fresh" as const };
        }

        if (stream.resumable === false) {
            // Opted out: the stream expires into `timeout` as it always did.
            return { kind: "gone" as const };
        }

        const saved = settleSavedRows(await savedRowsOf(ctx, stream));
        const threadId = stream.threadId as Id<"threads">;
        // Everything this reply saved so far is one reply: recorded once, whichever way it ends.
        const pausedRun = {
            replyRowIds: [...new Set([...(stream.pausedRun?.replyRowIds ?? []), ...saved.replyRowIds])],
            stepsUsed: saved.ok ? saved.stepsUsed : (stream.pausedRun?.stepsUsed ?? 0),
            ...((stream.pausedRun?.skill ?? stream.replyContext?.skill) && { skill: (stream.pausedRun?.skill ?? stream.replyContext?.skill)! }),
            ...((stream.pausedRun?.timeZone ?? stream.replyContext?.timeZone) && { timeZone: (stream.pausedRun?.timeZone ?? stream.replyContext?.timeZone)! }),
        };
        const from = saved.ok ? (saved.from ?? stream.messageId) : stream.messageId;

        // A newer reply took the thread: this one is a branch nobody reads. It ends quietly, whatever else is wrong with it,
        // and never sets the thread to `error` under the reply that is live.
        if (await isSuperseded(ctx, stream, from)) {
            await endPausedRun(ctx, { ...stream, pausedRun });

            return { kind: "gone" as const };
        }

        const plan = planInterruption({
            beatAt,
            interruptions: stream.interruptions ?? 0,
            now,
            saved,
            steerDelivered: ((stream.steers as SteerEntry[] | undefined) ?? []).some((entry) => entry.status === "delivered"),
            toolsInFlight: stream.toolsInFlight ?? 0,
        });

        if (plan.action === "wait") {
            return { kind: "fresh" as const };
        }

        // The dead step opened an empty placeholder before its call; the resume opens its own, and a failed run keeps no empty bubble.
        if (saved.ok) {
            for (const id of saved.placeholders) {
                const placeholder = await ctx.db.messages.findFirst({ where: { _id: id as Id<"messages">, threadId } });

                if (placeholder && isEmptyPlaceholder(placeholder)) {
                    await removeEmptyPending(ctx, threadId, placeholder);
                }
            }
        }

        if (plan.action === "finish") {
            // The answer is saved whole: record it once and close the stream, as a run that ended itself would have.
            await endPausedRun(ctx, { ...stream, pausedRun });

            return { kind: "finished" as const };
        }

        if (plan.action === "fail") {
            // `toolsInFlight` stays: a failure that could not be delivered (`failRun` threw) is looked at again and must fail the same way.
            await recordPausedRunUsage(ctx, { ...stream, pausedRun });
            await patchRow(ctx.db, "persistentStreams", stream, { pausedRun: undefined });

            return { kind: "fail" as const, message: interruptionMessage(plan.reason), threadId: stream.threadId };
        }

        const interruptions = (stream.interruptions ?? 0) + 1;
        const resume = {
            from,
            id: `${now}-i${interruptions}`,
            reason: "rate_limit" as const,
            retryAt: now,
            run: stream.runArgs,
            status: 0,
        };

        await patchRow(ctx.db, "persistentStreams", stream, {
            beatAt: now,
            expiresAt: Math.max(stream.expiresAt, now + STREAM_TTL_MS),
            interruptions,
            pause: resume,
            pauseCause: "interrupted" as const,
            pausedRun,
            // The run judged dead is fenced from this moment, not only once the resume claims: it may be slow, not dead.
            runEpoch: epochOf(stream) + 1,
            toolsInFlight: undefined,
        });
        await enqueueRunResume(resume, 0);

        return { kind: "resumed" as const };
    });
