/**
 * Eval datasets, cases, runs and results leave with the account and travel with
 * the export — the deleted user's only, and past one batch (130 > 100, and not a
 * multiple of it, so "deleted one page" cannot pass for "deleted everything").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { collectEvalsForExport, deleteUserEvals } from "./gdpr";

type Harness = ReturnType<typeof lunoraTest>;

const A = "user-a";
const B = "user-b";
const MANY = 130;
const TABLES = ["evalDatasets", "evalCases", "evalRuns", "evalResults"];

let harness: Harness;

const seed = async (userId: string, count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        const datasetId = await ctx.db.insert("evalDatasets", {
            caseCount: count,
            createdAt: 1,
            judgeEnabled: true,
            kind: "agent",
            name: "D",
            updatedAt: 1,
            userId,
        });
        const caseIds: string[] = [];

        for (let index = 0; index < count; index += 1) {
            caseIds.push(
                await ctx.db.insert("evalCases", {
                    checks: [],
                    createdAt: index,
                    datasetId,
                    expectedSources: [],
                    input: `q${String(index)}`,
                    source: "manual",
                    updatedAt: 1,
                    userId,
                }),
            );
        }

        const runId = await ctx.db.insert("evalRuns", {
            caseIds,
            costCapMicrodollars: 1,
            costMicrodollars: 0,
            createdAt: 1,
            datasetId,
            datasetKind: "agent",
            judgeEnabled: true,
            nextIndex: count,
            status: "completed",
            target: { kind: "model", model: "m" },
            updatedAt: 1,
            userId,
        });

        for (const [index, caseId] of caseIds.entries()) {
            await ctx.db.insert("evalResults", { caseId, checks: [], index, input: "q", runId, startedAt: 1, status: "scored", userId });
        }
    });
};

const countFor = async (table: string, userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const rows: { userId: string }[] = await ctx.db.query(table).collect();

        return rows.filter((row) => row.userId === userId).length;
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("evals in GDPR flows", () => {
    it("deletes every eval row of the user and nobody else's", async () => {
        await seed(A, MANY);
        await seed(B, 1);

        let rounds = 0;

        for (; rounds < 100; rounds += 1) {
            const { hasMore } = await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserEvals, { userId: A }));

            if (!hasMore) {
                break;
            }
        }

        expect(rounds).toBeGreaterThan(0);

        for (const table of TABLES) {
            expect(await countFor(table, A), table).toBe(0);
            expect(await countFor(table, B), table).toBe(1);
        }
    });

    it("exports the user's datasets with their cases, runs and results", async () => {
        await seed(A, 2);
        await seed(B, 1);

        const exported = await harness.run(async (ctx: any) => await ctx.runQuery(collectEvalsForExport, { userId: A }));

        expect(exported.datasets).toHaveLength(1);
        expect(exported.datasets[0].cases).toHaveLength(2);
        expect(exported.datasets[0].runs).toHaveLength(1);
        expect(exported.datasets[0].runs[0].results).toHaveLength(2);
        expect(JSON.stringify(exported)).not.toContain(B);
    });
});

describe("evals in the deletion workflow", () => {
    // Read from source: the workflow needs a Cloudflare Workflows runtime to run.
    const source = readFileSync(join(import.meta.dirname, "../gdpr/workflows/deletion-workflow.ts"), "utf8");
    const stepAt = (name: string): number => {
        const index = source.indexOf(`"${name}"`);

        expect(index, name).toBeGreaterThan(-1);

        return index;
    };

    it("removes evals before any step a case could write behind, and sweeps again late", () => {
        const stop = stepAt("stop-user-evals");

        expect(source.slice(stop - 50, stop + 200)).toContain("internal.evals.gdpr.deleteUserEvals");

        for (const later of ["delete-user-thread-metadata", "delete-user-thread-cascade", "delete-user-memories"]) {
            expect(stop, later).toBeLessThan(stepAt(later));
        }

        expect(stepAt("delete-user-evals")).toBeGreaterThan(stop);
    });
});
