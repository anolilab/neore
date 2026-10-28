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
 * A run is `queued` → `running` → `succeeded` | `failed` | `cancelled`. Only
 * `claimRun` starts one and only {@link finishRun} ends one, each checking the current
 * status first — so a redelivered job, or a late finish racing the reaper, is a
 * no-op rather than a second run or a second post.
 *
 * A WORKER (`mode: "worker"`) is a sub-agent thread that outlives one run: its first run creates the
 * child thread, and every later dispatch — the lead's `messageWorker` tool call or the user typing in
 * the thread (`dispatchToWorker`) — is one more run row on the same thread. Admission charges nothing
 * for a worker run; the claim does, once, when the run leaves `queued`. A dispatch is deduped by a
 * `worker-dispatch` claim taken before the rate limit, so a redelivery returns the first run's receipt.
 *
 * Admission, in one transaction: an account that may run background work (not
 * anonymous, not being deleted), the parent thread owned by the caller, the
 * depth and fan-out caps (`logic.ts`), the `subAgents/run` rate limit, and one
 * charge to the task quotas (`tasks/account.ts:chargeRound`). Everything
 * enqueued lands on the calling shard — the thread owner's.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_LOOKUP } from "@neore/ai/models";
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { resolveLeafRow } from "../agent/branch-rows";
import { addMessagesHandler, getMaxMessage } from "../agent/messages";
import { insertThread, insertThreadRelationship, patchThread } from "../agent/table-writes";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { claimOnce, releaseClaim, WORKER_DISPATCH_CLAIM_TTL_MS, WORKER_DISPATCH_SCOPE } from "../lib/claim-once";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { enqueueJob } from "../lib/job-queue";
import { patchById } from "../lib/patch";
import { createRatelimit } from "../lib/rate-limiter";
import { notifyQuietly } from "../notifications/notify";
import { chargeRound, DAILY_LIMIT_MESSAGE, loadTaskAccount } from "../tasks/account";
import { isTaskModelAllowed } from "../tasks/logic";
import { threadGateOutcome, throwUnlessGranted } from "../chat/lib/thread-gate";
import { MAX_LENGTH } from "../lib/validators";
import { isThreadLocked, LOCKED_THREAD_TITLE } from "../lib/thread-lock";
import {
    buildResultMessage,
    distinctChildCount,
    intersectWithLeadTools,
    isActiveSubAgentStatus,
    isWorkerLoopLive,
    nextQueuedWorkerRun,
    normalizeToolAllowlist,
    postRetryDelayMs,
    postsBack,
    resolveSubAgentModel,
    SUB_AGENT_NAME,
    SUB_AGENT_POST_FAILURE_MAX_ATTEMPTS,
    SUB_AGENT_POST_MAX_ATTEMPTS,
    SUB_AGENT_MAX_TOOLS,
    SUB_AGENT_SKILL_SLUG_MAX,
    SUB_AGENT_STALE_MS,
    SUB_AGENT_TASK_MAX,
    subAgentCapProblem,
    truncateResult,
    WORKER_CLIENT_ID_MAX,
    WORKER_NAME_MAX,
    workerCurrentRun,
    workerPostFailure,
    workerFollowUp,
} from "./logic";
import { vSubAgentRunMode, vSubAgentRunStatus } from "./validators";

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
    statuses: ReadonlyArray<"cancelled" | "failed" | "queued" | "running" | "succeeded">,
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

interface CommonAdmission {
    account: NonNullable<Awaited<ReturnType<typeof loadTaskAccount>>>;
    allowlist: string[] | undefined;
    parent: Doc<"threads">;
    skillSlug: string | undefined;
    task: string;
}

/**
 * The checks every run shares, in order: the task, the skill, the allowlist, an account that may
 * run background work (not anonymous, not being deleted) and a parent thread its caller owns.
 */
const admitCommon = async (
    ctx: MutationCtx,
    args: Pick<CreateSubAgentRunArgs, "parentThreadId" | "skillSlug" | "task" | "toolAllowlist" | "userId">,
): Promise<CommonAdmission | { error: string }> => {
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

    return { account, allowlist: allowlist.tools, parent, skillSlug, task };
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
    const common = await admitCommon(ctx, args);

    if ("error" in common) {
        return common;
    }

    const { account, allowlist, parent, skillSlug, task } = common;
    const depth = (await threadDepth(ctx, parent._id)) + 1;
    // Every child ever started from the lead counts, a worker once however many runs it had.
    const capProblem = subAgentCapProblem({
        activeChildren: await countChildren(ctx, parent._id, ["queued", "running"]),
        parentDepth: depth - 1,
        ...(depth > 1 && { totalChildren: await lifetimeChildren(ctx, parent._id) }),
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
            toolAllowlist: allowlist,
            toolCallId: args.toolCallId,
            updatedAt: now,
            userId: args.userId,
        },
    };
};

// ─── Workers ─────────────────────────────────────────────────────────────────

/** Why a worker dispatch was refused; `kind` picks the error a person-facing procedure throws. */
export interface WorkerRefusal {
    error: string;
    kind: "archived" | "limit" | "not_found" | "other";
}

export interface WorkerRunArgs extends CreateSubAgentRunArgs {
    /** The worker's child thread; unset creates a worker. */
    childThreadId?: string;
    /** A user-typed dispatch's dedupe key; a lead's dispatch carries `toolCallId` instead. */
    clientId?: string;
    /** The lead run's effective tool names; unset when a person creates the worker. */
    leadTools?: string[];
    /** A new worker's model. */
    model?: string;
    /** A new worker's name, which is its thread title. */
    name?: string;
}

export interface WorkerReceipt {
    runId: Id<"subAgentRuns">;
    state: RunDoc["status"];
    workerId: string;
}

/** Runs of one worker read to find its latest or active one; a worker has one active run at a time. */
const WORKER_RUNS_CHECKED = 20;

/** A worker's first run: it holds the lead, the depth, the runner and the tool allowlist every later run copies. */
const workerOrigin = async (ctx: Pick<MutationCtx | QueryCtx, "db">, childThreadId: string): Promise<RunDoc | null> => {
    const origin = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_childThreadId", (q) => q.eq("childThreadId", childThreadId))
        .first();

    return origin?.mode === "worker" ? origin : null;
};

/** Pages of cancelled runs `latestWorkerRuns` reads looking for a stopped loop that may still be unwinding. */
const CANCELLED_PAGES_CHECKED = 4;

/**
 * The worker's newest runs, newest first by `createdAt`, plus the queued and running ones, and the cancelled
 * ones down to the newest that started (a stopped loop may still be unwinding), however old: a burst of newer cancelled messages
 * must not push a live run out of view, or a second one would start beside it. Admission keeps `createdAt` strictly increasing per worker, so the order is the order
 * the messages were sent even when `_creationTime` ties.
 */
const latestWorkerRuns = async (ctx: Pick<MutationCtx | QueryCtx, "db">, childThreadId: string): Promise<RunDoc[]> => {
    const recent = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_childThreadId", (q) => q.eq("childThreadId", childThreadId))
        .order("desc")
        .take(WORKER_RUNS_CHECKED);
    const seen = new Set<string>(recent.map((run) => run._id));
    const older: RunDoc[] = [];

    for (const status of ["running", "queued"] as const) {
        const live = await ctx.db
            .query("subAgentRuns")
            .withIndex("by_childThreadId_and_status", (q) => q.eq("childThreadId", childThreadId).eq("status", status))
            .order("desc")
            .take(WORKER_RUNS_CHECKED);

        older.push(...live.filter((run) => !seen.has(run._id)));
    }

    // Only the newest cancelled run that started can still have a loop unwinding (nothing starts beside a live
    // loop), but runs cancelled while queued never started and can sit above it in any number. The scan stops after
    // a few pages so a long history is not re-read on every lookup; a loop past them is still released by the reaper.
    let cursor: string | null = null;

    for (let done = false, pages = 0; !done && pages < CANCELLED_PAGES_CHECKED; pages += 1) {
        const page = await ctx.db
            .query("subAgentRuns")
            .withIndex("by_childThreadId_and_status", (q) => q.eq("childThreadId", childThreadId).eq("status", "cancelled"))
            .order("desc")
            .paginate({ cursor, numItems: WORKER_RUNS_CHECKED });

        older.push(...page.page.filter((run) => !seen.has(run._id)));
        cursor = page.continueCursor;
        done = page.isDone || page.page.some((run) => run.startedAt !== undefined);
    }

    return [...recent, ...older].toSorted((a, b) => b.createdAt - a.createdAt);
};

/**
 * Puts a queued run on the jobs queue and schedules its reaper, in the caller's transaction. A
 * worker run waiting behind another gets neither until its turn, so the reaper's clock does not
 * run down while it waits in line.
 */
const startQueuedRun = async (ctx: Pick<MutationCtx, "scheduler">, runId: Id<"subAgentRuns">): Promise<void> => {
    await enqueueJob(internal.sub_agents.execute.runSubAgent, { runId });
    await ctx.scheduler.runAfter(SUB_AGENT_STALE_MS, internal.sub_agents.functions.reapRun, { runId });
};

/** Whether `threadId` is a worker's thread — a turn there runs only through a dispatch. */
export const isWorkerThread = async (ctx: Pick<QueryCtx, "db">, threadId: string): Promise<boolean> => {
    const first = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_childThreadId", (q) => q.eq("childThreadId", threadId))
        .first();

    return first?.mode === "worker";
};

/** Lifetime runs of a lead read to count its distinct children; the depth cap keeps real counts tiny. */
const SUB_AGENT_LIFETIME_SCAN = 200;

const lifetimeChildren = async (ctx: Pick<MutationCtx, "db">, parentThreadId: string): Promise<number> => {
    const runs: RunDoc[] = [];

    for (const status of ["queued", "running", "succeeded", "failed", "cancelled"] as const) {
        runs.push(
            ...(await ctx.db
                .query("subAgentRuns")
                .withIndex("by_parentThreadId_and_status", (q) => q.eq("parentThreadId", parentThreadId).eq("status", status))
                .take(SUB_AGENT_LIFETIME_SCAN)),
        );
    }

    return distinctChildCount(runs);
};

/** The run an earlier delivery of this dispatch inserted, if any. */
const findDispatchedRun = async (ctx: Pick<MutationCtx, "db">, args: WorkerRunArgs): Promise<RunDoc | null> => {
    if (args.toolCallId !== undefined) {
        return await ctx.db
            .query("subAgentRuns")
            .withIndex("by_user_and_toolCallId", (q) => q.eq("userId", args.userId).eq("toolCallId", args.toolCallId))
            .first();
    }

    if (args.childThreadId !== undefined) {
        const recent = await latestWorkerRuns(ctx, args.childThreadId);

        return recent.find((run) => run.clientId === args.clientId) ?? null;
    }

    // A worker being created has no thread yet: its first run is among the lead's.
    for (const status of ["queued", "running", "succeeded", "failed", "cancelled"] as const) {
        const runs = await ctx.db
            .query("subAgentRuns")
            .withIndex("by_parentThreadId_and_status", (q) => q.eq("parentThreadId", args.parentThreadId).eq("status", status))
            .order("desc")
            .take(SUB_AGENT_LIFETIME_SCAN);
        const found = runs.find((run) => run.clientId === args.clientId && run.userId === args.userId);

        if (found) {
            return found;
        }
    }

    return null;
};

/**
 * Admits and inserts one worker run, creating the worker's child thread when `childThreadId` is
 * unset. The dispatch is claimed first (`worker-dispatch`), before the rate limit and the insert: a
 * redelivery finds its claim taken and gets the first run back with `created: false`, consuming
 * nothing. A refusal after the claim gives it back, so a retry of the same key is not read as a
 * replay. Charges nothing: a worker run is charged when it is claimed (`claimQueuedRun`).
 *
 * Tools: a new worker's are the requested names the lead could call itself (`leadTools`), or all of
 * the lead's when none are named; a later run copies the worker's first. Depth, runner and lead are
 * the first run's too.
 */
export const admitWorkerRun = async (ctx: MutationCtx, args: WorkerRunArgs): Promise<WorkerRefusal | { created: boolean; idle: boolean; run: RunDoc }> => {
    const other = (error: string): WorkerRefusal => {
        return { error, kind: "other" };
    };
    const dispatchId = args.toolCallId ?? args.clientId;

    if (dispatchId === undefined || dispatchId.length === 0 || dispatchId.length > WORKER_CLIENT_ID_MAX) {
        return other("A dispatch needs an id.");
    }

    const common = await admitCommon(ctx, args);

    if ("error" in common) {
        return other(common.error);
    }

    const { account, parent, skillSlug, task } = common;
    let origin: RunDoc | null = null;
    let child: Doc<"threads"> | null = null;

    if (args.childThreadId !== undefined) {
        child = await ctx.db.get(args.childThreadId as Id<"threads">);
        origin = await workerOrigin(ctx, args.childThreadId);

        if (!child || child.deleted || child.userId !== args.userId || !origin || origin.parentThreadId !== parent._id) {
            return { error: "Worker not found.", kind: "not_found" };
        }
    }

    const claimKey = args.toolCallId === undefined ? `client:${args.childThreadId ?? args.parentThreadId}:${dispatchId}` : `tool:${args.userId}:${dispatchId}`;

    if (!(await claimOnce(ctx, WORKER_DISPATCH_SCOPE, claimKey, WORKER_DISPATCH_CLAIM_TTL_MS, args.userId))) {
        const dispatched = await findDispatchedRun(ctx, args);

        return dispatched ? { created: false, idle: false, run: dispatched } : other("This dispatch was already handled.");
    }

    const refuse = async (refusal: WorkerRefusal): Promise<WorkerRefusal> => {
        await releaseClaim(ctx, WORKER_DISPATCH_SCOPE, claimKey);

        return refusal;
    };

    // Whether the worker has no run going or waiting, so this one starts at once.
    let idle = true;
    // The newest run's `createdAt`: a message sent in the same millisecond still queues behind it.
    let newestRunAt = 0;

    if (child && origin) {
        if (child.status === "archived") {
            return await refuse({ error: "This worker is archived. Restore it to message it again.", kind: "archived" });
        }

        if (isThreadLocked(child)) {
            return await refuse(other("This worker is locked."));
        }

        const recent = await latestWorkerRuns(ctx, child._id);

        idle = recent.every((run) => !isActiveSubAgentStatus(run.status) && !isWorkerLoopLive(run));
        newestRunAt = recent[0]?.createdAt ?? 0;
    }

    let allowlist = origin?.toolAllowlist;

    if (!origin) {
        const tools = intersectWithLeadTools(common.allowlist, args.leadTools);

        if ("error" in tools) {
            return await refuse(other(tools.error));
        }

        allowlist = tools.tools;
    }

    const depth = origin?.depth ?? (await threadDepth(ctx, parent._id)) + 1;
    // A message to an existing worker starts no new child, so only a new worker meets the lifetime cap.
    const capProblem = subAgentCapProblem({
        activeChildren: await countChildren(ctx, parent._id, ["queued", "running"]),
        parentDepth: depth - 1,
        ...(depth > 1 && !origin && { totalChildren: await lifetimeChildren(ctx, parent._id) }),
    });

    if (capProblem) {
        return await refuse(other(capProblem));
    }

    const { ok } = await createRatelimit(`subAgents/run:${account.tier}`, ctx.db as never).limit(args.userId);

    if (!ok) {
        return await refuse({ error: "You have started too many sub-agents recently. Try again later.", kind: "limit" });
    }

    const now = Date.now();
    let childThreadId = child?._id;

    if (!childThreadId) {
        const name = (args.name?.trim() || task.split("\n", 1)[0]!).slice(0, WORKER_NAME_MAX);
        const model = resolveSubAgentModel({
            defaultModel: DEFAULT_CHAT_MODEL,
            isAllowed: (id) => isTaskModelAllowed(id, (lookupId) => MODEL_LOOKUP.get(lookupId)),
            parentModel: args.parentModel,
            preferredModel: args.model,
        });

        childThreadId = await insertThread(ctx.db, {
            createdAt: now,
            model,
            organizationId: parent.organizationId,
            status: "active",
            tags: ["sub-agent", "worker"],
            title: name,
            updatedAt: now,
            userId: args.userId,
        });
        await insertThreadRelationship(ctx.db, {
            branchPoint: 0,
            branchType: "subagent",
            createdAt: now,
            parentThreadId: parent._id,
            threadId: childThreadId,
            userId: args.userId,
        });
    }

    const row: Omit<RunDoc, "_creationTime" | "_id"> = {
        childThreadId,
        clientId: args.toolCallId === undefined ? args.clientId : undefined,
        createdAt: Math.max(now, newestRunAt + 1),
        depth,
        mode: "worker",
        organizationId: parent.organizationId,
        parentModel: args.parentModel,
        parentThreadId: parent._id,
        runner: origin?.runner ?? { kind: "headless" },
        skillSlug: origin?.skillSlug ?? skillSlug,
        status: "queued",
        task,
        toolAllowlist: allowlist,
        toolCallId: args.toolCallId,
        updatedAt: now,
        userId: args.userId,
    };

    const runId = await ctx.db.insert("subAgentRuns", row);

    return { created: true, idle, run: { ...row, _creationTime: now, _id: runId } };
};

/**
 * Admits a worker run. One that finds the worker idle is enqueued with its reaper; one that finds a
 * run going or waiting stays `queued` and is started by {@link finishRun} when its turn comes. It
 * still counts toward the lead's concurrent cap, so queueing never widens it.
 */
export const dispatchWorkerRun = async (ctx: MutationCtx, args: WorkerRunArgs): Promise<WorkerRefusal | WorkerReceipt> => {
    const admitted = await admitWorkerRun(ctx, args);

    if ("error" in admitted) {
        return admitted;
    }

    if (admitted.created && admitted.idle) {
        await startQueuedRun(ctx, admitted.run._id);
    }

    return { runId: admitted.run._id, state: admitted.run.status, workerId: admitted.run.childThreadId! };
};

export const createRun = internalMutation
    .input({
        // Bounded at the boundary; the name is cut to its display length further down, and a tool name has its own pattern.
        leadTools: v.optional(v.array(v.string().max(128))),
        model: v.optional(v.string().max(256)),
        name: v.optional(v.string().max(1000)),
        parentModel: v.optional(v.string()),
        parentThreadId: v.string(),
        // A worker: the thread outlives this run and is messaged again with `messageWorker`.
        persistent: v.optional(v.boolean()),
        skillSlug: v.optional(v.string()),
        task: v.string(),
        toolAllowlist: v.optional(v.array(v.string())),
        toolCallId: v.optional(v.string()),
        userId: v.string(),
    })
    .output(v.union(v.object({ runId: v.id("subAgentRuns"), workerId: v.optional(v.string()) }), v.object({ error: v.string() })))
    .mutation(async ({ args: { persistent, ...args }, ctx }) => {
        if (persistent) {
            const dispatched = await dispatchWorkerRun(ctx, args);

            return "error" in dispatched ? { error: dispatched.error } : { runId: dispatched.runId, workerId: dispatched.workerId };
        }

        const admitted = await admitSubAgentRun(ctx, args);

        if ("error" in admitted) {
            return admitted;
        }

        const runId = await ctx.db.insert("subAgentRuns", admitted.row);

        // Jobs queue (`lib/job-queue.ts`) on this shard — the parent thread
        // owner's; a redelivery is refused by `claimRun`.
        await startQueuedRun(ctx, runId);

        return { runId };
    });

/**
 * A lead's message to one of its workers (the `messageWorker` tool). The tool call id dedupes it.
 */
export const messageWorker = internalMutation
    .input({ message: v.string().max(SUB_AGENT_TASK_MAX), parentThreadId: v.string(), toolCallId: v.string(), userId: v.string(), workerId: v.string() })
    .output(v.union(v.object({ runId: v.id("subAgentRuns"), state: vSubAgentRunStatus, workerId: v.string() }), v.object({ error: v.string() })))
    .mutation(async ({ args, ctx }) => {
        const dispatched = await dispatchWorkerRun(ctx, {
            childThreadId: args.workerId,
            parentThreadId: args.parentThreadId,
            task: args.message,
            toolCallId: args.toolCallId,
            userId: args.userId,
        });

        return "error" in dispatched ? { error: dispatched.error } : dispatched;
    });

/**
 * `queued` → `running`, once: a redelivered job finds the run no longer queued
 * and gets `null`. Returns the run as it was claimed.
 *
 * A worker run is charged here, once, as it leaves `queued` — so a run cancelled while queued costs
 * nothing, and a redelivery (which gets `null` above) cannot charge twice. When the daily limit is
 * spent the run ends as failed, and when the worker was archived, deleted or locked meanwhile it ends
 * cancelled; the claim answers `null` for both. A worker runs one message at a time: a run with
 * another running, or an older one waiting, stays queued (`null`, charging nothing) until
 * {@link finishRun} starts it in its turn.
 */
export const claimQueuedRun = async (ctx: MutationCtx, runId: Id<"subAgentRuns">): Promise<RunDoc | null> => {
    const run = await ctx.db.get(runId);

    if (!run || run.status !== "queued") {
        return null;
    }

    // A worker's thread exists already, so the link `linkChildThread` makes for a one-shot run is not made again.
    const worker = run.mode === "worker" && run.childThreadId ? await ctx.db.get(run.childThreadId as Id<"threads">) : null;

    if (run.mode === "worker") {
        // Archived, deleted or locked after this run was queued: it ends cancelled and uncharged, the
        // thread stays as it is, and the rest of the queue drains the same way.
        if (!worker || worker.deleted || worker.status === "archived" || isThreadLocked(worker)) {
            await finishRun(ctx, run._id, { kind: "cancelled" });

            return null;
        }

        if (nextQueuedWorkerRun(await latestWorkerRuns(ctx, worker._id))?._id !== run._id) {
            return null;
        }

        const account = await loadTaskAccount(ctx, run.userId);

        if (!account || !(await chargeRound(ctx, run.userId, account))) {
            await finishRun(ctx, run._id, { error: account ? DAILY_LIMIT_MESSAGE : "Your account no longer exists.", kind: "failed" });

            return null;
        }
    }

    const now = Date.now();

    await patchById(ctx.db, run._id, { startedAt: now, status: "running", updatedAt: now });

    // "running" is what the thread list reads to offer its Stop; `finishRun` puts it back.
    if (worker?.status === "active") {
        await patchThread(ctx.db, worker._id, { status: "running", updatedAt: now });
    }

    return run;
};

/** `queued` → `running`; `null` when the run is gone or already claimed. */
export const claimRun = internalMutation
    .input({ runId: v.id("subAgentRuns") })
    .output(
        v.union(
            v.object({
                childThreadId: v.optional(v.string()),
                clientId: v.optional(v.string()),
                depth: v.number(),
                mode: v.optional(vSubAgentRunMode),
                // The worker's own model, read from its thread: the picker there changes only that worker.
                model: v.optional(v.string()),
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

        const worker = run.mode === "worker" && run.childThreadId ? await ctx.db.get(run.childThreadId as Id<"threads">) : null;

        return {
            ...(run.childThreadId !== undefined && { childThreadId: run.childThreadId }),
            ...(run.clientId !== undefined && { clientId: run.clientId }),
            depth: run.depth,
            ...(run.mode !== undefined && { mode: run.mode }),
            ...(worker?.model !== undefined && { model: worker.model }),
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

    // "running" is what the thread list reads to offer its Stop; `finishRun` puts it back.
    const child = await ctx.db.get(childThreadId as Id<"threads">);

    if (child?.status === "active") {
        await patchThread(ctx.db, child._id, { status: "running", updatedAt: now });
    }

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
 * Returns whether it linked: `false` means the run ended first (stopped), and
 * the caller must not generate into a thread nothing points at.
 */
export const attachChildThread = internalMutation
    .input({ childThreadId: v.string(), runId: v.id("subAgentRuns") })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await linkChildThread(ctx, args.runId, args.childThreadId));

/**
 * The result as a follow-up assistant message in the parent thread, under the
 * sub-agent's name, as a new turn on the thread's active branch. Writes nothing
 * and answers why when the thread is gone, no longer the run's owner's (`retry: false`, it
 * will not come back), or locked (`retry: true`, it may be unlocked); `undefined` means it wrote.
 */
const postToParent = async (ctx: MutationCtx, run: RunDoc, text: string): Promise<{ reason: string; retry: boolean } | undefined> => {
    const thread = await ctx.db.get(run.parentThreadId as Id<"threads">);

    if (!thread || thread.deleted || thread.userId !== run.userId) {
        return { reason: "The conversation that started this run is gone.", retry: false };
    }

    // A locked parent takes no background post: the result stays with the run, unread.
    if (isThreadLocked(thread)) {
        return { reason: "The conversation that started this run is locked.", retry: true };
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

    return undefined;
};

/** Starts the worker's next queued run, if none is going: the head of the line has no job until now. */
const startNextWorkerRun = async (ctx: MutationCtx, childThreadId: string): Promise<void> => {
    const next = nextQueuedWorkerRun(await latestWorkerRuns(ctx, childThreadId));

    if (next) {
        await startQueuedRun(ctx, next._id);
    }
};

/**
 * Moves a worker's line on after a run that was cancelled while running: its loop stops at the next
 * step boundary, and until then it still writes into the thread, so the worker counts as busy (a new
 * message queues) until the loop exits ({@link completeRun}) or, if it died, the reaper fires. A no-op
 * for any other run, and for a stopped one already marked gone.
 */
const resumeLineAfterStoppedRun = async (ctx: MutationCtx, runId: Id<"subAgentRuns">): Promise<void> => {
    const run = await ctx.db.get(runId);

    if (run?.mode === "worker" && isWorkerLoopLive(run) && run.status === "cancelled" && run.childThreadId !== undefined) {
        const now = Date.now();

        await patchById(ctx.db, run._id, { loopExitedAt: now, updatedAt: now });
        await startNextWorkerRun(ctx, run.childThreadId);
    }
};

export type SubAgentOutcome = { error: string; kind: "failed" } | { kind: "cancelled" } | { kind: "succeeded"; result: string };

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
 * Posts an ended run's result to the parent thread, once, if the lead asked for it
 * ({@link postsBack}). While the parent is still streaming — typically the very run
 * whose `delegateToSubAgent` call started this one — the post is rescheduled, so it
 * lands after that reply rather than between its steps; past
 * {@link SUB_AGENT_POST_MAX_ATTEMPTS} it posts anyway.
 *
 * `resultPostedAt` is set only with the message write. A locked parent leaves it unset and
 * the post is retried with backoff; after {@link SUB_AGENT_POST_FAILURE_MAX_ATTEMPTS} tries
 * the run ends in `postFailed`, the terminal state the worker row shows, and a deleted or
 * no-longer-owned parent ends there at once. `failures` counts the tries. Returns whether
 * this call posted.
 */
export const postRunResult = async (ctx: MutationCtx, runId: Id<"subAgentRuns">, attempt: number, failures = 0): Promise<boolean> => {
    const run = await ctx.db.get(runId);

    if (!run || isActiveSubAgentStatus(run.status) || run.resultPostedAt !== undefined || run.postFailed !== undefined || !postsBack(run)) {
        return false;
    }

    if (attempt < SUB_AGENT_POST_MAX_ATTEMPTS && (await isThreadStreaming(ctx, run.parentThreadId))) {
        await ctx.scheduler.runAfter(postRetryDelayMs(attempt), internal.sub_agents.functions.postResult, { attempt: attempt + 1, failures, runId });

        return false;
    }

    const refusal = await postToParent(
        ctx,
        run,
        buildResultMessage({
            childThreadId: run.childThreadId,
            error: run.error,
            result: run.result,
            started: run.startedAt !== undefined,
            status: run.status as "cancelled" | "failed" | "succeeded",
            task: run.task,
        }),
    );

    if (refusal === undefined) {
        await patchById(ctx.db, run._id, { resultPostedAt: Date.now() });

        return true;
    }

    if (!refusal.retry || failures + 1 >= SUB_AGENT_POST_FAILURE_MAX_ATTEMPTS) {
        await patchById(ctx.db, run._id, { postFailed: refusal.reason });
    } else {
        await ctx.scheduler.runAfter(postRetryDelayMs(failures), internal.sub_agents.functions.postResult, { attempt, failures: failures + 1, runId });
    }

    return false;
};

/**
 * Ends an active run and posts its result — once: a run already ended (a
 * redelivered finish, the reaper after a late success) is left alone. Ending
 * frees the run's fan-out slot at once and starts the worker's next queued run;
 * the post may wait for the parent's stream ({@link postRunResult}). Returns
 * whether this call ended it.
 *
 * A cancelled run (the owner stopped it) is not notified: the person who
 * ended it is the one who would read the notification.
 */
export const finishRun = async (ctx: MutationCtx, runId: Id<"subAgentRuns">, outcome: SubAgentOutcome): Promise<boolean> => {
    const run = await ctx.db.get(runId);

    if (!run || !isActiveSubAgentStatus(run.status)) {
        return false;
    }

    // The run the worker's line waits on: the one going, or the head of the queue. Ending one further
    // back changes nothing, the head already has its job. Read before the patch takes it out of the line.
    const wasRunning = run.status === "running";
    const wasHead =
        run.mode === "worker" &&
        run.childThreadId !== undefined &&
        (wasRunning || nextQueuedWorkerRun(await latestWorkerRuns(ctx, run.childThreadId))?._id === run._id);
    const now = Date.now();
    const result = outcome.kind === "succeeded" ? truncateResult(outcome.result) : undefined;
    const error = outcome.kind === "failed" ? outcome.error.slice(0, 1000) : undefined;

    await patchById(ctx.db, run._id, { completedAt: now, error, result, status: outcome.kind, updatedAt: now });

    // The child thread was marked "running" when it was linked (`linkChildThread`). A chat reply
    // the user started there meanwhile holds that status too, so it stays while one is live.
    const child = run.childThreadId ? await ctx.db.get(run.childThreadId as Id<"threads">) : null;

    // Ending a worker's queued run leaves the one going alone: only the run that was going frees the thread.
    if (child?.status === "running" && (run.mode !== "worker" || wasRunning) && !(await isThreadStreaming(ctx, child._id))) {
        await patchThread(ctx.db, child._id, { status: "active", updatedAt: now });
    }

    await postRunResult(ctx, run._id, 0);

    // A stopped running run is still mid-step: its line moves on when its loop exits, not before.
    if (wasHead && !(wasRunning && outcome.kind === "cancelled")) {
        await startNextWorkerRun(ctx, run.childThreadId!);
    }

    if (outcome.kind !== "cancelled") {
        await notifyQuietly(ctx, {
            dedupeKey: `sub_agent:${run._id}`,
            // A run the user typed into a worker's thread reports there; the lead never heard of it.
            link: `/chat/${postsBack(run) ? run.parentThreadId : run.childThreadId}`,
            outcome: outcome.kind === "succeeded" ? "success" : "failure",
            title: run.task.split("\n", 1)[0]!.slice(0, 200),
            type: "sub_agent",
            userId: run.userId,
            ...(error && { body: error }),
        });
    }

    return true;
};

/** A deferred {@link postRunResult}, rescheduled while the parent thread streams. */
export const postResult = internalMutation
    .input({ attempt: v.number(), failures: v.optional(v.number()), runId: v.id("subAgentRuns") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await postRunResult(ctx, args.runId, args.attempt, args.failures);

        return null;
    });

/** The child's loop is over: ends the run, or, when a Stop ended it first, lets the worker's next message go. */
export const finishRunFromLoop = async (
    ctx: MutationCtx,
    runId: Id<"subAgentRuns">,
    outcome: Exclude<SubAgentOutcome, { kind: "cancelled" }>,
): Promise<boolean> => {
    const ended = await finishRun(ctx, runId, outcome);

    if (!ended) {
        await resumeLineAfterStoppedRun(ctx, runId);
    }

    return ended;
};

export const completeRun = internalMutation
    .input({
        outcome: v.union(v.object({ error: v.string(), kind: v.literal("failed") }), v.object({ kind: v.literal("succeeded"), result: v.string() })),
        runId: v.id("subAgentRuns"),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => await finishRunFromLoop(ctx, args.runId, args.outcome));

/** Scheduled at admission: fails a run that never reported, which also frees its fan-out slot (and a stopped run's line). */
export const reapRun = internalMutation
    .input({ runId: v.id("subAgentRuns") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await finishRunFromLoop(ctx, args.runId, { error: "The sub-agent did not finish in time.", kind: "failed" });

        return null;
    });

/**
 * Whether the child's loop must stop: the run is no longer `running` — the
 * owner cancelled it, the reaper failed it, or it is gone.
 */
export const runShouldStop = async (ctx: Pick<MutationCtx | QueryCtx, "db">, runId: Id<"subAgentRuns">): Promise<boolean> => {
    const run = await ctx.db.get(runId);

    return !run || run.status !== "running";
};

/** {@link runShouldStop}, read by the child between steps (`execute.ts`). */
export const shouldRunStop = internalQuery
    .input({ runId: v.id("subAgentRuns") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => await runShouldStop(ctx, args.runId));

/**
 * Cancels one run through {@link finishRun}, whatever it is doing: a queued run
 * is never claimed (`claimQueuedRun` refuses it), a running one stops at its
 * next step boundary (`shouldRunStop`). Returns whether this call ended it; an
 * ended run is a no-op, so a second cancel changes and posts nothing.
 */
export const cancelSubAgentRun = async (ctx: MutationCtx, runId: Id<"subAgentRuns">): Promise<boolean> => await finishRun(ctx, runId, { kind: "cancelled" });

/** Runs read per stop; the fan-out cap keeps real ones to a handful, the bound is for a runaway. */
const CANCEL_THREAD_MAX = 20;

/**
 * What stopping `threadId` cancels, for the chat Stop paths. A sub-agent's own
 * thread, while its run is active, cancels only that run — not siblings, not the
 * sub-agents it started itself. Any other thread cancels every queued or running run it delegated and, below those,
 * what they delegated (depth is capped), so a stopped parent does not leave the cost running. Only the caller's own
 * runs count: a collaborator's Stop on someone's thread never reaches them.
 * Returns how many runs this call ended.
 */
export const cancelSubAgentRunsForStop = async (ctx: MutationCtx, threadId: string, userId: string): Promise<number> => {
    // A worker's thread holds many runs and may have messages queued: a Stop means the one going.
    const own = workerCurrentRun(await latestWorkerRuns(ctx, threadId)) ?? null;

    const targets: RunDoc[] = [];

    const activeRunsOf = async (parentThreadId: string): Promise<RunDoc[]> => {
        const runs: RunDoc[] = [];

        for (const status of ["queued", "running"] as const) {
            runs.push(
                ...(await ctx.db
                    .query("subAgentRuns")
                    .withIndex("by_parentThreadId_and_status", (q) => q.eq("parentThreadId", parentThreadId).eq("status", status))
                    .take(CANCEL_THREAD_MAX)),
            );
        }

        return runs;
    };

    // Once its own run has ended, the thread is an ordinary one again: a reply the
    // user got there may have delegated runs of its own.
    if (own) {
        targets.push(own);
    } else {
        // A stopped parent takes the whole tree down: what a cancelled run delegated
        // would otherwise keep billing and post back into a thread nobody waits on.
        // Not what a person typed into a worker's own thread (those carry a client id): only a Stop there ends them.
        const topLevel = await activeRunsOf(threadId);
        const notTyped = (run: RunDoc) => run.mode !== "worker" || run.clientId === undefined;
        let level = topLevel.filter((run) => notTyped(run));

        while (level.length > 0 && targets.length < CANCEL_THREAD_MAX) {
            targets.push(...level);

            const below = await Promise.all(level.flatMap((run) => (run.childThreadId ? [activeRunsOf(run.childThreadId)] : [])));

            level = below.flat().filter((run) => notTyped(run));
        }
    }

    let cancelled = 0;

    for (const run of targets) {
        if (run.userId === userId && (await cancelSubAgentRun(ctx, run._id))) {
            cancelled += 1;
        }
    }

    return cancelled;
};

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

/**
 * Cancels a run for the owner of its parent thread ({@link cancelSubAgentRun}): anyone
 * else, and a run that does not exist, answers NOT_FOUND so ids cannot be
 * probed. Returns whether this call ended the run.
 */
export const cancelOwnedSubAgentRun = async (ctx: MutationCtx, runId: Id<"subAgentRuns">, userId: string): Promise<boolean> => {
    const run = await ctx.db.get(runId);
    const parent = run ? await ctx.db.get(run.parentThreadId as Id<"threads">) : null;

    if (!run || !parent || parent.userId !== userId || run.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Run not found");
    }

    return await cancelSubAgentRun(ctx, run._id);
};

/**
 * Stops one sub-agent run, from its card. Ends the run at once (its slot is
 * free, the parent gets the post-back); a running child finishes the step it
 * is in, which is billed, and runs no more. Cancelling an ended run is a no-op.
 */
export const cancelRun = authMutation
    .use(rateLimit("chat/update"))
    .input({ runId: v.id("subAgentRuns") })
    .output(v.object({ cancelled: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        return { cancelled: await cancelOwnedSubAgentRun(ctx, args.runId, ctx.user.userId) };
    });

// ─── Workers: person-facing procedures ───────────────────────────────────────

const vWorkerReceipt = v.object({ runId: v.id("subAgentRuns"), state: vSubAgentRunStatus, workerId: v.string() });

const WORKER_REFUSAL_CODES = {
    archived: "CONFLICT",
    limit: "TOO_MANY_REQUESTS",
    not_found: "NOT_FOUND",
    other: "BAD_REQUEST",
} as const;

const dispatchOrThrow = async (ctx: MutationCtx, args: WorkerRunArgs): Promise<WorkerReceipt> => {
    const dispatched = await dispatchWorkerRun(ctx, args);

    if ("error" in dispatched) {
        throw new LunoraError(WORKER_REFUSAL_CODES[dispatched.kind], dispatched.error);
    }

    return dispatched;
};

/**
 * A person creates a worker under one of their own threads, with its first task. Same caps and
 * rate limit as a lead's delegation; no lead run vouches for the tools, so the allowlist stands as
 * asked and every run still builds only what the user's own permissions allow a headless run.
 */
export const createWorker = authMutation
    .input({
        clientId: v.string().max(WORKER_CLIENT_ID_MAX),
        leadThreadId: v.id("threads"),
        model: v.optional(v.string().max(200)),
        name: v.string().max(WORKER_NAME_MAX),
        skill: v.optional(v.string().max(SUB_AGENT_SKILL_SLUG_MAX)),
        task: v.string().max(SUB_AGENT_TASK_MAX),
        toolAllowlist: v.optional(v.array(v.string().max(128)).max(SUB_AGENT_MAX_TOOLS)),
        /** A locked chat's passcode proof, which every write to it needs. */
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(vWorkerReceipt)
    .mutation(async ({ args, ctx }) => {
        // The same gate as every other write to the chat: a locked lead needs its proof before a worker starts under it.
        throwUnlessGranted(
            await threadGateOutcome(ctx, { level: "write", threadId: args.leadThreadId, unlockProof: args.unlockProof, userId: ctx.user.userId }),
        );

        const lead = await ctx.db.get(args.leadThreadId);

        return await dispatchOrThrow(ctx, {
            clientId: args.clientId,
            ...(lead?.model !== undefined && { parentModel: lead.model }),
            ...(args.model !== undefined && { model: args.model }),
            name: args.name,
            parentThreadId: args.leadThreadId,
            ...(args.skill !== undefined && { skillSlug: args.skill }),
            task: args.task,
            ...(args.toolAllowlist !== undefined && { toolAllowlist: args.toolAllowlist }),
            userId: ctx.user.userId,
        });
    });

/**
 * The user types into a worker's thread. One message starts one run: the `clientId` dedupes a retry
 * or a redelivery, which returns the first run's receipt. An archived worker refuses; a stranger's
 * id is NOT_FOUND, as an id that does not exist is.
 */
export const dispatchToWorker = authMutation
    .input({
        clientId: v.string().max(WORKER_CLIENT_ID_MAX),
        message: v.string().max(SUB_AGENT_TASK_MAX),
        workerId: v.id("threads"),
    })
    .output(vWorkerReceipt)
    .mutation(async ({ args, ctx }) => {
        const origin = await workerOrigin(ctx, args.workerId);

        if (!origin || origin.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Worker not found.");
        }

        return await dispatchOrThrow(ctx, {
            childThreadId: args.workerId,
            clientId: args.clientId,
            parentThreadId: origin.parentThreadId,
            task: args.message,
            userId: ctx.user.userId,
        });
    });

const vFollowUp = v.union(v.literal("none"), v.literal("queue"), v.literal("steer"), v.literal("steer-restart"));

const vWorkerView = v.object({
    activeRunId: v.union(v.id("subAgentRuns"), v.null()),
    archived: v.boolean(),
    // How a message sent while a run is going is handled, from the runner's capabilities.
    followUp: vFollowUp,
    lastRunAt: v.number(),
    lastRunStatus: vSubAgentRunStatus,
    leadThreadId: v.string(),
    name: v.string(),
    // Why the latest run's result never reached the lead, once the post gave up; null when it did or was never owed.
    postFailed: v.union(v.string(), v.null()),
    state: v.union(v.literal("idle"), v.literal("queued"), v.literal("running")),
    workerId: v.string(),
});

/** A worker's name is its thread title, which a locked chat does not show. */
const workerName = (thread: Doc<"threads">, run: RunDoc): string =>
    isThreadLocked(thread) ? LOCKED_THREAD_TITLE : (thread.title ?? run.task.split("\n", 1)[0]!.slice(0, WORKER_NAME_MAX));

/**
 * What a worker is doing, from its active run if it has one. A stopped run whose loop is still unwinding
 * counts as running: a message sent now waits for it, so the worker is not idle (and not archivable).
 */
const workerState = (working: RunDoc | undefined, unwinding: boolean): "idle" | "queued" | "running" => {
    if (!working) {
        return unwinding ? "running" : "idle";
    }

    return working.status === "running" ? "running" : "queued";
};

/** Workers shown under one lead, most recently dispatched first. */
const WORKER_LIST_MAX = 20;

const ALL_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

/** The workers of one of the caller's threads: name, whether archived, whether working. */
export const listWorkers = authQuery
    .input({ leadThreadId: v.id("threads"), unlockProof: v.optional(v.string().max(MAX_LENGTH.short)) })
    .output(v.array(vWorkerView))
    .query(async ({ args, ctx }) => {
        // A locked lead shows nothing of its workers (their titles are its content) until it is unlocked.
        if ((await threadGateOutcome(ctx, { level: "read", threadId: args.leadThreadId, unlockProof: args.unlockProof, userId: ctx.user.userId })) !== "ok") {
            return [];
        }

        const runs: RunDoc[] = [];

        for (const status of ALL_STATUSES) {
            runs.push(
                ...(await ctx.db
                    .query("subAgentRuns")
                    .withIndex("by_parentThreadId_and_status", (q) => q.eq("parentThreadId", args.leadThreadId).eq("status", status))
                    // Newest first: the oldest runs of a long-lived lead are not the ones whose state the list shows.
                    .order("desc")
                    .take(SUB_AGENT_LIFETIME_SCAN)),
            );
        }

        // Each worker's runs, newest first: its state and delivery status read from all of them, as `getWorker` does.
        const byWorker = new Map<string, RunDoc[]>();
        const newestFirst = runs.toSorted((a, b) => b.createdAt - a.createdAt);

        for (const run of newestFirst) {
            if (run.mode !== "worker" || run.userId !== ctx.user.userId || run.childThreadId === undefined) {
                continue;
            }

            byWorker.set(run.childThreadId, [...(byWorker.get(run.childThreadId) ?? []), run]);
        }

        const newest = [...byWorker.values()].toSorted((a, b) => b[0]!.createdAt - a[0]!.createdAt).slice(0, WORKER_LIST_MAX);
        const views: Infer<typeof vWorkerView>[] = [];

        for (const group of newest) {
            const run = group[0]!;
            const thread = await ctx.db.get(run.childThreadId as Id<"threads">);

            if (!thread || thread.deleted || thread.userId !== ctx.user.userId) {
                continue;
            }

            const working = workerCurrentRun(group);

            views.push({
                activeRunId: working?._id ?? null,
                archived: thread.status === "archived",
                followUp: workerFollowUp(run.runner),
                lastRunAt: run.createdAt,
                lastRunStatus: run.status,
                leadThreadId: run.parentThreadId,
                name: workerName(thread, run),
                postFailed: workerPostFailure(group),
                state: workerState(
                    working,
                    group.some((candidate) => isWorkerLoopLive(candidate)),
                ),
                workerId: run.childThreadId!,
            });
        }

        return views;
    });

/** One worker's thread, for the composer in it: its lead, whether it is archived, whether a run is live. Null for any other thread. */
export const getWorker = authQuery
    .input({ workerId: v.id("threads") })
    .output(v.union(vWorkerView, v.null()))
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.workerId);
        const origin = thread ? await workerOrigin(ctx, args.workerId) : null;

        if (!thread || thread.deleted || thread.userId !== ctx.user.userId || !origin || origin.userId !== ctx.user.userId) {
            return null;
        }

        const recent = await latestWorkerRuns(ctx, args.workerId);
        const latest = recent[0]!;
        const working = workerCurrentRun(recent);

        return {
            activeRunId: working?._id ?? null,
            archived: thread.status === "archived",
            followUp: workerFollowUp(origin.runner),
            lastRunAt: latest.createdAt,
            lastRunStatus: latest.status,
            leadThreadId: origin.parentThreadId,
            name: workerName(thread, origin),
            postFailed: workerPostFailure(recent),
            state: workerState(
                working,
                recent.some((candidate) => isWorkerLoopLive(candidate)),
            ),
            workerId: args.workerId,
        };
    });

const vActiveWorkerRun = v.object({
    createdAt: v.number(),
    leadThreadId: v.string(),
    name: v.string(),
    runId: v.id("subAgentRuns"),
    startedAt: v.union(v.number(), v.null()),
    status: v.union(v.literal("queued"), v.literal("running")),
    workerId: v.string(),
});

/** Live worker runs read per status; the fan-out cap keeps real ones to a handful. */
const ACTIVE_WORKER_RUNS_MAX = 50;

/** The caller's live worker runs, for a rail that shows what is working right now. */
export const listActiveWorkerRuns = authQuery
    .input({})
    .output(v.array(vActiveWorkerRun))
    .query(async ({ ctx }) => {
        const views: Infer<typeof vActiveWorkerRun>[] = [];

        for (const status of ["running", "queued"] as const) {
            const runs = await ctx.db
                .query("subAgentRuns")
                .withIndex("by_user_and_status", (q) => q.eq("userId", ctx.user.userId).eq("status", status))
                .order("desc")
                .take(ACTIVE_WORKER_RUNS_MAX);

            for (const run of runs) {
                if (run.mode !== "worker" || run.childThreadId === undefined) {
                    continue;
                }

                const thread = await ctx.db.get(run.childThreadId as Id<"threads">);

                views.push({
                    createdAt: run.createdAt,
                    leadThreadId: run.parentThreadId,
                    name: thread && !thread.deleted ? workerName(thread, run) : run.task.split("\n", 1)[0]!.slice(0, WORKER_NAME_MAX),
                    runId: run._id,
                    startedAt: run.startedAt ?? null,
                    status,
                    workerId: run.childThreadId,
                });
            }
        }

        return views;
    });
