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
import { interruptionMessage, planInterruption, RUN_WATCH_MS, type SavedRow, settleSavedRows } from "../../lib/interrupted-run";
import { recordPausedRunUsage } from "../../lib/pause-usage";
import type { SteerEntry } from "../../lib/steer-queue";
import { runStreamingAgentFields } from "../../lib/streaming-run-args";
import { endPausedRun, enqueueRunResume, isEmptyPlaceholder, isLiveStream, isSuperseded, removeEmptyPending, STREAM_TTL_MS } from "./library";

/**
 * The run that holds a stream registers it for resuming: the job's own arguments are stored (a resume re-enters the same
 * job), the first beat is set, and, the first time, the watchdog is started. A resume registers again to beat, not to
 * start a second watchdog. `false` when the stream is not live or was never claimed.
 */
export const registerResumableRun = internalMutation
    .input({ run: v.object({ ...runStreamingAgentFields }), streamId: v.id("persistentStreams") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (!stream || !isLiveStream(stream) || stream.runClaimedAt === undefined) {
            return false;
        }

        const run = Object.fromEntries(Object.entries(args.run).filter(([key]) => key !== "resume")) as typeof args.run;

        await ctx.db.patch("persistentStreams", stream._id, { beatAt: ctx.now, runArgs: run });

        if (stream.runArgs === undefined) {
            await ctx.scheduler.runAfter(RUN_WATCH_MS, internal.chat.streaming.persistent.interrupted_watch.watchRun, { streamId: stream._id });
        }

        return true;
    });

/**
 * The run is alive. Written about once a minute, never faster: it patches the stream row, which re-runs the live
 * stream query for every viewer (the reason chunks keep no counter there). Ignored while paused or when not live.
 */
export const beatRun = internalMutation
    .input({ streamId: v.id("persistentStreams") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (stream && isLiveStream(stream) && stream.pause === undefined) {
            await ctx.db.patch("persistentStreams", stream._id, { beatAt: ctx.now });
        }

        return null;
    });

/**
 * A tool call begins (`+1`) or ends (`-1`). A worker that dies with one open may have paid for or changed something and
 * leaves no row, so `inspectRun` refuses to resume it. A begin on a stream that is no longer live is refused, so the
 * tool does not run unmarked.
 */
export const markToolRun = internalMutation
    .input({ delta: v.union(v.literal(1), v.literal(-1)), streamId: v.id("persistentStreams") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId } });

        if (!stream || !isLiveStream(stream)) {
            if (args.delta === 1) {
                throw new LunoraError("CONFLICT", "The stream is no longer live");
            }

            return null;
        }

        const next = Math.max(0, (stream.toolsInFlight ?? 0) + args.delta);

        await patchRow(ctx.db, "persistentStreams", stream, { toolsInFlight: next === 0 ? undefined : next });

        return null;
    });

/** The rows the run saved since its stream began (every invocation of it), as `settleSavedRows` reads them. */
const savedRowsOf = async (
    ctx: { db: { get: (table: "messages", id: Id<"messages">) => Promise<Doc<"messages"> | null> } & Record<string, any> },
    stream: Doc<"persistentStreams">,
): Promise<SavedRow[]> => {
    const prompt = await ctx.db.get("messages", stream.messageId as Id<"messages">);

    if (!prompt) {
        return [];
    }

    const rows: Doc<"messages">[] = await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", stream.threadId).gte("order", prompt.order))
        .collect();

    return rows
        .filter((row) => row._id !== prompt._id && row._creationTime >= stream._creationTime)
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
    v.object({ kind: v.literal("resumed") }),
    v.object({ kind: v.literal("fail"), message: v.string(), threadId: v.string() }),
);

/**
 * The watchdog's look at one stream. `gone`: nothing left to watch. `fresh`: alive (or waiting out a rate limit): look
 * again later. `resumed`: the worker was dead, the resume is queued. `fail`: dead and not safe to resume; the caller
 * ends the run with the message (`failRun`), after the rows it saved were recorded here as one reply.
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

        const settings = await ctx.db.userSettings.findFirst({ where: { userId: stream.userId } });

        if (settings?.resumeInterruptedRuns === false) {
            // Opted out: the stream expires into `timeout` as it always did.
            return { kind: "gone" as const };
        }

        const saved = settleSavedRows(await savedRowsOf(ctx, stream));
        const plan = planInterruption({
            beatAt: stream.beatAt ?? stream.runClaimedAt,
            interruptions: stream.interruptions ?? 0,
            now,
            saved,
            steerDelivered: ((stream.steers as SteerEntry[] | undefined) ?? []).some((entry) => entry.status === "delivered"),
            toolsInFlight: stream.toolsInFlight ?? 0,
        });

        if (plan.action === "wait") {
            return { kind: "fresh" as const };
        }

        const threadId = stream.threadId as Id<"threads">;
        // Everything this reply saved so far is one reply: recorded once, whichever way it ends.
        const pausedRun = {
            replyRowIds: [...new Set([...(stream.pausedRun?.replyRowIds ?? []), ...(saved.ok ? saved.replyRowIds : [])])],
            stepsUsed: saved.ok ? saved.stepsUsed : (stream.pausedRun?.stepsUsed ?? 0),
            ...(stream.pausedRun?.skill && { skill: stream.pausedRun.skill }),
            ...(stream.pausedRun?.timeZone && { timeZone: stream.pausedRun.timeZone }),
        };

        // The dead step opened an empty placeholder before its call; the resume opens its own, and a failed run keeps no empty bubble.
        if (saved.ok) {
            for (const id of saved.placeholders) {
                const placeholder = await ctx.db.messages.findFirst({ where: { _id: id as Id<"messages">, threadId } });

                if (placeholder && isEmptyPlaceholder(placeholder)) {
                    await removeEmptyPending(ctx, threadId, placeholder);
                }
            }
        }

        if (plan.action === "fail") {
            await recordPausedRunUsage(ctx, { ...stream, pausedRun });
            await patchRow(ctx.db, "persistentStreams", stream, { pausedRun: undefined, toolsInFlight: undefined });

            return { kind: "fail" as const, message: interruptionMessage(plan.reason), threadId: stream.threadId };
        }

        const from = saved.ok ? (saved.from ?? stream.messageId) : stream.messageId;

        if (await isSuperseded(ctx, stream, from)) {
            await endPausedRun(ctx, { ...stream, pausedRun });

            return { kind: "gone" as const };
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
            toolsInFlight: undefined,
        });
        await enqueueRunResume(resume, 0);

        return { kind: "resumed" as const };
    });
