/**
 * Sub-agent runs — admission, the state machine and the public view.
 *
 * `delegateToSubAgent` (`chat/tools/delegate-to-sub-agent.ts`) hands a task to
 * a headless agent run in a NEW thread, linked to the delegating one by a
 * `threadRelationships` row (`branchType: "subagent"`). The tool returns at
 * once; the run happens on the jobs queue (`execute.ts`) and its answer is
 * posted back to the parent thread as a follow-up assistant message, as a
 * coding agent's is.
 *
 * A run is `queued` → `running` → `succeeded` | `failed`. Only `claimRun`
 * starts one and only {@link finishRun} ends one, each checking the current
 * status first — so a redelivered job, or a late finish racing the reaper, is a
 * no-op rather than a second run or a second post.
 *
 * Admission, in one transaction: an account that may run background work (not
 * anonymous, not being deleted), the parent thread owned by the caller, the
 * depth and fan-out caps (`logic.ts`), the `subAgents/run` rate limit, and one
 * charge to the task quotas (`tasks/account.ts:chargeRound`). Everything
 * enqueued lands on the calling shard — the thread owner's.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { resolveLeafRow } from "../agent/branch-rows";
import { addMessagesHandler, getMaxMessage } from "../agent/messages";
import { insertThreadRelationship } from "../agent/table-writes";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authQuery } from "../lib/crpc";
import { enqueueJob } from "../lib/job-queue";
import { patchById } from "../lib/patch";
import { createRatelimit } from "../lib/rate-limiter";
import { notifyQuietly } from "../notifications/notify";
import { chargeRound, DAILY_LIMIT_MESSAGE, loadTaskAccount } from "../tasks/account";
import {
    buildResultMessage,
    isActiveSubAgentStatus,
    normalizeToolAllowlist,
    postRetryDelayMs,
    SUB_AGENT_NAME,
    SUB_AGENT_POST_MAX_ATTEMPTS,
    SUB_AGENT_SKILL_SLUG_MAX,
    SUB_AGENT_STALE_MS,
    SUB_AGENT_TASK_MAX,
    subAgentCapProblem,
    truncateResult,
} from "./logic";
import { vSubAgentRunStatus } from "./validators";

type RunDoc = Doc<"subAgentRuns">;

export interface CreateSubAgentRunArgs {
    parentModel?: string;
    parentThreadId: string;
    skillSlug?: string;
    task: string;
    toolAllowlist?: string[];
    toolCallId?: string;
    userId: string;
}

/** The depth of `threadId`: 0 for a user's own thread, the run's depth for a sub-agent's thread. */
const threadDepth = async (ctx: Pick<MutationCtx, "db">, threadId: string): Promise<number> => {
    const run = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_childThreadId", (q) => q.eq("childThreadId", threadId))
        .first();

    return run?.depth ?? 0;
};

/** Enough rows to see the cap is reached; never the whole history. */
const SUB_AGENT_MAX_SCAN = 10;

const countChildren = async (
    ctx: Pick<MutationCtx, "db">,
    parentThreadId: string,
    statuses: ReadonlyArray<"failed" | "queued" | "running" | "succeeded">,
): Promise<number> => {
    let count = 0;

    for (const status of statuses) {
        const rows = await ctx.db
            .query("subAgentRuns")
            .withIndex("by_parentThreadId_and_status", (q) => q.eq("parentThreadId", parentThreadId).eq("status", status))
            .take(SUB_AGENT_MAX_SCAN);

        count += rows.length;
    }

    return count;
};

/**
 * Every admission check, charging the rate limit and quotas last; returns the
 * row to insert. A refusal is `{ error }` — for the model to read — rather than
 * a throw, so what a refused start consumed stays consumed, as in chat.
 */
export const admitSubAgentRun = async (
    ctx: MutationCtx,
    args: CreateSubAgentRunArgs,
): Promise<{ error: string } | { row: Omit<RunDoc, "_creationTime" | "_id"> }> => {
    const task = args.task.trim();

    if (task.length === 0 || task.length > SUB_AGENT_TASK_MAX) {
        return { error: `The task must be between 1 and ${String(SUB_AGENT_TASK_MAX)} characters` };
    }

    const skillSlug = args.skillSlug?.trim() || undefined;

    if (skillSlug !== undefined && skillSlug.length > SUB_AGENT_SKILL_SLUG_MAX) {
        return { error: "Invalid skill" };
    }

    const allowlist = normalizeToolAllowlist(args.toolAllowlist);

    if ("error" in allowlist) {
        return allowlist;
    }

    const account = await loadTaskAccount(ctx, args.userId);

    if (!account) {
        return { error: "Your account no longer exists." };
    }

    if (account.isAnonymous) {
        return { error: "Sub-agents need an account. Sign up to delegate work to them." };
    }

    if (await isAccountDeletionUnderway(ctx, args.userId)) {
        return { error: "This account is being deleted." };
    }

    // The child runs with the caller's tools and keys in a thread of theirs, so
    // only the parent thread's owner may delegate from it — not a collaborator.
    const parent = await ctx.db.get(args.parentThreadId as Id<"threads">);

    if (!parent || parent.deleted || parent.userId !== args.userId) {
        return { error: "Only the owner of this conversation can delegate to sub-agents." };
    }

    const depth = (await threadDepth(ctx, parent._id)) + 1;
    // A sub-agent's thread is its one run, so every child ever started from it counts.
    const capProblem = subAgentCapProblem({
        activeChildren: await countChildren(ctx, parent._id, ["queued", "running"]),
        parentDepth: depth - 1,
        ...(depth > 1 && { totalChildren: await countChildren(ctx, parent._id, ["queued", "running", "succeeded", "failed"]) }),
    });

    if (capProblem) {
        return { error: capProblem };
    }

    const { ok } = await createRatelimit(`subAgents/run:${account.tier}`, ctx.db as never).limit(args.userId);

    if (!ok) {
        return { error: "You have started too many sub-agents recently. Try again later." };
    }

    if (!(await chargeRound(ctx, args.userId, account))) {
        return { error: DAILY_LIMIT_MESSAGE };
    }

    const now = Date.now();

    return {
        row: {
            createdAt: now,
            depth,
            organizationId: parent.organizationId,
            parentModel: args.parentModel,
            parentThreadId: parent._id,
            skillSlug,
            status: "queued",
            task,
            toolAllowlist: allowlist.tools,
            toolCallId: args.toolCallId,
            updatedAt: now,
            userId: args.userId,
        },
    };
};

export const createRun = internalMutation
    .input({
        parentModel: v.optional(v.string()),
        parentThreadId: v.string(),
        skillSlug: v.optional(v.string()),
        task: v.string(),
        toolAllowlist: v.optional(v.array(v.string())),
        toolCallId: v.optional(v.string()),
        userId: v.string(),
    })
    .output(v.union(v.object({ runId: v.id("subAgentRuns") }), v.object({ error: v.string() })))
    .mutation(async ({ args, ctx }) => {
        const admitted = await admitSubAgentRun(ctx, args);

        if ("error" in admitted) {
            return admitted;
        }

        const runId = await ctx.db.insert("subAgentRuns", admitted.row);

        // Jobs queue (`lib/job-queue.ts`) on this shard — the parent thread
        // owner's; a redelivery is refused by `claimRun`. The reaper is on the
        // scheduler, in the same transaction, so a created run always has both.
        await enqueueJob(internal.sub_agents.execute.runSubAgent, { runId });
        await ctx.scheduler.runAfter(SUB_AGENT_STALE_MS, internal.sub_agents.functions.reapRun, { runId });

        return { runId };
    });

/**
 * `queued` → `running`, once: a redelivered job finds the run no longer queued
 * and gets `null`. Returns the run as it was claimed.
 */
export const claimQueuedRun = async (ctx: MutationCtx, runId: Id<"subAgentRuns">): Promise<RunDoc | null> => {
    const run = await ctx.db.get(runId);

    if (!run || run.status !== "queued") {
        return null;
    }

    const now = Date.now();

    await patchById(ctx.db, run._id, { startedAt: now, status: "running", updatedAt: now });

    return run;
};

/** `queued` → `running`; `null` when the run is gone or already claimed. */
export const claimRun = internalMutation
    .input({ runId: v.id("subAgentRuns") })
    .output(
        v.union(
            v.object({
                depth: v.number(),
                organizationId: v.optional(v.string()),
                parentModel: v.optional(v.string()),
                parentThreadId: v.string(),
                skillSlug: v.optional(v.string()),
                task: v.string(),
                toolAllowlist: v.optional(v.array(v.string())),
                userId: v.string(),
            }),
            v.null(),
        ),
    )
    .mutation(async ({ args, ctx }) => {
        const run = await claimQueuedRun(ctx, args.runId);

        if (!run) {
            return null;
        }

        return {
            depth: run.depth,
            ...(run.organizationId !== undefined && { organizationId: run.organizationId }),
            ...(run.parentModel !== undefined && { parentModel: run.parentModel }),
            parentThreadId: run.parentThreadId,
            ...(run.skillSlug !== undefined && { skillSlug: run.skillSlug }),
            task: run.task,
            ...(run.toolAllowlist !== undefined && { toolAllowlist: run.toolAllowlist }),
            userId: run.userId,
        };
    });

/** See {@link attachChildThread}. Returns whether this call linked it. */
export const linkChildThread = async (ctx: MutationCtx, runId: Id<"subAgentRuns">, childThreadId: string): Promise<boolean> => {
    const run = await ctx.db.get(runId);

    if (!run || run.childThreadId !== undefined || !isActiveSubAgentStatus(run.status)) {
        return false;
    }

    const now = Date.now();

    await patchById(ctx.db, run._id, { childThreadId, updatedAt: now });
    await insertThreadRelationship(ctx.db, {
        branchPoint: 0,
        branchType: "subagent",
        createdAt: now,
        parentThreadId: run.parentThreadId as Id<"threads">,
        threadId: childThreadId as Id<"threads">,
        userId: run.userId,
    });

    return true;
};

/**
 * Records the child thread the run created and links it under the parent, so
 * the "open thread" link works while the run is still going. Once per run.
 */
export const attachChildThread = internalMutation
    .input({ childThreadId: v.string(), runId: v.id("subAgentRuns") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await linkChildThread(ctx, args.runId, args.childThreadId);

        return null;
    });

/**
 * The result as a follow-up assistant message in the parent thread, under the
 * sub-agent's name, as a new turn on the thread's active branch. Skipped when
 * the thread is gone or no longer the run's owner's.
 */
const postToParent = async (ctx: MutationCtx, run: RunDoc, text: string): Promise<void> => {
    const thread = await ctx.db.get(run.parentThreadId as Id<"threads">);

    if (!thread || thread.deleted || thread.userId !== run.userId) {
        return;
    }

    const last = await getMaxMessage(ctx, thread._id);
    // A branched thread: hang the reply off the leaf the user is looking at.
    const leaf = thread.activeLeafMessageId ? await resolveLeafRow(ctx, thread._id, thread.activeLeafMessageId) : null;

    await addMessagesHandler(ctx, {
        agentName: SUB_AGENT_NAME,
        messages: [{ message: { content: text, role: "assistant" }, status: "success" }],
        overrideOrder: (last?.order ?? -1) + 1,
        ...(leaf && { parentMessageId: leaf._id }),
        threadId: thread._id,
        userId: run.userId,
    });

    await patchById(ctx.db, thread._id, { updatedAt: Date.now() });
};

export type SubAgentOutcome = { error: string; kind: "failed" } | { kind: "succeeded"; result: string };

/** Streams of one thread checked for activity — its latest few, never its history. */
const RECENT_STREAMS_CHECKED = 5;

/** Whether the parent thread has a run still writing to it (`persistentStreams`, pending or streaming). */
const isThreadStreaming = async (ctx: Pick<MutationCtx, "db">, threadId: string): Promise<boolean> => {
    const streams = await ctx.db
        .query("persistentStreams")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .order("desc")
        .take(RECENT_STREAMS_CHECKED);

    return streams.some((stream) => stream.status === "pending" || stream.status === "streaming");
};

/**
 * Posts an ended run's result to the parent thread, once. While the parent
 * is still streaming — typically the very run whose `delegateToSubAgent` call
 * started this one — the post is rescheduled, so it lands after that reply
 * rather than between its steps; past {@link SUB_AGENT_POST_MAX_ATTEMPTS} it
 * posts anyway. Returns whether this call posted.
 */
export const postRunResult = async (ctx: MutationCtx, runId: Id<"subAgentRuns">, attempt: number): Promise<boolean> => {
    const run = await ctx.db.get(runId);

    if (!run || isActiveSubAgentStatus(run.status) || run.resultPostedAt !== undefined) {
        return false;
    }

    if (attempt < SUB_AGENT_POST_MAX_ATTEMPTS && (await isThreadStreaming(ctx, run.parentThreadId))) {
        await ctx.scheduler.runAfter(postRetryDelayMs(attempt), internal.sub_agents.functions.postResult, { attempt: attempt + 1, runId });

        return false;
    }

    await patchById(ctx.db, run._id, { resultPostedAt: Date.now() });
    await postToParent(
        ctx,
        run,
        buildResultMessage({
            childThreadId: run.childThreadId,
            error: run.error,
            result: run.result,
            status: run.status as "failed" | "succeeded",
            task: run.task,
        }),
    );

    return true;
};

/**
 * Ends an active run and posts its result — once: a run already ended (a
 * redelivered finish, the reaper after a late success) is left alone. Ending
 * frees the run's fan-out slot at once; the post may wait for the parent's
 * stream ({@link postRunResult}). Returns whether this call ended it.
 */
export const finishRun = async (ctx: MutationCtx, runId: Id<"subAgentRuns">, outcome: SubAgentOutcome): Promise<boolean> => {
    const run = await ctx.db.get(runId);

    if (!run || !isActiveSubAgentStatus(run.status)) {
        return false;
    }

    const now = Date.now();
    const result = outcome.kind === "succeeded" ? truncateResult(outcome.result) : undefined;
    const error = outcome.kind === "failed" ? outcome.error.slice(0, 1000) : undefined;

    await patchById(ctx.db, run._id, { completedAt: now, error, result, status: outcome.kind, updatedAt: now });
    await postRunResult(ctx, run._id, 0);
    await notifyQuietly(ctx, {
        dedupeKey: `sub_agent:${run._id}`,
        link: `/chat/${run.parentThreadId}`,
        outcome: outcome.kind === "succeeded" ? "success" : "failure",
        title: run.task.split("\n", 1)[0]!.slice(0, 200),
        type: "sub_agent",
        userId: run.userId,
        ...(error && { body: error }),
    });

    return true;
};

/** A deferred {@link postRunResult}, rescheduled while the parent thread streams. */
export const postResult = internalMutation
    .input({ attempt: v.number(), runId: v.id("subAgentRuns") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await postRunResult(ctx, args.runId, args.attempt);

        return null;
    });

export const completeRun = internalMutation
    .input({
        outcome: v.union(v.object({ error: v.string(), kind: v.literal("failed") }), v.object({ kind: v.literal("succeeded"), result: v.string() })),
        runId: v.id("subAgentRuns"),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await finishRun(ctx, args.runId, args.outcome));

/** Scheduled at admission: fails a run that never reported, which also frees its fan-out slot. */
export const reapRun = internalMutation
    .input({ runId: v.id("subAgentRuns") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await finishRun(ctx, args.runId, { error: "The sub-agent did not finish in time.", kind: "failed" });

        return null;
    });

// ─── Public ──────────────────────────────────────────────────────────────────

const vRunView = v.object({
    _id: v.id("subAgentRuns"),
    childThreadId: v.union(v.string(), v.null()),
    completedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    depth: v.number(),
    error: v.union(v.string(), v.null()),
    result: v.union(v.string(), v.null()),
    status: vSubAgentRunStatus,
    task: v.string(),
});

/** The run a `delegateToSubAgent` call started — the tool part knows only its call id. The caller's own runs only. */
export const getRunByToolCall = authQuery
    .input({ toolCallId: v.string().check((value) => value.length > 0 && value.length <= 256, { message: "Invalid tool call id" }) })
    .output(v.union(vRunView, v.null()))
    .query(async ({ args, ctx }) => {
        const run = await ctx.db
            .query("subAgentRuns")
            .withIndex("by_user_and_toolCallId", (q) => q.eq("userId", ctx.user.userId).eq("toolCallId", args.toolCallId))
            .first();

        if (!run) {
            return null;
        }

        return {
            _id: run._id,
            childThreadId: run.childThreadId ?? null,
            completedAt: run.completedAt ?? null,
            createdAt: run.createdAt,
            depth: run.depth,
            error: run.error ?? null,
            result: run.result ?? null,
            status: run.status,
            task: run.task,
        };
    });
