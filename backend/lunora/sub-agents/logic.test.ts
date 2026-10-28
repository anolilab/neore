import { describe, expect, it } from "vitest";

import {
    applyToolAllowlist,
    buildResultMessage,
    canNest,
    dispatchSourceProblem,
    originOfRun,
    nextQueuedWorkerRun,
    normalizeToolAllowlist,
    postsBack,
    resolveSubAgentModel,
    runDelivery,
    SUB_AGENT_MAX_CONCURRENT,
    SUB_AGENT_MAX_DEPTH,
    SUB_AGENT_MAX_PER_RUN,
    SUB_AGENT_MAX_TOOLS,
    SUB_AGENT_RESULT_MAX,
    SUB_AGENT_STALE_MS,
    SUB_WORKER_QUIET_MS,
    stopWhenRequested,
    subAgentCapProblem,
    truncateResult,
    workerCurrentRun,
    workerFollowUp,
    workerPostFailure,
    workerReapDecision,
    workerRunToStop,
} from "./logic";

const NOT_ACCEPTED = /does not accept/u;
const HOST_WORKER = /host worker/u;
const DEPTH_CAP = /at most 2 levels/u;
const FAN_OUT_CAP = /At most 3 sub-agents/u;
const PER_RUN_CAP = /at most 5 sub-agents of its own/u;

describe(subAgentCapProblem, () => {
    it("allows delegation from a user's thread and from a first-level sub-agent", () => {
        expect(subAgentCapProblem({ activeChildren: 0, parentDepth: 0 })).toBeUndefined();
        expect(subAgentCapProblem({ activeChildren: 0, parentDepth: SUB_AGENT_MAX_DEPTH - 1 })).toBeUndefined();
    });

    it("refuses a sub-agent past the depth cap", () => {
        expect(SUB_AGENT_MAX_DEPTH).toBe(2);
        expect(subAgentCapProblem({ activeChildren: 0, parentDepth: SUB_AGENT_MAX_DEPTH })).toMatch(DEPTH_CAP);
    });

    it("refuses a fourth concurrent child and allows the third", () => {
        expect(SUB_AGENT_MAX_CONCURRENT).toBe(3);
        expect(subAgentCapProblem({ activeChildren: SUB_AGENT_MAX_CONCURRENT - 1, parentDepth: 0 })).toBeUndefined();
        expect(subAgentCapProblem({ activeChildren: SUB_AGENT_MAX_CONCURRENT, parentDepth: 0 })).toMatch(FAN_OUT_CAP);
    });
});

describe("subAgentCapProblem per run", () => {
    it("caps the children a sub-agent run starts in total, not a user's own thread", () => {
        expect(subAgentCapProblem({ activeChildren: 0, parentDepth: 1, totalChildren: SUB_AGENT_MAX_PER_RUN - 1 })).toBeUndefined();
        expect(subAgentCapProblem({ activeChildren: 0, parentDepth: 1, totalChildren: SUB_AGENT_MAX_PER_RUN })).toMatch(PER_RUN_CAP);
        expect(subAgentCapProblem({ activeChildren: 0, parentDepth: 0, totalChildren: 100 })).toBeUndefined();
    });
});

describe(normalizeToolAllowlist, () => {
    it("keeps no list as no list", () => {
        expect(normalizeToolAllowlist(undefined)).toStrictEqual({ tools: undefined });
    });

    it("trims and de-duplicates", () => {
        expect(normalizeToolAllowlist([" webSearch ", "webSearch", "", "retrieve"])).toStrictEqual({ tools: ["webSearch", "retrieve"] });
    });

    it("refuses too many names and invalid ones", () => {
        expect(normalizeToolAllowlist(Array.from({ length: SUB_AGENT_MAX_TOOLS + 1 }, (_, index) => `tool${String(index)}`))).toHaveProperty("error");
        expect(normalizeToolAllowlist(["web search"])).toHaveProperty("error");
    });
});

describe(applyToolAllowlist, () => {
    const tools = { askUser: {}, retrieve: {}, webSearch: {} } as never;

    it("narrows to the list and never adds a tool the set lacks", () => {
        expect(Object.keys(applyToolAllowlist(tools, ["webSearch", "shellExecution"]))).toStrictEqual(["webSearch"]);
    });

    it("leaves the set alone without a list, and empties it for an empty one", () => {
        expect(Object.keys(applyToolAllowlist(tools, undefined))).toHaveLength(3);
        expect(Object.keys(applyToolAllowlist(tools, []))).toHaveLength(0);
    });
});

describe(resolveSubAgentModel, () => {
    const isAllowed = (id: string) => id !== "retired-model";

    it("prefers the skill's model, then the parent's, then the default", () => {
        expect(resolveSubAgentModel({ defaultModel: "default", isAllowed, parentModel: "parent", preferredModel: "skill" })).toBe("skill");
        expect(resolveSubAgentModel({ defaultModel: "default", isAllowed, parentModel: "parent" })).toBe("parent");
        expect(resolveSubAgentModel({ defaultModel: "default", isAllowed })).toBe("default");
    });

    it("skips a model that is no longer allowed", () => {
        expect(resolveSubAgentModel({ defaultModel: "default", isAllowed, parentModel: "retired-model", preferredModel: "retired-model" })).toBe("default");
    });
});

describe(buildResultMessage, () => {
    it("posts the result with a link to the child thread", () => {
        const text = buildResultMessage({ childThreadId: "child-1", result: "42", status: "succeeded", task: "Compute the answer\nwith care" });

        expect(text).toContain("**Sub-agent finished:** Compute the answer");
        expect(text).toContain("42");
        expect(text).toContain("[Open the sub-agent's thread](/chat/child-1)");
    });

    it("posts the error for a failed run, with no link when no thread was made", () => {
        const text = buildResultMessage({ error: "Quota exhausted", status: "failed", task: "Do it" });

        expect(text).toContain("**Sub-agent failed:** Do it");
        expect(text).toContain("Quota exhausted");
        expect(text).not.toContain("/chat/");
    });
});

describe("buildResultMessage for a cancelled run", () => {
    it("tells the parent a running sub-agent's last step still ran and was billed", () => {
        const text = buildResultMessage({ childThreadId: "child-1", started: true, status: "cancelled", task: "Do it" });

        expect(text).toContain("**Sub-agent stopped:** Do it");
        expect(text).toContain("was billed");
        expect(text).toContain("/chat/child-1");
    });

    it("says a queued one never ran", () => {
        expect(buildResultMessage({ started: false, status: "cancelled", task: "Do it" })).toContain("before it started, so nothing ran");
    });
});

describe(stopWhenRequested, () => {
    const steps = (count: number) => Array.from({ length: count }, () => ({}) as never);

    it("asks once per step count and reuses the answer for the second evaluation of that step", async () => {
        let asked = 0;
        let requested = false;
        const stop = stopWhenRequested(async () => {
            asked += 1;

            return requested;
        });

        expect(await stop({ steps: steps(1) })).toBe(false);

        requested = true;

        expect(await stop({ steps: steps(1) })).toBe(false);
        expect(asked).toBe(1);
        expect(await stop({ steps: steps(2) })).toBe(true);
        expect(asked).toBe(2);
    });
});

describe(truncateResult, () => {
    it("caps the stored result", () => {
        expect(truncateResult("x".repeat(SUB_AGENT_RESULT_MAX + 50))).toHaveLength(SUB_AGENT_RESULT_MAX);
        expect(truncateResult("short")).toBe("short");
    });
});

describe(canNest, () => {
    it("lets the user's thread and a first-level sub-agent delegate, not the deepest level", () => {
        expect(canNest(0)).toBe(true);
        expect(canNest(1)).toBe(true);
        expect(canNest(SUB_AGENT_MAX_DEPTH)).toBe(false);
    });
});

describe("a worker's line of messages", () => {
    const newestFirst = (...statuses: ("cancelled" | "queued" | "running" | "succeeded")[]) =>
        statuses.map((status, index) => {
            return { id: index, status };
        });

    it("starts the oldest queued run, and none while one is running", () => {
        expect(nextQueuedWorkerRun(newestFirst("queued", "queued", "succeeded"))).toMatchObject({ id: 1 });
        expect(nextQueuedWorkerRun(newestFirst("queued", "running"))).toBeUndefined();
        expect(nextQueuedWorkerRun(newestFirst("succeeded", "cancelled"))).toBeUndefined();
    });

    it("holds the line while a stopped run's loop has not exited, and releases it once it has", () => {
        const stopped = { startedAt: 1, status: "cancelled" as const };

        expect(
            nextQueuedWorkerRun([
                { id: 1, status: "queued" as const },
                { id: 0, ...stopped },
            ]),
        ).toBeUndefined();
        expect(
            nextQueuedWorkerRun([
                { id: 1, status: "queued" as const },
                { id: 0, ...stopped, loopExitedAt: 2 },
            ]),
        ).toMatchObject({ id: 1 });
        // Cancelled while queued: it never had a loop.
        expect(
            nextQueuedWorkerRun([
                { id: 1, status: "queued" as const },
                { id: 0, status: "cancelled" as const },
            ]),
        ).toMatchObject({ id: 1 });
    });

    it("names the running run as the current one, else the next in line", () => {
        expect(workerCurrentRun(newestFirst("queued", "queued", "running"))).toMatchObject({ id: 2 });
        expect(workerCurrentRun(newestFirst("queued", "queued", "succeeded"))).toMatchObject({ id: 1 });
        expect(workerCurrentRun(newestFirst("succeeded"))).toBeUndefined();
    });

    it("reports a failed post only while it is the newest run the lead asked for", () => {
        const asked = { mode: "worker", toolCallId: "call" } as const;
        const typed = { mode: "worker" } as const;

        expect(
            workerPostFailure([
                { ...asked, postFailed: "gone" },
                { ...asked, resultPostedAt: 1 },
            ]),
        ).toBe("gone");
        expect(
            workerPostFailure([
                { ...asked, resultPostedAt: 2 },
                { ...asked, postFailed: "gone" },
            ]),
        ).toBeNull();
        // A run the person typed is never owed a post, so it neither shows a failure nor hides one.
        expect(
            workerPostFailure([
                { ...typed, postFailed: "ignored" },
                { ...asked, postFailed: "gone" },
            ]),
        ).toBe("gone");
        expect(
            workerPostFailure([
                { ...typed, resultPostedAt: 3 },
                { ...asked, postFailed: "gone" },
            ]),
        ).toBe("gone");
        expect(workerPostFailure([asked, typed])).toBeNull();
        // A newer result still on its way may yet be delivered, so an older failure does not show.
        expect(workerPostFailure([asked, { ...asked, postFailed: "gone" }])).toBeNull();
    });

    it("queues a follow-up for a cloud worker and offers no steer", () => {
        expect(workerFollowUp({ kind: "headless" })).toBe("queue");
        expect(workerFollowUp(undefined)).toBe("queue");
    });
});

describe(postsBack, () => {
    it("owes the lead a result for every run but a worker run nobody delegated", () => {
        expect(postsBack({})).toBe(true);
        expect(postsBack({ mode: "run" })).toBe(true);
        expect(postsBack({ mode: "worker", toolCallId: "call-1" })).toBe(true);
        expect(postsBack({ mode: "worker" })).toBe(false);
    });
});

describe(workerReapDecision, () => {
    const startedAt = 1_000_000;
    const running = { startedAt, status: "running" } as const;

    it("keeps the quiet notice window inside the reaper's", () => {
        expect(SUB_WORKER_QUIET_MS).toBeLessThan(SUB_AGENT_STALE_MS);
    });

    it("leaves a run that is still writing past the old deadline and checks again when its window would end", () => {
        const lastActivityAt = startedAt + SUB_AGENT_STALE_MS;
        const now = lastActivityAt + 60_000;

        expect(workerReapDecision({ lastActivityAt, now, run: running })).toStrictEqual({ delayMs: SUB_AGENT_STALE_MS - 60_000, kind: "later" });
    });

    it("fails a run quiet for the whole window, measured from its claim when it never wrote", () => {
        expect(workerReapDecision({ lastActivityAt: undefined, now: startedAt + SUB_AGENT_STALE_MS, run: running })).toStrictEqual({ kind: "fail" });
        expect(workerReapDecision({ lastActivityAt: startedAt + 1, now: startedAt + SUB_AGENT_STALE_MS, run: running })).toMatchObject({ kind: "later" });
    });

    it("never reaps a queued run, or one that ended", () => {
        expect(workerReapDecision({ lastActivityAt: undefined, now: startedAt * 100, run: { status: "queued" } })).toStrictEqual({ kind: "skip" });
        expect(workerReapDecision({ lastActivityAt: undefined, now: startedAt * 100, run: { startedAt, status: "succeeded" } })).toStrictEqual({
            kind: "skip",
        });
        // Cancelled while queued: no loop ever ran.
        expect(workerReapDecision({ lastActivityAt: undefined, now: startedAt * 100, run: { status: "cancelled" } })).toStrictEqual({ kind: "skip" });
    });

    it("judges a stopped run whose loop has not exited like a running one, and skips it once it has", () => {
        expect(workerReapDecision({ lastActivityAt: undefined, now: startedAt + SUB_AGENT_STALE_MS, run: { startedAt, status: "cancelled" } })).toStrictEqual({
            kind: "fail",
        });
        expect(
            workerReapDecision({
                lastActivityAt: undefined,
                now: startedAt + SUB_AGENT_STALE_MS,
                run: { loopExitedAt: startedAt + 1, startedAt, status: "cancelled" },
            }),
        ).toStrictEqual({ kind: "skip" });
    });
});

describe(workerRunToStop, () => {
    it("is the run going, else the head of the queue, and nothing while a stopped loop unwinds", () => {
        const queuedHead = { status: "queued" } as const;
        const queuedTail = { status: "queued" } as const;
        const going = { startedAt: 1, status: "running" } as const;
        const unwinding = { startedAt: 1, status: "cancelled" } as const;
        const gone = { loopExitedAt: 2, startedAt: 1, status: "cancelled" } as const;

        expect(workerRunToStop([queuedTail, queuedHead, going])).toBe(going);
        expect(workerRunToStop([queuedTail, queuedHead])).toBe(queuedHead);
        expect(workerRunToStop([queuedTail, queuedHead, unwinding])).toBeUndefined();
        expect(workerRunToStop([queuedTail, queuedHead, gone])).toBe(queuedHead);
        expect(workerRunToStop([])).toBeUndefined();
    });
});

describe(runDelivery, () => {
    it("reads the receipt, a post that gave up, a post still waiting, and a result nobody asked for", () => {
        const asked = { mode: "worker", toolCallId: "call" } as const;

        expect(runDelivery({ ...asked, resultPostedAt: 1, status: "succeeded" })).toBe("posted");
        expect(runDelivery({ ...asked, postFailed: "gone", status: "succeeded" })).toBe("failed");
        expect(runDelivery({ ...asked, status: "failed" })).toBe("pending");
        expect(runDelivery({ ...asked, status: "running" })).toBe("none");
        expect(runDelivery({ mode: "worker", status: "succeeded" })).toBe("none");
    });
});

describe(dispatchSourceProblem, () => {
    it("admits the lead and the user by default and refuses every unattended source", () => {
        expect(dispatchSourceProblem({ source: "lead" })).toBeUndefined();
        expect(dispatchSourceProblem({ source: "user" })).toBeUndefined();

        for (const source of ["trigger", "messenger", "outside_agent"] as const) {
            expect(dispatchSourceProblem({ source })).toMatch(NOT_ACCEPTED);
        }
    });

    it("follows the policy, and never lets an outside agent reach a host worker", () => {
        const policy = { allowedSources: ["lead", "outside_agent"] } as const;

        expect(dispatchSourceProblem({ policy, runner: { kind: "headless" }, source: "outside_agent" })).toBeUndefined();
        expect(dispatchSourceProblem({ policy, runner: { kind: "host" }, source: "outside_agent" })).toMatch(HOST_WORKER);
        expect(dispatchSourceProblem({ policy, source: "user" })).toMatch(NOT_ACCEPTED);
    });
});

describe(originOfRun, () => {
    it("carries an unattended source down, and reads a person typing or an unrecorded one as the worker's own agent", () => {
        expect(originOfRun("trigger")).toBe("trigger");
        expect(originOfRun("outside_agent")).toBe("outside_agent");
        expect(originOfRun("user")).toBe("lead");
        expect(originOfRun(undefined)).toBe("lead");
    });
});
