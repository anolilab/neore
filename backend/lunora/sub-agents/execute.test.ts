/**
 * `runSubAgent` for a worker: every run continues the worker's one child thread, a user-typed
 * message is the prompt as written, and a redelivered job runs nothing. The agent run is faked;
 * claim, completion and the rest are the real procedures.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { admitWorkerRun } from "./functions";
import { WORKER_SYSTEM } from "./logic";

const { registry, runs } = vi.hoisted(() => {
    return { registry: new Map<string, unknown>(), runs: [] as Record<string, any>[] };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, any>) => {
            runs.push(options);

            return { text: `reply ${String(runs.length)}`, threadId: options.thread.threadId };
        },
    };
});

const { runSubAgent } = await import("./execute");

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let userId: string;
let leadId: string;

beforeAll(async () => {
    registerModule(registry, "sub_agents_functions", await import("./functions"));
    registerModule(registry, "tasks_internal", await import("../tasks/internal"));
});

beforeEach(async () => {
    runs.length = 0;
    harness = lunoraTest(schema as never);
    userId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: "u@example.com", emailVerified: true, name: "U", updatedAt: 0 }),
    )) as string;
    leadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Lead", userId }))) as string;
});

afterEach(() => {
    harness.close();
});

const dispatch = async (extra: Record<string, unknown>) => {
    const result = await harness.run(
        async (ctx: any) => await admitWorkerRun(ctx, { name: "Researcher", parentThreadId: leadId, task: "Look into it", userId, ...extra }),
    );

    if ("error" in result) {
        throw new Error(result.error);
    }

    return result.run as { _id: string; childThreadId: string };
};

const execute = async (runId: string) => await harness.action(async (ctx: any) => await ctx.runAction(runSubAgent, { runId }));

describe("a worker's runs", () => {
    it("continue one child thread: the lead's task is wrapped, the user's message is not, and the second sees the first's thread", async () => {
        const first = await dispatch({ toolCallId: "call-1" });

        await execute(first._id);

        const second = await dispatch({ childThreadId: first.childThreadId, clientId: "client-1", task: "What about the second part?" });

        await execute(second._id);

        expect(runs).toHaveLength(2);
        expect(runs[0]).toMatchObject({ prompt: expect.stringContaining("Look into it"), system: WORKER_SYSTEM, thread: { threadId: first.childThreadId } });
        expect(runs[0]!.prompt).not.toBe("Look into it");
        expect(runs[1]).toMatchObject({ prompt: "What about the second part?", system: WORKER_SYSTEM, thread: { threadId: first.childThreadId } });
        expect(second.childThreadId).toBe(first.childThreadId);

        const rows = (await harness.run(async (ctx: any) => await ctx.db.query("subAgentRuns").collect())) as { status: string }[];

        expect(rows.map((row) => row.status)).toStrictEqual(["succeeded", "succeeded"]);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("threads").collect())).toHaveLength(2);
    });

    it("runs on the worker thread's model, not the lead's", async () => {
        const first = await dispatch({ model: "anthropic/claude-sonnet-4", parentModel: "anthropic/claude-sonnet-4.5", toolCallId: "call-1" });

        await harness.run(async (ctx: any) => await ctx.db.patch(first.childThreadId, { model: "anthropic/claude-sonnet-4.5" }));
        await execute(first._id);

        expect(runs[0]!.model).toBe("anthropic/claude-sonnet-4.5");
    });

    it("runs a redelivered job once", async () => {
        const first = await dispatch({ toolCallId: "call-1" });

        await execute(first._id);
        await execute(first._id);

        expect(runs).toHaveLength(1);
    });
});
