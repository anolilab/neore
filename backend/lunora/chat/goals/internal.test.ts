/**
 * A goal's state machine against a real (in-memory) database: the verdict ends
 * a met goal and continues an unmet one with the reviewer's reason as the next
 * instruction, the round and cost caps end it, and a redelivered review claims,
 * charges and opens nothing a second time.
 */
/* eslint-disable unicorn/no-await-expression-member -- the assertions read one field of an awaited result */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../../schema";
import { chargeRound } from "../../tasks/account";
import { claimGoalRound, endGoalsForThread, failGoalReview, GOAL_STALL_MS, reapStalledGoals, recordGoalVerdict, roundTranscript, startGoal } from "./internal";
import { GOAL_MAX_COST_MICRODOLLARS } from "./logic";
import { GOAL_CONTINUATION_AGENT } from "./shared";

// `user` is a `.global()` (D1) table the in-memory harness cannot write, so the account behind each goal is looked up here.
const { users } = vi.hoisted(() => {
    return { users: new Map<string, { isAnonymous?: boolean; role?: string }>() };
});

vi.mock("../../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

vi.mock("../../tasks/account", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../tasks/account")>();

    return { ...original, chargeRound: vi.fn(original.chargeRound) };
});

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-1";
const CONFIG = { model: "test-model", searchMode: "chat" };

let harness: Harness;
let threadId: string;
let promptId: string;

const run = async (reference: unknown, args: Record<string, unknown>): Promise<any> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(reference, args));
const read = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));
const count = async (table: string): Promise<number> => await harness.run(async (ctx: any) => (await ctx.db.query(table).collect()).length);

const start = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const started = await run(startGoal, { config: CONFIG, promptMessageId: promptId, text: "Ship the report", threadId, userId: OWNER, ...overrides });

    expect(started.ok).toBe(true);

    return started.goalId;
};

/** Claims and records one round, the way the review job does. */
const review = async (goalId: string, round: number, verdict: { cost?: number; met: boolean; reason?: string }): Promise<any> => {
    const claimed = await run(claimGoalRound, { goalId, round });

    expect(claimed).not.toBeNull();

    return await run(recordGoalVerdict, { costMicrodollars: verdict.cost ?? 0, goalId, met: verdict.met, reason: verdict.reason ?? "Not yet.", round });
};

beforeEach(async () => {
    users.clear();
    users.set(OWNER, {});
    vi.mocked(chargeRound).mockClear();
    harness = lunoraTest(schema as never);

    ({ promptId, threadId } = await harness.run(async (ctx: any) => {
        const thread = await ctx.db.insert("threads", { status: "running", title: "Chat", userId: OWNER });
        const message = await ctx.db.insert("messages", {
            message: { content: "Make the report", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "Make the report",
            threadId: thread,
            tool: false,
            userId: OWNER,
        });

        return { promptId: String(message), threadId: String(thread) };
    }));
});

afterEach(() => {
    harness.close();
});

describe("startGoal", () => {
    it("opens an active goal with the default caps", async () => {
        const goal = await read(await start());

        expect(goal).toMatchObject({ maxCostMicrodollars: GOAL_MAX_COST_MICRODOLLARS, maxRounds: 5, round: 0, status: "active", text: "Ship the report" });
    });

    it("clamps the round cap to ten", async () => {
        expect((await read(await start({ maxRounds: 99 }))).maxRounds).toBe(10);
    });

    it("refuses an anonymous account, a goal in someone else's chat and an empty goal", async () => {
        users.set("guest", { isAnonymous: true });

        expect(await run(startGoal, { config: CONFIG, promptMessageId: promptId, text: "x", threadId, userId: "guest" })).toMatchObject({ ok: false });
        users.set("other", {});
        expect(await run(startGoal, { config: CONFIG, promptMessageId: promptId, text: "x", threadId, userId: "other" })).toMatchObject({ ok: false });
        expect(await run(startGoal, { config: CONFIG, promptMessageId: promptId, text: " ".repeat(3), threadId, userId: OWNER })).toMatchObject({ ok: false });
        expect(await count("threadGoals")).toBe(0);
    });
});

describe("recordGoalVerdict", () => {
    it("stops when the reviewer says the goal is met, and gives the thread back", async () => {
        const goalId = await start();
        const outcome = await review(goalId, 1, { met: true, reason: "The report is written." });

        expect(outcome).toEqual({ outcome: "ended" });

        const goal = await read(goalId);

        expect(goal).toMatchObject({ round: 1, status: "met" });
        expect(goal.verdicts).toMatchObject([{ met: true, reason: "The report is written.", round: 1 }]);
        expect((await read(threadId)).status).toBe("active");
        // No next round: one stream's worth of rows, none added.
        expect(await count("persistentStreams")).toBe(0);
        expect(chargeRound).not.toHaveBeenCalled();
    });

    it("continues when the goal is not met, with the reviewer's reason as the next instruction", async () => {
        const goalId = await start();
        const outcome = await review(goalId, 1, { met: false, reason: "The charts are missing." });

        expect(outcome.outcome).toBe("continue");

        const goal = await read(goalId);
        const instruction = await read(outcome.next.messageId);
        const stream = await read(outcome.next.streamId);

        expect(goal).toMatchObject({ promptMessageId: outcome.next.messageId, round: 1, startMessageId: promptId, status: "active" });
        expect(instruction.agentName).toBe(GOAL_CONTINUATION_AGENT);
        expect(instruction.message.role).toBe("user");
        // The run takes its prompt from the row's text.
        expect(instruction.text).toContain("The charts are missing.");
        expect(JSON.stringify(instruction.message.content)).toContain("The charts are missing.");
        expect(JSON.stringify(instruction.message.content)).toContain("Ship the report");
        expect(stream).toMatchObject({ messageId: outcome.next.messageId, status: "pending", threadId, userId: OWNER });
        expect(stream.streamingConfig).toMatchObject({ contentType: "text", model: "test-model", searchMode: "chat" });
        expect((await read(threadId)).status).toBe("running");
        // Charged once, for the round that is about to run.
        expect(chargeRound).toHaveBeenCalledTimes(1);
    });

    it("stops at the round cap with a round-limit note and opens no further round", async () => {
        const goalId = await start({ maxRounds: 2 });

        expect((await review(goalId, 1, { met: false })).outcome).toBe("continue");

        const last = await review(goalId, 2, { met: false });
        const goal = await read(goalId);

        expect(last).toEqual({ outcome: "ended" });
        expect(goal).toMatchObject({ round: 2, status: "stopped", stopReason: "round_limit" });
        expect(await count("persistentStreams")).toBe(1);
        expect(chargeRound).toHaveBeenCalledTimes(1);
        expect((await read(threadId)).status).toBe("active");
    });

    it("stops at the cost cap, counting what every round spent", async () => {
        const goalId = await start();

        expect((await review(goalId, 1, { cost: GOAL_MAX_COST_MICRODOLLARS - 1, met: false })).outcome).toBe("continue");

        const outcome = await review(goalId, 2, { cost: 1, met: false });
        const goal = await read(goalId);

        expect(outcome).toEqual({ outcome: "ended" });
        expect(goal).toMatchObject({ costMicrodollars: GOAL_MAX_COST_MICRODOLLARS, round: 2, status: "stopped", stopReason: "cost_limit" });
        expect(await count("persistentStreams")).toBe(1);
    });

    it("stops with a daily-limit note when the next round cannot be charged", async () => {
        vi.mocked(chargeRound).mockResolvedValueOnce(false);

        const goalId = await start();
        const outcome = await review(goalId, 1, { met: false });

        expect(outcome).toEqual({ outcome: "ended" });
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "daily_limit" });
        expect(await count("persistentStreams")).toBe(0);
    });

    it("runs nothing twice when the review is redelivered", async () => {
        const goalId = await start();
        const args = { costMicrodollars: 5, goalId, met: false, reason: "Add the charts.", round: 1 };

        expect(await run(claimGoalRound, { goalId, round: 1 })).not.toBeNull();
        // A second delivery of the same job: the claim is taken, so it never reaches the reviewer.
        expect(await run(claimGoalRound, { goalId, round: 1 })).toBeNull();

        const first = await run(recordGoalVerdict, args);
        // Even a delivery that got past the claim cannot record the round again.
        const second = await run(recordGoalVerdict, args);

        expect(first.outcome).toBe("continue");
        expect(second).toEqual({ outcome: "ignored" });
        expect(await count("persistentStreams")).toBe(1);
        expect(chargeRound).toHaveBeenCalledTimes(1);
        expect((await read(goalId)).verdicts).toHaveLength(1);
        expect((await read(goalId)).costMicrodollars).toBe(5);
        // The instruction row exists once: the prompt plus one continuation.
        expect(await count("messages")).toBe(2);
    });

    it("refuses a round out of turn, and a verdict nobody claimed", async () => {
        const goalId = await start();

        expect(await run(claimGoalRound, { goalId, round: 2 })).toBeNull();
        expect(await run(recordGoalVerdict, { costMicrodollars: 0, goalId, met: true, reason: "ok", round: 1 })).toEqual({ outcome: "ignored" });
        expect((await read(goalId)).status).toBe("active");
    });

    it("ignores a verdict that arrives after the goal was stopped", async () => {
        const goalId = await start();

        expect(await run(claimGoalRound, { goalId, round: 1 })).not.toBeNull();
        expect(await run(endGoalsForThread, { reason: "user", threadId })).toBe(true);
        expect(await run(recordGoalVerdict, { costMicrodollars: 0, goalId, met: false, reason: "More.", round: 1 })).toEqual({ outcome: "ignored" });
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "user" });
        expect(await count("persistentStreams")).toBe(0);
        expect(chargeRound).not.toHaveBeenCalled();
    });
});

describe("ending a goal from outside", () => {
    it("ends only the active goals of that thread", async () => {
        const goalId = await start();

        expect(await run(endGoalsForThread, { reason: "superseded", threadId })).toBe(true);
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "superseded" });
        expect(await run(endGoalsForThread, { reason: "user", threadId })).toBe(false);
    });

    it("failGoalReview ends the goal and gives the thread back, once", async () => {
        const goalId = await start();

        await run(claimGoalRound, { goalId, round: 1 });

        expect(await run(failGoalReview, { goalId, reason: "review_failed", round: 1 })).toBe(true);
        expect(await run(failGoalReview, { goalId, reason: "review_failed", round: 1 })).toBe(false);
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "review_failed" });
        expect((await read(threadId)).status).toBe("active");
    });

    it("the housekeeping sweep ends a goal whose round was lost", async () => {
        const goalId = await start();

        await harness.run(async (ctx: any) => await ctx.db.patch(goalId, { updatedAt: Date.now() - GOAL_STALL_MS - 1000 }));

        expect(await run(reapStalledGoals, {})).toBe(1);
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "error" });
        expect((await read(threadId)).status).toBe("active");
    });
});

describe("roundTranscript", () => {
    it("reads the rows after the round's prompt: text and tool results, priced", async () => {
        const goalId = await start();

        await harness.run(async (ctx: any) => {
            const base = { order: 0, status: "success", threadId, userId: OWNER };

            await ctx.db.insert("messages", {
                ...base,
                message: {
                    content: [
                        { text: "Searching.", type: "text" },
                        { input: { q: "SECRET" }, toolCallId: "1", toolName: "search", type: "tool-call" },
                    ],
                    role: "assistant",
                },
                providerMetadata: { neoreGateway: { costMicrodollars: 700 } },
                stepOrder: 1,
                tool: false,
            });
            await ctx.db.insert("messages", {
                ...base,
                message: { content: [{ output: { type: "text", value: "3 hits" }, toolCallId: "1", toolName: "search", type: "tool-result" }], role: "tool" },
                stepOrder: 2,
                tool: true,
            });
            await ctx.db.insert("messages", {
                ...base,
                message: { content: "Done.", role: "assistant" },
                providerMetadata: { neoreGateway: { costMicrodollars: 300 } },
                stepOrder: 3,
                tool: false,
            });
        });

        const result = await harness.run(async (ctx: any) => await ctx.runQuery(roundTranscript, { goalId }));

        expect(result.costMicrodollars).toBe(1000);
        expect(result.transcript).toBe("assistant: Searching.\n\ntool result (search): 3 hits\n\nassistant: Done.");
        expect(result.transcript).not.toContain("SECRET");
        expect(result.lastOrder).toBe(0);
    });
});
