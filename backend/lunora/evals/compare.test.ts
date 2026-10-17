/** compareModels keeps a target whose newest finished run sits under hundreds of newer runs. */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { compareModels } from "./functions";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const USER = "user-a";

describe("compareModels", () => {
    it("includes a model whose newest finished run is older than 500 newer runs", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const { datasetId, oldRunId } = await harness.run(async (context: any) => {
                const dataset = await context.db.insert("evalDatasets", {
                    caseCount: 0,
                    createdAt: 1,
                    judgeEnabled: true,
                    kind: "agent",
                    name: "Dataset",
                    updatedAt: 1,
                    userId: USER,
                });
                const base = {
                    caseIds: [],
                    costCapMicrodollars: 1,
                    costMicrodollars: 0,
                    datasetId: dataset,
                    datasetKind: "agent",
                    judgeEnabled: true,
                    nextIndex: 0,
                    userId: USER,
                };
                const old = await context.db.insert("evalRuns", {
                    ...base,
                    createdAt: 1,
                    status: "completed",
                    target: { kind: "model", model: "old-model" },
                    updatedAt: 1,
                });

                for (let index = 0; index < 550; index += 1) {
                    await context.db.insert("evalRuns", {
                        ...base,
                        createdAt: 100 + index,
                        status: "completed",
                        target: { kind: "model", model: "new-model" },
                        updatedAt: 1,
                    });
                }

                return { datasetId: dataset, oldRunId: old };
            });

            const result: any = await harness.withIdentity({ userId: USER }).query(compareModels as never, { datasetId } as never);

            expect(result.runs).toHaveLength(2);
            expect(result.runs.map((run: any) => run.id ?? run._id)).toContain(oldRunId);
            expect(result.omittedTargets).toBe(0);
        } finally {
            harness.close();
        }
    });
});
