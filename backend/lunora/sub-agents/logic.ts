/**
 * Sub-agents — the pure rules: caps, tool allowlists, the child's prompt, the
 * model it runs on and the message its result becomes. No I/O, so every rule
 * is unit-tested directly (`logic.test.ts`).
 */
import type { ToolSet } from "ai";

/**
 * How deep delegation may nest. A user's own thread is depth 0; its sub-agent
 * runs at 1, and that sub-agent's own sub-agent at 2 — the last level allowed.
 */
export const SUB_AGENT_MAX_DEPTH = 2;

/** Whether a run at `depth` may still delegate — below the cap. */
export const canNest = (depth: number): boolean => depth < SUB_AGENT_MAX_DEPTH;

/** The delegate tool's name (`chat/tools/delegate-to-sub-agent.ts`), kept here so this module stays import-free. */
export const SUB_AGENT_TOOL_NAME = "delegateToSubAgent";

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

/** The name the posted-back result carries in the parent thread. */
export const SUB_AGENT_NAME = "Sub-agent";

const TOOL_NAME_RE = /^[\w.:-]{1,128}$/;

export type SubAgentStatus = "failed" | "queued" | "running" | "succeeded";

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

/** The follow-up message posted to the parent thread when a run ends. */
export const buildResultMessage = (input: {
    childThreadId?: string;
    error?: string;
    result?: string;
    status: "failed" | "succeeded";
    task: string;
}): string => {
    const taskLine = input.task.split("\n", 1)[0]?.trim().slice(0, 160) ?? "";
    const heading = input.status === "succeeded" ? `**Sub-agent finished:** ${taskLine}` : `**Sub-agent failed:** ${taskLine}`;
    const body =
        input.status === "succeeded" ? input.result?.trim() || "(The sub-agent returned no text.)" : (input.error ?? "The sub-agent stopped without a result.");
    const link = input.childThreadId ? `\n\n[Open the sub-agent's thread](/chat/${input.childThreadId})` : "";

    return `${heading}\n\n${body}${link}`;
};
