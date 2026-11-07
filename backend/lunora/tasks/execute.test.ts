/**
 * Where a round runs: a new thread, the last run's thread ("continue"), or that thread after a divider
 * with no earlier turns sent ("fresh context"); and the task's reasoning effort reaching the run. The
 * claim, the agent run and the verifier are faked; which thread is decided by `pickRunThread`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mappedReferences } from "../../test/registered-api";

// A reference is read as its dispatch key (`<module>:<function>`), which the fake ctx below switches on.
vi.mock("../_generated/internal", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));

const state = vi.hoisted(() => {
    return {
        claim: null as Record<string, unknown> | null,
        mutations: [] as { args: Record<string, unknown>; name: string }[],
        runProject: null as Record<string, unknown> | null,
        runs: [] as Record<string, unknown>[],
        threadProblem: null as string | null,
    };
});

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, unknown>) => {
            state.runs.push(options);

            const thread = options.thread as { threadId?: string };
            const threadId = thread.threadId ?? "thread-new";

            if (!thread.threadId) {
                await (options.onThread as (id: string) => Promise<void>)(threadId);
            }

            return { text: "The weekly report.", threadId };
        },
    };
});

vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        loadModelFilterRules: async () => {
            return {};
        },
    };
});

vi.mock("../lib/services", () => {
    return {
        gatewayFetch: () => {
            return {};
        },
    };
});

vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
    };
});

vi.mock("ai", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("ai")>()),
        generateText: async () => {
            return { text: '{"pass": true, "reasons": ["ok"], "repairInstructions": ""}' };
        },
    };
});

const { runTaskRound } = await import("./execute");

const NAME_SUFFIX = (path: string): string => path.slice(path.lastIndexOf(":") + 1);

const ctx = () =>
    ({
        runMutation: async (path: string, args: Record<string, unknown>) => {
            const name = NAME_SUFFIX(path);

            state.mutations.push({ args, name });

            if (name === "claimRound") {
                return state.claim;
            }

            if (name === "appendContextReset") {
                return true;
            }

            return null;
        },
        runQuery: async (path: string) => {
            if (NAME_SUFFIX(path) === "canRunForUser") {
                return true;
            }

            if (NAME_SUFFIX(path) === "runThreadProblem") {
                return state.threadProblem;
            }

            if (NAME_SUFFIX(path) === "runProjectFor") {
                return state.runProject;
            }

            throw new Error(`unexpected query ${path}`);
        },
    }) as never;

const claimWith = (fields: Record<string, unknown>): Record<string, unknown> => {
    return { instructions: "Write the weekly report", runId: "run-2", title: "Weekly report", userId: "owner", ...fields };
};

const runRound = async (round = 0): Promise<void> => {
    await (runTaskRound as unknown as { handler: (ctx: unknown, args: unknown) => Promise<null> }).handler(ctx(), {
        cycle: "c2",
        origin: round > 0 ? "repair" : "schedule",
        round,
        taskId: "task-1",
    });
};

const names = (): string[] => state.mutations.map((mutation) => mutation.name);

beforeEach(() => {
    state.claim = null;
    state.mutations = [];
    state.runs = [];
    state.threadProblem = null;
    state.runProject = null;
});

describe("runTaskRound destination", () => {
    it("appends run 2 to run 1's thread when the task continues one thread", async () => {
        state.claim = claimWith({ continueThreadId: "thread-run-1" });

        await runRound();

        expect(state.runs).toHaveLength(1);
        expect(state.runs[0]).toMatchObject({ thread: { threadId: "thread-run-1" } });
        expect(state.runs[0]!.freshContext).toBeUndefined();
        expect(names()).not.toContain("appendContextReset");
        expect(state.mutations.find((mutation) => mutation.name === "completeRound")?.args).toMatchObject({ threadId: "thread-run-1" });
    });

    it("writes a divider and sends no earlier turns when the task keeps one thread with a fresh context", async () => {
        state.claim = claimWith({ contextDivider: true, continueThreadId: "thread-run-1", freshContext: true });

        await runRound();

        expect(names().indexOf("appendContextReset")).toBeLessThan(names().indexOf("completeRound"));
        expect(state.mutations.find((mutation) => mutation.name === "appendContextReset")?.args).toStrictEqual({ threadId: "thread-run-1", userId: "owner" });
        expect(state.runs[0]).toMatchObject({ freshContext: true, thread: { threadId: "thread-run-1" } });
    });

    it("sends a repair round of a fresh-context run no earlier turns, without a second divider", async () => {
        state.claim = claimWith({ continueThreadId: "thread-run-1", freshContext: true });

        await runRound(1);

        expect(names()).not.toContain("appendContextReset");
        expect(state.runs[0]).toMatchObject({ freshContext: true, thread: { threadId: "thread-run-1" } });
    });

    it("starts a new thread, filed in the task's project, when nothing is continued", async () => {
        state.claim = claimWith({ projectId: "project-a" });
        state.runProject = { projectId: "project-a" };

        await runRound();

        expect(state.runs[0]).toMatchObject({ thread: { tags: ["task"], title: "Task: Weekly report" } });
        expect(state.mutations.find((mutation) => mutation.name === "moveThreadToProject")?.args).toStrictEqual({
            projectId: "project-a",
            threadId: "thread-new",
        });
    });

    it("starts a new thread when the kept one changed since the claim, and records the precise reason", async () => {
        state.claim = claimWith({ contextDivider: true, continueThreadId: "thread-run-1", freshContext: true });
        state.threadProblem = "thread_locked";

        await runRound();

        expect(state.runs[0]).toMatchObject({ thread: { tags: ["task"] } });
        expect(state.runs[0]!.freshContext).toBeUndefined();
        expect(names()).not.toContain("appendContextReset");
        expect(state.mutations.find((mutation) => mutation.name === "recordRunNotice")?.args).toStrictEqual({
            cycle: "c2",
            reason: "thread_locked",
            taskId: "task-1",
        });
        // A lock passes: the task keeps its thread for the next run.
        expect(state.mutations.find((mutation) => mutation.name === "completeRound")?.args).toMatchObject({ keepLastThread: true });
    });

    it("states the attempt a repair round fixes unless it continues a thread that holds it", async () => {
        const repair = { previousAnswer: "Draft one", reasons: ["Missing totals"] };

        state.claim = claimWith({ continueThreadId: "thread-run-1", repair });
        await runRound(1);
        expect(state.runs[0]!.prompt).not.toContain("Draft one");

        // The kept thread was locked right before the write: the round runs in a new chat, which needs the attempt.
        state.runs = [];
        state.threadProblem = "thread_locked";
        await runRound(1);
        expect(state.runs[0]!.prompt).toContain("Draft one");
    });

    it("gives the run the project's own instructions, as a chat in the project gets them", async () => {
        state.claim = claimWith({ projectId: "project-a" });
        state.runProject = { context: "Write for the finance team.", projectId: "project-a" };

        await runRound();

        expect(state.runs[0]).toMatchObject({ system: "PROJECT CONTEXT:\nWrite for the finance team." });
    });

    it("files nothing and gives no instructions when the owner lost the project since the claim", async () => {
        state.claim = claimWith({ projectId: "project-a" });

        await runRound();

        expect(names()).not.toContain("moveThreadToProject");
        expect(state.runs[0]!.system).toBeUndefined();
    });

    it("hands the task's reasoning effort to the run", async () => {
        state.claim = claimWith({ reasoningEffort: 75 });

        await runRound();

        expect(state.runs[0]).toMatchObject({ reasoningEffort: 75 });
    });
});
