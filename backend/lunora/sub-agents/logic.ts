/**
 * Sub-agents — the pure rules: caps, tool allowlists, the child's prompt, the
 * model it runs on and the message its result becomes. No I/O, so every rule
 * is unit-tested directly (`logic.test.ts`).
 */
import type { FollowUpControl } from "@neore/ai/capabilities";
import { CLOUD_HEADLESS_CAPABILITIES, followUpControl } from "@neore/ai/capabilities";
import type { StopCondition, ToolSet } from "ai";

/**
 * How deep delegation may nest. A user's own thread is depth 0; its sub-agent
 * runs at 1, and that sub-agent's own sub-agent at 2 — the last level allowed.
 */
export const SUB_AGENT_MAX_DEPTH = 2;

/** Whether a run at `depth` may still delegate — below the cap. */
export const canNest = (depth: number): boolean => depth < SUB_AGENT_MAX_DEPTH;

/** The delegate tool's name (`chat/tools/delegate-to-sub-agent.ts`), kept here so this module stays import-free. */
export const SUB_AGENT_TOOL_NAME = "delegateToSubAgent";

/** The tool a lead uses to message a worker it started; the delegation consent covers it. */
export const MESSAGE_WORKER_TOOL_NAME = "messageWorker";

/** Sub-agents one thread may have queued or running at once. */
export const SUB_AGENT_MAX_CONCURRENT = 3;

/**
 * Sub-agents one sub-agent RUN may start over its whole life, finished ones
 * included. A run is headless and carries the delegate tool's inherited
 * approval, so the concurrency cap alone let it start them back to back for
 * all of its steps — one "Approve" draining the hourly and daily budgets. A
 * user's own thread is not capped this way; each of its turns asks anew.
 */
export const SUB_AGENT_MAX_PER_RUN = 5;

export const SUB_AGENT_TASK_MAX = 8000;

export const SUB_AGENT_SKILL_SLUG_MAX = 100;

/** Tool names an allowlist may carry. */
export const SUB_AGENT_MAX_TOOLS = 30;

/** Characters of a worker's name, which is its thread title. */
export const WORKER_NAME_MAX = 80;

/** Characters of the id a client sends to dedupe one dispatch. */
export const WORKER_CLIENT_ID_MAX = 128;

/** Characters of the child's answer kept on the row and posted back. */
export const SUB_AGENT_RESULT_MAX = 12_000;

/**
 * When a run that never reported is failed by its reaper: longer than any
 * 25-step Deep Work run (the task reaper uses the same bound), plus the time a
 * queued job may wait for a consumer.
 */
export const SUB_AGENT_STALE_MS = 75 * 60_000;

/**
 * While the parent thread is still streaming, the result post waits — a row
 * inserted mid-run would land between the parent's own steps. It re-checks
 * with a growing delay and posts regardless once the waits add up past the
 * longest a stream may live (30 minutes, then the timeout cron ends it).
 */
export const SUB_AGENT_POST_MAX_ATTEMPTS = 40;

/** Delay before re-check `attempt` (0-based): 2s doubling, capped at one minute. */
export const postRetryDelayMs = (attempt: number): number => Math.min(2000 * 2 ** attempt, 60_000);

/**
 * Re-checks of a parent thread that cannot take the post (deleted, not the run's owner's, locked)
 * before the run is given up on as `postFailed`. With {@link postRetryDelayMs} that is a few minutes,
 * long enough to ride out a lock the user lifts straight away.
 */
export const SUB_AGENT_POST_FAILURE_MAX_ATTEMPTS = 8;

/** The name the posted-back result carries in the parent thread. */
export const SUB_AGENT_NAME = "Sub-agent";

const TOOL_NAME_RE = /^[\w.:-]{1,128}$/;

export type SubAgentStatus = "cancelled" | "failed" | "queued" | "running" | "succeeded";

/**
 * Whether an ended run posts its result to the lead. A worker run the user typed (or created) has no
 * delegating tool call behind it, so the lead never asked for an answer and hears nothing.
 */
export const postsBack = (run: { mode?: "run" | "worker"; toolCallId?: string }): boolean => run.mode !== "worker" || run.toolCallId !== undefined;

export const isActiveSubAgentStatus = (status: SubAgentStatus): boolean => status === "queued" || status === "running";

/**
 * Why a new sub-agent may not start under a parent at `parentDepth` that
 * already has `activeChildren` queued or running (and, for a parent that is
 * itself a sub-agent, `totalChildren` started ever), or `undefined` when it may.
 */
export const subAgentCapProblem = (input: { activeChildren: number; parentDepth: number; totalChildren?: number }): string | undefined => {
    if (input.parentDepth + 1 > SUB_AGENT_MAX_DEPTH) {
        return `Sub-agents can nest at most ${String(SUB_AGENT_MAX_DEPTH)} levels deep. Do this part of the work yourself.`;
    }

    if (input.parentDepth > 0 && (input.totalChildren ?? 0) >= SUB_AGENT_MAX_PER_RUN) {
        return `A sub-agent can start at most ${String(SUB_AGENT_MAX_PER_RUN)} sub-agents of its own. Do the rest of the work yourself.`;
    }

    if (input.activeChildren >= SUB_AGENT_MAX_CONCURRENT) {
        return `At most ${String(SUB_AGENT_MAX_CONCURRENT)} sub-agents can run at once in a conversation. Wait for one to finish.`;
    }

    return undefined;
};

/**
 * The allowlist as stored: trimmed, de-duplicated, valid names only.
 * `undefined` (no list) means the child gets its normal tool set; an empty
 * result from a non-empty list means the child runs with no tools at all.
 */
export const normalizeToolAllowlist = (tools: ReadonlyArray<string> | undefined): { error: string } | { tools: string[] | undefined } => {
    if (tools === undefined) {
        return { tools: undefined };
    }

    const names = [...new Set(tools.map((name) => name.trim()).filter(Boolean))];

    if (names.length > SUB_AGENT_MAX_TOOLS) {
        return { error: `A sub-agent's tool list can name at most ${String(SUB_AGENT_MAX_TOOLS)} tools` };
    }

    const invalid = names.find((name) => !TOOL_NAME_RE.test(name));

    if (invalid !== undefined) {
        return { error: `Invalid tool name: ${invalid.slice(0, 64)}` };
    }

    return { tools: names };
};

/**
 * What a worker is allowed to call: the requested names that the lead could call itself, or the
 * lead's set (at most {@link SUB_AGENT_MAX_TOOLS} names) when none are requested. A worker never widens its lead, so a requested name the
 * lead lacks is refused rather than dropped. `leadTools` is the lead run's effective tool names, after
 * the user's permissions; `undefined` means no lead run vouches for the request (a person creating the
 * worker), and the request stands.
 */
export const intersectWithLeadTools = (
    requested: ReadonlyArray<string> | undefined,
    leadTools: ReadonlyArray<string> | undefined,
): { error: string } | { tools: string[] | undefined } => {
    if (leadTools === undefined) {
        return { tools: requested === undefined ? undefined : [...requested] };
    }

    if (requested === undefined) {
        // Capped like a requested list, so a lead with many tools yields a worker with the first few.
        return { tools: leadTools.slice(0, SUB_AGENT_MAX_TOOLS) };
    }

    const available = new Set(leadTools);
    const missing = requested.find((name) => !available.has(name));

    return missing === undefined
        ? { tools: [...requested] }
        : { error: `A worker cannot use ${missing.slice(0, 64)}: this conversation does not have that tool.` };
};

/**
 * Narrows a built tool set to an allowlist. It only ever removes: a name the
 * set does not contain (off, unavailable, `ask` in a headless run) stays absent.
 */
export const applyToolAllowlist = (tools: ToolSet, allowlist: ReadonlyArray<string> | undefined): ToolSet => {
    if (allowlist === undefined) {
        return tools;
    }

    const allowed = new Set(allowlist);

    return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name)));
};

export const SUB_AGENT_SYSTEM = `You are a sub-agent: another assistant delegated one task to you and is not watching while you work.
Complete the task on your own, using your tools where they help. You cannot ask anyone questions — make reasonable assumptions and state them.
Finish with a self-contained answer: the result first, then the key details, sources and any assumptions. It is posted back to the conversation that delegated the task.`;

/** The system text of a worker run: the same headless loop, but the thread is the worker's and it is messaged again. */
export const WORKER_SYSTEM = `You are a worker: a long-lived agent that the user, or another assistant, messages again and again in this thread.
Messages arrive one at a time, and the thread holds everything said so far, so use it. You cannot ask anyone questions mid-run — make reasonable assumptions and state them.
Finish each message with a self-contained answer: the result first, then the key details, sources and any assumptions.`;

export const buildSubAgentPrompt = (task: string): string => `Task delegated to you:\n\n${task}`;

/**
 * The model the child runs on: the invoked skill's preferred model when it has
 * one and it is allowed, else the parent's model when allowed, else the default.
 * `isAllowed` is the task rule (`tasks/logic.ts:isTaskModelAllowed`).
 */
export const resolveSubAgentModel = (input: {
    defaultModel: string;
    isAllowed: (modelId: string) => boolean;
    parentModel?: string;
    preferredModel?: string;
}): string => {
    for (const candidate of [input.preferredModel, input.parentModel]) {
        if (candidate && input.isAllowed(candidate)) {
            return candidate;
        }
    }

    return input.defaultModel;
};

export const truncateResult = (text: string): string => (text.length > SUB_AGENT_RESULT_MAX ? `${text.slice(0, SUB_AGENT_RESULT_MAX - 1)}…` : text);

/**
 * The stop condition that ends a sub-agent's loop once `isStopRequested` says
 * so. The agent client evaluates a condition twice per step (once to decide
 * whether to open a pending message, once inside the AI SDK), so the answer is
 * read once per step count and reused — the two must agree, or a cancel landing
 * between them leaves a pending message behind.
 */
export const stopWhenRequested = (isStopRequested: () => Promise<boolean>): StopCondition<any, any> => {
    let answered: { steps: number; stop: boolean } | undefined;

    return async ({ steps }) => {
        if (answered?.steps !== steps.length) {
            answered = { steps: steps.length, stop: await isStopRequested() };
        }

        return answered.stop;
    };
};

/**
 * Whether a run's loop may still write into the worker's thread: it is running, or it was stopped
 * while running and has not exited yet (`loopExitedAt` is set when `completeRun` or the reaper sees it
 * gone). A run cancelled while queued never started a loop.
 */
export const isWorkerLoopLive = (run: { loopExitedAt?: number; startedAt?: number; status: SubAgentStatus }): boolean =>
    run.status === "running" || (run.status === "cancelled" && run.startedAt !== undefined && run.loopExitedAt === undefined);

/**
 * The run that starts next on a worker, from its runs newest first: the oldest queued one, or none
 * while a loop is live. A worker runs one message at a time, in the order they were sent
 * (`latestWorkerRuns` sorts by `createdAt`, which admission makes strictly increasing per worker).
 */
export const nextQueuedWorkerRun = <T extends { loopExitedAt?: number; startedAt?: number; status: SubAgentStatus }>(
    newestFirst: ReadonlyArray<T>,
): T | undefined => (newestFirst.some((run) => isWorkerLoopLive(run)) ? undefined : newestFirst.findLast((run) => run.status === "queued"));

/** The run a worker is on, from its runs newest first: the one going, else the next in line. A Stop in its thread means this one. */
export const workerCurrentRun = <T extends { status: SubAgentStatus }>(newestFirst: ReadonlyArray<T>): T | undefined =>
    newestFirst.find((run) => run.status === "running") ?? newestFirst.findLast((run) => run.status === "queued");

/**
 * Why the lead never got the worker's latest result, from its runs newest first: the newest run the
 * lead asked for that gave up posting, unless a later one of them posted. Null when none did.
 */
export const workerPostFailure = (
    newestFirst: ReadonlyArray<{ mode?: "run" | "worker"; postFailed?: string; resultPostedAt?: number; toolCallId?: string }>,
): string | null => {
    for (const run of newestFirst) {
        if (!postsBack(run)) {
            continue;
        }

        if (run.postFailed !== undefined) {
            return run.postFailed;
        }

        if (run.resultPostedAt !== undefined) {
            return null;
        }
    }

    return null;
};

/**
 * How a message sent to a busy worker is handled, read from what its runner can do. Cloud headless
 * workers have no stream to steer into, so theirs wait their turn; a host runner reports its own
 * capabilities (host workers come later) and reads as `none` until it does.
 */
export const workerFollowUp = (runner: { kind: "headless" | "host" } | undefined): FollowUpControl =>
    runner === undefined || runner.kind === "headless" ? followUpControl(CLOUD_HEADLESS_CAPABILITIES) : "none";

/**
 * How many children a parent has started over its life, for the depth > 1 cap. A worker counts once
 * however often it was messaged; a one-shot run, or one with no thread yet, counts itself.
 */
export const distinctChildCount = (runs: ReadonlyArray<{ _id: string; childThreadId?: string }>): number =>
    new Set(runs.map((run) => run.childThreadId ?? run._id)).size;

/** The follow-up message posted to the parent thread when a run ends. */
export const buildResultMessage = (input: {
    childThreadId?: string;
    error?: string;
    result?: string;
    /** Whether the run had been claimed — a cancelled one that had not ran nothing. */
    started?: boolean;
    status: "cancelled" | "failed" | "succeeded";
    task: string;
}): string => {
    const taskLine = input.task.split("\n", 1)[0]?.trim().slice(0, 160) ?? "";
    const heading = {
        cancelled: `**Sub-agent stopped:** ${taskLine}`,
        failed: `**Sub-agent failed:** ${taskLine}`,
        succeeded: `**Sub-agent finished:** ${taskLine}`,
    }[input.status];
    let body: string;

    if (input.status === "succeeded") {
        body = input.result?.trim() || "(The sub-agent returned no text.)";
    } else if (input.status === "cancelled") {
        body = input.started
            ? "This sub-agent was stopped before it finished. The step it was working on when it was stopped still ran to its end and was billed; no further steps ran. Its work so far is in its thread."
            : "This sub-agent was stopped before it started, so nothing ran.";
    } else {
        body = input.error ?? "The sub-agent stopped without a result.";
    }

    const link = input.childThreadId ? `\n\n[Open the sub-agent's thread](/chat/${input.childThreadId})` : "";

    return `${heading}\n\n${body}${link}`;
};
