/**
 * Goals, tasks and runs leave with the account and travel with the export —
 * the deleted user's only, and past one batch (30 > 25, not a multiple of 100
 * either, so "deleted one page" cannot pass for "deleted everything").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { collectTasksForExport, deleteUserTasks } from "./gdpr";

type Harness = ReturnType<typeof lunoraTest>;

const A = "user-a";
const B = "user-b";
const MANY = 130;

let harness: Harness;

const seed = async (userId: string, count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        const goalId = await ctx.db.insert("goals", { createdAt: 1, status: "active", title: "Goal", updatedAt: 1, userId });

        for (let index = 0; index < count; index += 1) {
            const taskId = await ctx.db.insert("tasks", {
                activeCycle: "secret-cycle",
                attemptCount: 1,
                createdAt: 1,
                dependsOn: [],
                goalId,
                instructions: "Do it",
                maxRepairRounds: 2,
                recurring: false,
                status: "done",
                title: `Task ${String(index)}`,
                updatedAt: 1,
                userId,
            });

            await ctx.db.insert("taskRuns", { cycle: "secret-cycle", origin: "manual", round: 0, startedAt: 1, status: "passed", taskId, userId });
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

describe("tasks in GDPR flows", () => {
    it("deletes every goal, task and run of the user and nobody else's", async () => {
        await seed(A, MANY);
        await seed(B, 1);

        let rounds = 0;

        for (; rounds < 100; rounds += 1) {
            const { hasMore } = await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserTasks, { userId: A }));

            if (!hasMore) {
                break;
            }
        }

        expect(rounds).toBeGreaterThan(0);

        for (const table of ["goals", "tasks", "taskRuns"]) {
            expect(await countFor(table, A), table).toBe(0);
            expect(await countFor(table, B), table).toBe(1);
        }
    });

    it("exports the user's tasks with their runs, without internal cycle tokens", async () => {
        await seed(A, 2);
        await seed(B, 1);

        const exported = await harness.run(async (ctx: any) => await ctx.runQuery(collectTasksForExport, { userId: A }));

        expect(exported.goals).toHaveLength(1);
        expect(exported.tasks).toHaveLength(2);
        expect(exported.tasks[0].runs).toHaveLength(1);
        expect(JSON.stringify(exported)).not.toContain("secret-cycle");
    });
});

describe("tasks in the deletion workflow", () => {
    // Read from source: the workflow needs a Cloudflare Workflows runtime to run.
    const source = readFileSync(join(import.meta.dirname, "../gdpr/workflows/deletion-workflow.ts"), "utf8");
    const stepAt = (name: string): number => {
        const index = source.indexOf(`"${name}"`);

        expect(index, name).toBeGreaterThan(-1);

        return index;
    };

    it("removes tasks before any step a task round could write behind", () => {
        const stop = stepAt("stop-user-tasks");

        expect(source.slice(stop - 200, stop + 200)).toContain("internal.tasks.gdpr.deleteUserTasks");

        for (const later of ["delete-user-thread-metadata", "delete-user-thread-cascade", "delete-user-documents", "delete-user-memories"]) {
            expect(stop, later).toBeLessThan(stepAt(later));
        }
    });
});
