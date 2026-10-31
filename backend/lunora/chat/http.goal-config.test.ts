/**
 * A goal's settings are checked against what every round will run with BEFORE the turn is charged and
 * saved: a send the goal cannot take is a 400 that costs nothing, not a 500 after the daily charge.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return { calls: [] as string[], charged: 0, startGoalArgs: undefined as Record<string, unknown> | undefined };
});

vi.mock("../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "user-a", isAnonymous: false };
        },
    };
});

vi.mock("../lib/thread-shard", () => {
    return { threadShardFor: async () => "user-a" };
});

vi.mock("../lib/http-shard", () => {
    return { inShard: async (ctx: unknown, _shard: string, run: (ctx: unknown) => Promise<Response>) => await run(ctx) };
});

vi.mock("./lib/daily-limit", () => {
    return {
        chargeDailyLimit: async () => {
            state.charged += 1;

            return { ok: true };
        },
    };
});

const { runChatStart } = await import("./http");

const context = () =>
    ({
        auth: { getIdentity: async () => null },
        runMutation: async (reference: { __lunoraRef?: string }, args?: Record<string, unknown>) => {
            const name = String(reference.__lunoraRef ?? reference);

            state.calls.push(name);

            if (name.includes("startGoal")) {
                state.startGoalArgs = args;

                return { error: "stop here", ok: false };
            }

            // The saved prompt row, so the request reaches the goal.
            if (name.includes("addMessages")) {
                return { messages: [{ _id: "message-1" }] };
            }

            return null;
        },
        runQuery: async (reference: { __lunoraRef?: string }) => {
            const name = String(reference.__lunoraRef ?? reference);

            state.calls.push(name);

            if (name.includes("gateThreadAction")) {
                return { isWorker: false, outcome: "ok" };
            }

            if (name.includes("getThreadInternal")) {
                return { _id: "thread-1", userId: "user-a" };
            }

            return null;
        },
    }) as never;

beforeEach(() => {
    state.calls = [];
    state.charged = 0;
    state.startGoalArgs = undefined;
});

describe("a goal's settings", () => {
    it("are refused with a 400 before the daily charge when a round could not run with them", async () => {
        const response = await runChatStart(
            context(),
            {
                goal: { text: "Ship the report" },
                model: "anthropic/claude-sonnet-4",
                prompt: "Make the report",
                // The gateway forwards the body unread: any string can arrive here.
                researchDepth: "exhaustive" as never,
                threadId: "thread-1",
            },
            "secret",
        );

        expect(response.status).toBe(400);
        expect(state.charged).toBe(0);
        expect(state.calls.some((name) => name.includes("startGoal"))).toBe(false);
    });

    it("are refused the same way for more feature names than a goal keeps", async () => {
        const response = await runChatStart(
            context(),
            {
                enabledFeatures: Array.from({ length: 101 }, (_, index) => `feature-${index}`),
                goal: { text: "Ship the report" },
                model: "anthropic/claude-sonnet-4",
                prompt: "Make the report",
                threadId: "thread-1",
            },
            "secret",
        );

        expect(response.status).toBe(400);
        expect(state.charged).toBe(0);
    });

    it("hand the trimmed goal on, so a padded goal within the limit cannot fail after the charge", async () => {
        await runChatStart(
            context(),
            { goal: { text: `  Ship the report${" ".repeat(2100)}` }, model: "anthropic/claude-sonnet-4", prompt: "Make the report", threadId: "thread-1" },
            "secret",
        ).catch(() => null);

        expect(state.startGoalArgs?.text).toBe("Ship the report");
    });
});
