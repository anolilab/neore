/**
 * The eval runner's state machine against a real (in-memory) database: a case
 * is claimed once, completion advances the run and schedules the next case, the
 * last case finishes the run with its aggregate, a cancelled run records a late
 * result without scheduling more, the reaper fails a case that stopped
 * reporting, and a claim is refused past the cost cap, past a daily limit, for
 * an anonymous account and for a deleted case (skipped, run moves on).
 *
 * Scheduled jobs are only inspected, never run — `runEvalCase` would call a model.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { ANONYMOUS_EVALS_MESSAGE, claimCase, completeCase, EVAL_DAILY_LIMIT_MESSAGE, reapCase, TOKEN_BUDGET_MESSAGE } from "./internal";

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
const { users } = vi.hoisted(() => {
    return { users: new Map<string, { isAnonymous?: boolean; role?: string }>() };
});

vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

const USER = "user-a";

let harness: Harness;

const run = async <T>(callback: (ctx: any) => Promise<T>): Promise<T> => await harness.run(callback);

const seedRun = async (
    options: { caseCount?: number; costCapMicrodollars?: number; costMicrodollars?: number; tokenBudget?: number } = {},
): Promise<{ caseIds: string[]; runId: string }> =>
    await run(async (ctx) => {
        const datasetId = await ctx.db.insert("evalDatasets", {
            caseCount: 0,
            createdAt: 1,
            judgeEnabled: true,
            kind: "agent",
            name: "Dataset",
            updatedAt: 1,
            userId: USER,
        });
        const caseIds: string[] = [];

        for (let index = 0; index < (options.caseCount ?? 2); index += 1) {
            caseIds.push(
                await ctx.db.insert("evalCases", {
                    checks: [{ kind: "contains", value: "x" }],
                    createdAt: index,
                    datasetId,
                    expectedSources: [],
                    input: `Question ${String(index)}`,
                    source: "manual",
                    updatedAt: index,
                    userId: USER,
                }),
            );
        }

        const runId = await ctx.db.insert("evalRuns", {
            caseIds,
            costCapMicrodollars: options.costCapMicrodollars ?? 1_000_000,
            costMicrodollars: options.costMicrodollars ?? 0,
            createdAt: 1,
            datasetId,
            datasetKind: "agent",
            judgeEnabled: true,
            nextIndex: 0,
            status: "running",
            target: { kind: "model", model: DEFAULT_CHAT_MODEL },
            tokenBudget: options.tokenBudget ?? 200_000,
            updatedAt: 1,
            userId: USER,
        });

        return { caseIds, runId };
    });

const claim = async (runId: string, index: number): Promise<any> => await run(async (ctx) => await ctx.runMutation(claimCase, { index, runId }));

const complete = async (resultId: string, outcome: Record<string, unknown>): Promise<unknown> =>
    await run(async (ctx) => await ctx.runMutation(completeCase, { outcome, resultId }));

const scored = (overrides: Record<string, unknown> = {}) => {
    return {
        answer: "x marks the spot",
        checks: [{ kind: "contains", pass: true, value: "x" }],
        costMicrodollars: 400,
        judge: { reasons: ["good"], score: 0.9 },
        kind: "scored",
        latencyMs: 120,
        passed: true,
        score: 0.95,
        ...overrides,
    };
};

const getDoc = async (id: string): Promise<any> => await run(async (ctx) => await ctx.db.get(id));

/** Rounds go on the jobs queue, not the scheduler (`lib/job-queue.ts`); the test stub records them. */
const caseJobs = (): { args: Record<string, unknown> }[] =>
    jobsQueueMessages
        .filter((message) => message.body.functionPath.includes("runEvalCase"))
        .map((message) => {
            return { args: message.body.args ?? {} };
        });

const resultCount = async (): Promise<number> =>
    await run(async (ctx) => {
        const rows = await ctx.db.query("evalResults").collect();

        return rows.length;
    });

beforeEach(() => {
    jobsQueueMessages.length = 0;
    harness = lunoraTest(schema as never);
    users.clear();
    users.set(USER, {});
});

afterEach(() => {
    harness.close();
});

describe("claimCase", () => {
    it("claims the next case once and hands over its definition", async () => {
        const { runId } = await seedRun();
        const first = await claim(runId, 0);

        expect(first).toMatchObject({ checks: [{ kind: "contains", value: "x" }], input: "Question 0", target: { kind: "model" }, userId: USER });
        expect(await claim(runId, 0)).toBeNull();
        // Not the run's next index.
        expect(await claim(runId, 1)).toBeNull();
        expect(await resultCount()).toBe(1);
        // The reaper is armed for the claimed case.
        expect(harness.scheduler.list().some((job) => job.functionPath?.includes("reapCase") === true)).toBe(true);
    });

    it("ends the run as cost_capped once it has spent its cap, without claiming", async () => {
        const { runId } = await seedRun({ costCapMicrodollars: 10_000, costMicrodollars: 10_000 });

        expect(await claim(runId, 0)).toBeNull();
        expect(await getDoc(runId)).toMatchObject({ status: "cost_capped", summary: { total: 2 } });
        expect(await resultCount()).toBe(0);
    });

    it("stops a run mid-way once completed cases push it past the cap", async () => {
        const { runId } = await seedRun({ caseCount: 3, costCapMicrodollars: 10_000 });
        const first = await claim(runId, 0);

        await complete(first.resultId, scored({ costMicrodollars: 12_000 }));

        expect(await getDoc(runId)).toMatchObject({ costMicrodollars: 12_000, nextIndex: 1, status: "running" });
        expect(await claim(runId, 1)).toBeNull();
        expect(await getDoc(runId)).toMatchObject({ status: "cost_capped", summary: { passed: 1, scored: 1, total: 3, totalCostMicrodollars: 12_000 } });
    });

    it("fails the run for an anonymous account", async () => {
        users.set(USER, { isAnonymous: true });
        const { runId } = await seedRun();

        expect(await claim(runId, 0)).toBeNull();
        expect(await getDoc(runId)).toMatchObject({ error: ANONYMOUS_EVALS_MESSAGE, status: "failed" });
    });

    it("charges each case to the daily limits and fails the run once they are spent", async () => {
        // `tasks/dailyRuns:free` (10/day) is the tighter limit for a free account.
        const { runId } = await seedRun({ caseCount: 12 });
        let claimed = 0;

        for (let index = 0; index < 12; index += 1) {
            const claimResult = await claim(runId, index);

            if (!claimResult) {
                break;
            }

            claimed += 1;
            await complete(claimResult.resultId, scored({ costMicrodollars: 0 }));
        }

        expect(claimed).toBe(10);
        expect(await getDoc(runId)).toMatchObject({ error: EVAL_DAILY_LIMIT_MESSAGE, status: "failed" });
    });

    it("records a case deleted since the run started as skipped and moves on", async () => {
        const { caseIds, runId } = await seedRun();

        await run(async (ctx) => await ctx.db.delete(caseIds[0]));

        expect(await claim(runId, 0)).toBeNull();

        const results = await run(async (ctx) => await ctx.db.query("evalResults").collect());

        expect(results).toMatchObject([{ index: 0, status: "skipped" }]);
        expect(await getDoc(runId)).toMatchObject({ nextIndex: 1, status: "running" });
        expect(caseJobs().at(-1)?.args).toMatchObject({ index: 1 });
    });
});

describe("token budget", () => {
    /** A scored outcome that reported no cost at all — the user's own key, no gateway pricing. */
    const unpriced = (tokens: number) => Object.fromEntries(Object.entries(scored({ tokens })).filter(([key]) => key !== "costMicrodollars"));

    it("stops a run whose unpriced tokens reach the budget, though its dollar cap is untouched", async () => {
        const { runId } = await seedRun({ caseCount: 3, tokenBudget: 10_000 });
        const first = await claim(runId, 0);

        await complete(first.resultId, unpriced(12_000));

        expect(await getDoc(runId)).toMatchObject({ costMicrodollars: 0, status: "running", unpricedTokens: 12_000 });
        expect(await getDoc(first.resultId)).toMatchObject({ tokens: 12_000 });
        expect(await claim(runId, 1)).toBeNull();
        expect(await getDoc(runId)).toMatchObject({ error: TOKEN_BUDGET_MESSAGE, status: "cost_capped" });
    });

    it("does not count the tokens of priced cases", async () => {
        const { runId } = await seedRun({ tokenBudget: 10_000 });
        const first = await claim(runId, 0);

        await complete(first.resultId, scored({ tokens: 50_000 }));

        expect(await getDoc(runId)).toMatchObject({ costMicrodollars: 400, unpricedTokens: 0 });
        expect(await claim(runId, 1)).not.toBeNull();
    });

    it("takes the runner's per-call count, so a priced judge cannot hide an unpriced agent", async () => {
        const { runId } = await seedRun({ tokenBudget: 10_000 });
        const first = await claim(runId, 0);

        await complete(first.resultId, scored({ tokens: 20_000, unpricedTokens: 15_000 }));

        expect(await getDoc(runId)).toMatchObject({ unpricedTokens: 15_000 });
        expect(await claim(runId, 1)).toBeNull();
    });

    it("estimates a reaped case from its text, so even a case that reports nothing is bounded", async () => {
        const { runId } = await seedRun();
        const first = await claim(runId, 0);

        await run(async (ctx) => await ctx.runMutation(reapCase, { resultId: first.resultId }));

        // "Question 0" is 10 characters: ceil(10 / 4).
        expect(await getDoc(runId)).toMatchObject({ unpricedTokens: 3 });
    });
});

describe("completeCase", () => {
    it("advances to the next case, then finishes the run with its aggregate", async () => {
        const { runId } = await seedRun();
        const first = await claim(runId, 0);

        await complete(first.resultId, scored());

        expect(await getDoc(runId)).toMatchObject({ costMicrodollars: 400, nextIndex: 1, status: "running" });
        expect(caseJobs().at(-1)?.args).toMatchObject({ index: 1, runId });

        const second = await claim(runId, 1);

        await complete(second.resultId, { error: "boom", kind: "error" });

        const finished = await getDoc(runId);

        expect(finished).toMatchObject({ nextIndex: 2, status: "completed" });
        expect(finished.summary).toMatchObject({ errored: 1, passed: 1, passRate: 1, scored: 1, total: 2, totalCostMicrodollars: 400 });
        expect(finished.completedAt).toBeTypeOf("number");
    });

    it("ignores a duplicate completion", async () => {
        const { runId } = await seedRun();
        const first = await claim(runId, 0);

        await complete(first.resultId, scored());
        await complete(first.resultId, scored({ costMicrodollars: 9999 }));

        expect(await getDoc(runId)).toMatchObject({ costMicrodollars: 400, nextIndex: 1 });
        expect(caseJobs()).toHaveLength(1);
    });

    it("records a case that lands after a cancel without scheduling more", async () => {
        const { runId } = await seedRun();
        const first = await claim(runId, 0);

        await run(async (ctx) => await ctx.db.patch(runId, { status: "cancelled" }));
        await complete(first.resultId, scored());

        expect(await getDoc(first.resultId)).toMatchObject({ status: "scored" });
        expect(await getDoc(runId)).toMatchObject({ costMicrodollars: 400, status: "cancelled", summary: { scored: 1 } });
        expect(caseJobs()).toHaveLength(0);
    });
});

describe("reapCase", () => {
    it("fails a case that stopped reporting and moves the run on; a late completion is then ignored", async () => {
        const { runId } = await seedRun();
        const first = await claim(runId, 0);

        await run(async (ctx) => await ctx.runMutation(reapCase, { resultId: first.resultId }));

        expect(await getDoc(first.resultId)).toMatchObject({ error: "The case stopped responding and was abandoned.", status: "error" });
        expect(await getDoc(runId)).toMatchObject({ nextIndex: 1 });

        await complete(first.resultId, scored());

        expect(await getDoc(first.resultId)).toMatchObject({ status: "error" });
        expect(caseJobs()).toHaveLength(1);
    });

    it("leaves a finished case alone", async () => {
        const { runId } = await seedRun();
        const first = await claim(runId, 0);

        await complete(first.resultId, scored());
        await run(async (ctx) => await ctx.runMutation(reapCase, { resultId: first.resultId }));

        expect(await getDoc(first.resultId)).toMatchObject({ status: "scored" });
    });
});
