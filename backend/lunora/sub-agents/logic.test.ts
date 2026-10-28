import { describe, expect, it } from "vitest";

import {
    applyToolAllowlist,
    buildResultMessage,
    canNest,
    nextQueuedWorkerRun,
    normalizeToolAllowlist,
    postsBack,
    resolveSubAgentModel,
    SUB_AGENT_MAX_CONCURRENT,
    SUB_AGENT_MAX_DEPTH,
    SUB_AGENT_MAX_PER_RUN,
    SUB_AGENT_MAX_TOOLS,
    SUB_AGENT_RESULT_MAX,
    stopWhenRequested,
    subAgentCapProblem,
    truncateResult,
    workerCurrentRun,
    workerFollowUp,
    workerPostFailure,
} from "./logic";

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

    it("names the running run as the current one, else the next in line", () => {
        expect(workerCurrentRun(newestFirst("queued", "queued", "running"))).toMatchObject({ id: 2 });
        expect(workerCurrentRun(newestFirst("queued", "queued", "succeeded"))).toMatchObject({ id: 1 });
        expect(workerCurrentRun(newestFirst("succeeded"))).toBeUndefined();
    });

    it("reports a failed post of the newest run the lead asked for, until a later one of them posts", () => {
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
