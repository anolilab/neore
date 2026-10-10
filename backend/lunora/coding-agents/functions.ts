/**
 * Coding-agent runs — the state machine and the public surface.
 *
 * A run is `queued` → `running` → `succeeded` | `failed` | `cancelled`. Only
 * `claimRun` moves it to `running` and only `completeRun` / `cancelRun` /
 * `expireRun` end it; each checks the current status first, so a late write
 * from a runner that lost a race is a no-op rather than a resurrection.
 *
 * Every public procedure loads by id and compares `userId`; another user's run
 * answers NOT_FOUND, never FORBIDDEN, so ids cannot be probed.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { resolveLeafRow } from "../agent/branch-rows";
import { addMessagesHandler, getMaxMessage } from "../agent/messages";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { enqueueJob } from "../lib/job-queue";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchById, patchRow } from "../lib/patch";
import { createRatelimit } from "../lib/rate-limiter";
import { notifyQuietly } from "../notifications/notify";
import { loadTaskAccount } from "../tasks/account";
import { isValidBranchName, parseRepoUrl, PROMPT_MAX, RUN_TIMEOUT_MS } from "./commands";
import { repoLabel } from "./repo-label";
import { vCodingAgentId, vCodingAgentRunStatus } from "./validators";

/** The reaper fires this long after the budget, for a runner that died without reporting. */
const REAPER_GRACE_MS = 3 * 60 * 1000;

/** Tail of the log kept on the row; older output is dropped with a marker. */
const LOG_MAX_CHARS = 96 * 1024;

const LOG_TRUNCATED_MARKER = "… (earlier output truncated)\n";

const ACTIVE_STATUSES = ["queued", "running"] as const;

type RunDoc = Doc<"codingAgentRuns">;

// ─── Views ───────────────────────────────────────────────────────────────────

const vRunView = v.object({
    _id: v.id("codingAgentRuns"),
    agent: vCodingAgentId,
    baseBranch: v.union(v.string(), v.null()),
    canOpenPr: v.boolean(),
    completedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    diff: v.union(v.string(), v.null()),
    diffStat: v.union(v.string(), v.null()),
    diffTruncated: v.boolean(),
    error: v.union(v.string(), v.null()),
    log: v.string(),
    openPr: v.boolean(),
    prompt: v.string(),
    prPending: v.boolean(),
    prUrl: v.union(v.string(), v.null()),
    repoUrl: v.string(),
    startedAt: v.union(v.number(), v.null()),
    status: vCodingAgentRunStatus,
    summary: v.union(v.string(), v.null()),
});

const isGithubRepo = (repoUrl: string): boolean => {
    try {
        return parseRepoUrl(repoUrl).github !== undefined;
    } catch {
        return false;
    }
};

/** Whether "Create PR" applies. Whether GitHub is connected is only known to the action. */
export const canOpenPullRequest = (run: Pick<RunDoc, "diff" | "diffTruncated" | "prStatus" | "prUrl" | "repoUrl" | "status">): boolean =>
    run.status === "succeeded" && Boolean(run.diff) && run.diffTruncated !== true && !run.prUrl && run.prStatus !== "pending" && isGithubRepo(run.repoUrl);

const toView = (run: RunDoc) => {
    return {
        _id: run._id,
        agent: run.agent,
        baseBranch: run.baseBranch ?? null,
        canOpenPr: canOpenPullRequest(run),
        completedAt: run.completedAt ?? null,
        createdAt: run.createdAt,
        diff: run.diff ?? null,
        diffStat: run.diffStat ?? null,
        diffTruncated: run.diffTruncated === true,
        error: run.error ?? null,
        log: run.log,
        openPr: run.openPr,
        prompt: run.prompt,
        prPending: run.prStatus === "pending",
        prUrl: run.prUrl ?? null,
        repoUrl: run.repoUrl,
        startedAt: run.startedAt ?? null,
        status: run.status,
        summary: run.summary ?? null,
    };
};

export const appendToLog = (log: string, text: string): string => {
    const next = log + text;

    if (next.length <= LOG_MAX_CHARS) {
        return next;
    }

    const tail = next.slice(next.length - (LOG_MAX_CHARS - LOG_TRUNCATED_MARKER.length));
    const lineStart = tail.indexOf("\n");

    return LOG_TRUNCATED_MARKER + (lineStart === -1 ? tail : tail.slice(lineStart + 1));
};

// ─── Public ──────────────────────────────────────────────────────────────────

export const getRun = authQuery
    .input({ runId: v.id("codingAgentRuns") })
    .output(v.union(vRunView, v.null()))
    .query(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        return run && run.userId === ctx.user.userId ? toView(run) : null;
    });

/** The run a chat tool call started — the tool part knows only its call id. */
export const getRunByToolCall = authQuery
    .input({ toolCallId: v.string().check((value) => value.length > 0 && value.length <= 256, { message: "Invalid tool call id" }) })
    .output(v.union(vRunView, v.null()))
    .query(async ({ args, ctx }) => {
        const run = await ctx.db
            .query("codingAgentRuns")
            .withIndex("by_user_and_toolCallId", (q) => q.eq("userId", ctx.user.userId).eq("toolCallId", args.toolCallId))
            .first();

        return run ? toView(run) : null;
    });

/** The newest run of a task assigned to a coding agent. */
export const getLatestRunForTask = authQuery
    .input({ taskId: v.id("tasks") })
    .output(v.union(vRunView, v.null()))
    .query(async ({ args, ctx }) => {
        const task = await ctx.db.get(args.taskId);

        if (!task || task.userId !== ctx.user.userId) {
            return null;
        }

        const run = await ctx.db
            .query("codingAgentRuns")
            .withIndex("by_task_and_createdAt", (q) => q.eq("taskId", args.taskId))
            .order("desc")
            .first();

        return run && run.userId === ctx.user.userId ? toView(run) : null;
    });

export const cancelRun = authMutation
    .use(rateLimit("chat/update"))
    .input({ runId: v.id("codingAgentRuns") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Run not found");
        }

        if (!(ACTIVE_STATUSES as ReadonlyArray<string>).includes(run.status)) {
            return null;
        }

        const now = ctx.now;

        await patchById(ctx.db, run._id, {
            completedAt: now,
            error: "Cancelled",
            log: appendToLog(run.log, "Cancelled by user.\n"),
            status: "cancelled",
            updatedAt: now,
        });

        if (run.sandboxId) {
            await ctx.scheduler.runAfter(0, internal.coding_agents.execute.killRunSandbox, { sandboxId: run.sandboxId });
        }

        // The thread gets its follow-up and a waiting task round its answer.
        await ctx.scheduler.runAfter(0, internal.coding_agents.execute.finishRun, { runId: run._id });

        ctx.log.event("coding_agents.cancel_run", { hadSandbox: run.sandboxId !== undefined });

        return null;
    });

// ─── Internal: lifecycle ─────────────────────────────────────────────────────

/** Whether the user stored their own key for `provider`, without decrypting it. */
export const hasProviderKey = internalQuery
    .input({ provider: v.union(v.literal("anthropic"), v.literal("openai")), userId: v.string() })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const prefs = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", args.userId))
            .unique();
        const entry = (prefs?.providerApiKeys as Record<string, { enabled?: boolean; encryptedKey?: string }> | undefined)?.[args.provider];

        return Boolean(entry?.enabled && entry.encryptedKey);
    });

/** Why `userId` may not start a run now, or `undefined`. Charges the rate limit when it may. */
const startProblem = async (ctx: MutationCtx, userId: string): Promise<string | undefined> => {
    const account = await loadTaskAccount(ctx, userId);

    if (!account) {
        return "Your account no longer exists.";
    }

    if (account.isAnonymous) {
        return "Coding agents need an account. Sign up to delegate work to one.";
    }

    if (await isAccountDeletionUnderway(ctx, userId)) {
        return "This account is being deleted.";
    }

    for (const status of ACTIVE_STATUSES) {
        const active = await ctx.db
            .query("codingAgentRuns")
            .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", status))
            .first();

        if (active) {
            return "A coding agent is already running for you. Wait for it to finish or cancel it first.";
        }
    }

    const { ok } = await createRatelimit(`codingAgent/run:${account.tier}`, ctx.db as never).limit(userId);

    return ok ? undefined : "You have started too many coding agent runs recently. Try again later.";
};

/**
 * Create a run after every admission check: account, one active run per user,
 * rate limit, a valid repo/branch/prompt. The start step and the reaper are
 * scheduled in the same transaction, so a created run always has both.
 */
export const createRun = internalMutation
    .input({
        agent: vCodingAgentId,
        branch: v.optional(v.string()),
        openPr: v.boolean(),
        prompt: v.string(),
        repoUrl: v.string(),
        taskId: v.optional(v.id("tasks")),
        taskRunId: v.optional(v.id("taskRuns")),
        threadId: v.optional(v.string()),
        toolCallId: v.optional(v.string()),
        userId: v.string(),
    })
    .output(v.union(v.object({ runId: v.id("codingAgentRuns") }), v.object({ error: v.string() })))
    .mutation(async ({ args, ctx }) => {
        let repoUrl: string;

        try {
            repoUrl = parseRepoUrl(args.repoUrl).cloneUrl;
        } catch (error) {
            return { error: error instanceof Error ? error.message : "Invalid repository" };
        }

        const branch = args.branch?.trim() || undefined;

        if (branch !== undefined && !isValidBranchName(branch)) {
            return { error: "Invalid branch name" };
        }

        const prompt = args.prompt.trim();

        if (prompt.length === 0 || prompt.length > PROMPT_MAX) {
            return { error: `The task must be between 1 and ${String(PROMPT_MAX)} characters` };
        }

        const problem = await startProblem(ctx, args.userId);

        if (problem) {
            return { error: problem };
        }

        const now = ctx.now;
        const runId = await ctx.db.insert("codingAgentRuns", {
            agent: args.agent,
            branch,
            createdAt: now,
            log: "",
            openPr: args.openPr,
            prompt,
            repoUrl,
            status: "queued",
            taskId: args.taskId,
            taskRunId: args.taskRunId,
            threadId: args.threadId,
            toolCallId: args.toolCallId,
            updatedAt: now,
            userId: args.userId,
        });

        // Jobs queue (`lib/job-queue.ts`); a redelivery is refused by `claimRun`.
        await enqueueJob(internal.coding_agents.execute.startCodingAgentRun, { runId });
        await ctx.scheduler.runAfter(RUN_TIMEOUT_MS + REAPER_GRACE_MS, internal.coding_agents.execute.reapRun, { runId });

        return { runId };
    });

/** `queued` → `running`; `null` when the run is gone or no longer queued. */
export const claimRun = internalMutation
    .input({ runId: v.id("codingAgentRuns") })
    .output(
        v.union(
            v.object({
                agent: vCodingAgentId,
                branch: v.optional(v.string()),
                openPr: v.boolean(),
                prompt: v.string(),
                repoUrl: v.string(),
                userId: v.string(),
            }),
            v.null(),
        ),
    )
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.status !== "queued") {
            return null;
        }

        const now = ctx.now;

        await patchById(ctx.db, run._id, { startedAt: now, status: "running", updatedAt: now });

        return {
            agent: run.agent,
            ...(run.branch !== undefined && { branch: run.branch }),
            openPr: run.openPr,
            prompt: run.prompt,
            repoUrl: run.repoUrl,
            userId: run.userId,
        };
    });

const vCancelled = v.object({ cancelled: v.boolean() });

/** Append already-redacted text. Answers whether the run was cancelled meanwhile. */
export const appendRunLog = internalMutation
    .input({ runId: v.id("codingAgentRuns"), text: v.string() })
    .output(vCancelled)
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.status !== "running") {
            return { cancelled: true };
        }

        await patchById(ctx.db, run._id, { log: appendToLog(run.log, args.text), updatedAt: ctx.now });

        return { cancelled: false };
    });

export const setRunSandbox = internalMutation
    .input({ runId: v.id("codingAgentRuns"), sandboxId: v.string() })
    .output(vCancelled)
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run) {
            return { cancelled: true };
        }

        // Recorded even on a cancelled run, so a later sweep can still kill it.
        await patchById(ctx.db, run._id, { sandboxId: args.sandboxId, updatedAt: ctx.now });

        return { cancelled: run.status !== "running" };
    });

/** The inbox entry for a finished run; deduped per run (a completion and the reaper can both land). */
const notifyCodingAgentRun = async (
    ctx: MutationCtx,
    run: Doc<"codingAgentRuns">,
    outcome: "failure" | "success",
    detail: string | undefined,
): Promise<void> => {
    let link = "/dashboard";

    if (run.threadId) {
        link = `/chat/${run.threadId}`;
    } else if (run.taskId) {
        link = "/tasks";
    }

    await notifyQuietly(ctx, {
        dedupeKey: `coding_agent:${run._id}`,
        link,
        outcome,
        title: `${repoLabel(run.repoUrl)}: ${run.prompt}`,
        type: "coding_agent",
        userId: run.userId,
        ...(detail && { body: detail }),
    });
};

export const completeRun = internalMutation
    .input({
        baseBranch: v.optional(v.string()),
        baseSha: v.optional(v.string()),
        diff: v.optional(v.string()),
        diffStat: v.optional(v.string()),
        diffTruncated: v.optional(v.boolean()),
        error: v.optional(v.string()),
        exitCode: v.optional(v.number()),
        runId: v.id("codingAgentRuns"),
        status: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("cancelled")),
        summary: v.optional(v.string()),
    })
    .output(v.null())
    .mutation(async ({ args: { runId, ...outcome }, ctx }) => {
        const run = await ctx.db.get(runId);

        if (!run || !(ACTIVE_STATUSES as ReadonlyArray<string>).includes(run.status)) {
            return null;
        }

        const now = ctx.now;

        await patchById(ctx.db, runId, { ...outcome, completedAt: now, updatedAt: now });

        if (outcome.status !== "cancelled") {
            await notifyCodingAgentRun(
                ctx,
                run,
                outcome.status === "succeeded" ? "success" : "failure",
                outcome.status === "succeeded" ? outcome.summary : outcome.error,
            );
        }

        return null;
    });

/** The reaper's half: a run still active past its budget is failed. Returns its sandbox to kill. */
export const expireRun = internalMutation
    .input({ runId: v.id("codingAgentRuns") })
    .output(v.union(v.object({ sandboxId: v.optional(v.string()) }), v.null()))
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || !(ACTIVE_STATUSES as ReadonlyArray<string>).includes(run.status)) {
            return null;
        }

        const now = ctx.now;
        const error = `Timed out after ${String(RUN_TIMEOUT_MS / 60_000)} minutes`;

        await patchById(ctx.db, run._id, { completedAt: now, error, log: appendToLog(run.log, `${error}.\n`), status: "failed", updatedAt: now });
        await notifyCodingAgentRun(ctx, run, "failure", error);

        return { ...(run.sandboxId !== undefined && { sandboxId: run.sandboxId }) };
    });

// ─── Internal: polling and follow-ups ────────────────────────────────────────

/** Whether a poll numbered `seq` may run: true for exactly one delivery, which also advances the sequence. */
export const isCurrentPoll = (pollSeq: number | undefined, seq: number): boolean => (pollSeq ?? 0) === seq;

/**
 * Claim poll `seq` of a run (or its PR). Polls travel on the jobs queue, which
 * delivers at least once; each poll enqueues the next, so a redelivered poll
 * would otherwise start a second chain that polls — and appends to the log —
 * in parallel with the first, forever. Only the first delivery of `seq` wins.
 */
export const claimPoll = internalMutation
    .input({ runId: v.id("codingAgentRuns"), seq: v.number() })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || !isCurrentPoll(run.pollSeq, args.seq)) {
            return false;
        }

        await patchById(ctx.db, run._id, { pollSeq: args.seq + 1 });

        return true;
    });

/** What one poll needs, or `null` once the run is no longer running. */
export const getRunForPoll = internalQuery
    .input({ runId: v.id("codingAgentRuns") })
    .output(
        v.union(
            v.object({
                agent: vCodingAgentId,
                logOffset: v.number(),
                sandboxId: v.optional(v.string()),
                startedAt: v.number(),
                summary: v.optional(v.string()),
                userId: v.string(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.status !== "running") {
            return null;
        }

        return {
            agent: run.agent,
            logOffset: run.logOffset ?? 0,
            ...(run.sandboxId !== undefined && { sandboxId: run.sandboxId }),
            startedAt: run.startedAt ?? run.createdAt,
            ...(run.summary !== undefined && { summary: run.summary }),
            userId: run.userId,
        };
    });

/** One poll's worth of redacted log. Answers whether the run was cancelled meanwhile. */
export const recordPoll = internalMutation
    .input({ offset: v.number(), runId: v.id("codingAgentRuns"), summary: v.optional(v.string()), text: v.string() })
    .output(vCancelled)
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.status !== "running") {
            return { cancelled: true };
        }

        await patchById(ctx.db, run._id, {
            ...(args.text && { log: appendToLog(run.log, args.text) }),
            logOffset: args.offset,
            ...(args.summary !== undefined && { summary: args.summary.slice(0, 20_000) }),
            updatedAt: ctx.now,
        });

        return { cancelled: false };
    });

/**
 * Claim a finished run's follow-ups exactly once. Several steps can end a run
 * (the poller, a cancel, the reaper); whichever calls this first gets
 * `{ claimed: true }`, every later call `{ claimed: false }`.
 */
export const claimFinish = internalMutation
    .input({ runId: v.id("codingAgentRuns") })
    .output(v.object({ claimed: v.boolean(), wantsPr: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.finishedAt !== undefined || (ACTIVE_STATUSES as ReadonlyArray<string>).includes(run.status)) {
            return { claimed: false, wantsPr: false };
        }

        await patchById(ctx.db, run._id, { finishedAt: ctx.now });

        return { claimed: true, wantsPr: run.openPr && run.status === "succeeded" && canOpenPullRequest(run) };
    });

/** What the follow-ups (thread message, task round) need, read when they run — after any PR. */
export const getRunForFollowUp = internalQuery
    .input({ runId: v.id("codingAgentRuns") })
    .output(
        v.union(
            v.object({
                agent: vCodingAgentId,
                diffStat: v.optional(v.string()),
                error: v.optional(v.string()),
                hasDiff: v.boolean(),
                prUrl: v.optional(v.string()),
                repoUrl: v.string(),
                status: vCodingAgentRunStatus,
                summary: v.optional(v.string()),
                taskRunId: v.optional(v.id("taskRuns")),
                threadId: v.optional(v.string()),
                userId: v.string(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run) {
            return null;
        }

        return {
            agent: run.agent,
            ...(run.diffStat !== undefined && { diffStat: run.diffStat }),
            ...(run.error !== undefined && { error: run.error }),
            hasDiff: Boolean(run.diff),
            ...(run.prUrl !== undefined && { prUrl: run.prUrl }),
            repoUrl: run.repoUrl,
            status: run.status,
            ...(run.summary !== undefined && { summary: run.summary }),
            ...(run.taskRunId !== undefined && { taskRunId: run.taskRunId }),
            ...(run.threadId !== undefined && { threadId: run.threadId }),
            userId: run.userId,
        };
    });

// ─── Internal: pull requests ─────────────────────────────────────────────────

/**
 * Claim the right to open this run's PR: the owner's, finished, with a complete
 * diff, not already opened or in flight. Marks it `pending`, which is also what
 * makes a double click (or the auto-PR racing the button) start only one.
 */
export const beginPullRequest = internalMutation
    .input({ followUp: v.boolean(), runId: v.id("codingAgentRuns"), userId: v.string() })
    .output(
        v.union(
            v.object({
                baseBranch: v.string(),
                diff: v.string(),
                pollSeq: v.number(),
                prompt: v.string(),
                repoUrl: v.string(),
                summary: v.optional(v.string()),
            }),
            v.object({ error: v.string() }),
        ),
    )
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.userId !== args.userId) {
            return { error: "Run not found" };
        }

        if (run.prStatus === "pending") {
            return { error: "A pull request for this run is already being opened." };
        }

        if (!canOpenPullRequest(run) || !run.diff || !run.baseBranch) {
            return { error: "This run has no change that can be turned into a pull request." };
        }

        const now = ctx.now;

        await patchById(ctx.db, run._id, { prFollowUp: args.followUp, prStartedAt: now, prStatus: "pending", updatedAt: now });

        return {
            baseBranch: run.baseBranch,
            diff: run.diff,
            pollSeq: run.pollSeq ?? 0,
            prompt: run.prompt,
            repoUrl: run.repoUrl,
            ...(run.summary !== undefined && { summary: run.summary }),
        };
    });

export const setPullRequestSandbox = internalMutation
    .input({ runId: v.id("codingAgentRuns"), sandboxId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (run) {
            await patchById(ctx.db, run._id, { prSandboxId: args.sandboxId, updatedAt: ctx.now });
        }

        return null;
    });

/** What one PR poll needs, or `null` once no PR is in flight. */
export const getPullRequestForPoll = internalQuery
    .input({ runId: v.id("codingAgentRuns") })
    .output(
        v.union(
            v.object({
                baseBranch: v.string(),
                prompt: v.string(),
                repoUrl: v.string(),
                sandboxId: v.optional(v.string()),
                startedAt: v.number(),
                summary: v.optional(v.string()),
                userId: v.string(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.prStatus !== "pending" || !run.baseBranch) {
            return null;
        }

        return {
            baseBranch: run.baseBranch,
            prompt: run.prompt,
            repoUrl: run.repoUrl,
            ...(run.prSandboxId !== undefined && { sandboxId: run.prSandboxId }),
            startedAt: run.prStartedAt ?? run.updatedAt,
            ...(run.summary !== undefined && { summary: run.summary }),
            userId: run.userId,
        };
    });

/** End an in-flight PR: record the URL or the failure. Answers whether the follow-ups were waiting on it. */
export const completePullRequest = internalMutation
    .input({ log: v.string(), prUrl: v.optional(v.string()), runId: v.id("codingAgentRuns") })
    .output(v.object({ followUp: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run || run.prStatus !== "pending") {
            return { followUp: false };
        }

        await patchRow(ctx.db, run, {
            log: appendToLog(run.log, args.log),
            prFollowUp: undefined,
            prSandboxId: undefined,
            prStartedAt: undefined,
            prStatus: args.prUrl === undefined ? "failed" : undefined,
            ...(args.prUrl !== undefined && { prUrl: args.prUrl }),
            updatedAt: ctx.now,
        });

        return { followUp: run.prFollowUp === true };
    });

/**
 * The run's result as a follow-up assistant message in the thread that
 * started it, under the coding agent's name, as a new turn on the thread's
 * active branch. Skipped when the thread is gone or no longer the owner's.
 */
export const postRunResult = internalMutation
    .input({ agentName: v.string(), runId: v.id("codingAgentRuns"), text: v.string(), threadId: v.string(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId as Id<"threads">);

        if (!thread || thread.deleted || thread.userId !== args.userId) {
            return null;
        }

        const last = await getMaxMessage(ctx, thread._id);
        // A branched thread: hang the reply off the leaf the user is looking at.
        // An unbranched one needs no explicit parent (the previous row is it).
        const leaf = thread.activeLeafMessageId ? await resolveLeafRow(ctx, thread._id, thread.activeLeafMessageId) : null;

        await addMessagesHandler(ctx, {
            agentName: args.agentName,
            messages: [{ message: { content: args.text, role: "assistant" }, status: "success" }],
            overrideOrder: (last?.order ?? -1) + 1,
            ...(leaf && { parentMessageId: leaf._id }),
            threadId: thread._id,
            userId: args.userId,
        });

        await patchById(ctx.db, thread._id, { updatedAt: ctx.now });

        return null;
    });

/** The outcome a waiting task round turns into its answer. */
export const getRunForTaskRound = internalQuery
    .input({ runId: v.id("codingAgentRuns") })
    .output(
        v.union(
            v.object({
                diffStat: v.optional(v.string()),
                error: v.optional(v.string()),
                prUrl: v.optional(v.string()),
                status: vCodingAgentRunStatus,
                summary: v.optional(v.string()),
                taskId: v.optional(v.id("tasks")),
                taskRunId: v.optional(v.id("taskRuns")),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const run = await ctx.db.get(args.runId);

        if (!run) {
            return null;
        }

        return {
            ...(run.diffStat !== undefined && { diffStat: run.diffStat }),
            ...(run.error !== undefined && { error: run.error }),
            ...(run.prUrl !== undefined && { prUrl: run.prUrl }),
            status: run.status,
            ...(run.summary !== undefined && { summary: run.summary }),
            ...(run.taskId !== undefined && { taskId: run.taskId }),
            ...(run.taskRunId !== undefined && { taskRunId: run.taskRunId }),
        };
    });
