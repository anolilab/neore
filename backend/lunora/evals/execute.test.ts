/**
 * A case needs the user's model filter rules only for its judge: with the judge off, an unreadable rules read must
 * not error the case or drop the results of its deterministic checks.
 */
import { lunoraTest } from "@lunora/testing";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { runEvalCase } from "./execute";

const { loadModelFilterRules, registry, runHeadlessAgent } = vi.hoisted(() => {
    return { loadModelFilterRules: vi.fn(), registry: new Map<string, unknown>(), runHeadlessAgent: vi.fn() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../chat/lib/model-filter-rules", () => {
    return { loadModelFilterRules };
});
vi.mock("../chat/lib/headless-run", () => {
    return { runHeadlessAgent };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            return { _id: userId };
        },
    };
});

const USER = "user-a";

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "evals_internal", await import("./internal"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    loadModelFilterRules.mockReset();
    runHeadlessAgent.mockReset();
});

const seed = async (judgeEnabled: boolean): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const datasetId = await ctx.db.insert("evalDatasets", {
            caseCount: 0,
            createdAt: 1,
            judgeEnabled,
            kind: "agent",
            name: "Dataset",
            updatedAt: 1,
            userId: USER,
        });
        const caseId = await ctx.db.insert("evalCases", {
            checks: [{ kind: "contains", value: "x" }],
            createdAt: 1,
            datasetId,
            expectedSources: [],
            input: "Question",
            source: "manual",
            updatedAt: 1,
            userId: USER,
        });

        return await ctx.db.insert("evalRuns", {
            caseIds: [caseId],
            costCapMicrodollars: 1_000_000,
            costMicrodollars: 0,
            createdAt: 1,
            datasetId,
            datasetKind: "agent",
            judgeEnabled,
            nextIndex: 0,
            status: "running",
            target: { kind: "model", model: DEFAULT_CHAT_MODEL },
            tokenBudget: 200_000,
            updatedAt: 1,
            userId: USER,
        });
    });

const resultOf = async (): Promise<string> => await harness.run(async (ctx: any) => JSON.stringify(await ctx.db.query("evalResults").collect()));

describe("runEvalCase when the model filter rules cannot be read", () => {
    it("scores a case by its checks when the judge is off", async () => {
        loadModelFilterRules.mockRejectedValue(new Error("rules unavailable"));
        runHeadlessAgent.mockResolvedValue({ text: "x marks the spot", threadId: "t1", totalTokens: 10 });
        const runId = await seed(false);

        await harness.action(async (ctx: any) => await ctx.runAction(runEvalCase, { index: 0, runId }));

        const result = await resultOf();

        expect(loadModelFilterRules).not.toHaveBeenCalled();
        expect(result).toContain('"status":"scored"');
        expect(result).not.toContain("judge model could not be reached");
    });
});
