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
import { _deletePageForThreadId, deleteAllForThreadIdAsync, softDeleteThread } from "../../agent/threads";
import {
    claimGoalRound,
    closeStaleGoalRound,
    endGoalsForThread,
    otherGoalHoldsThread,
    failGoalReview,
    getActiveGoalForRun,
    GOAL_STALL_MS,
    reapStalledGoals,
    recordGoalVerdict,
    roundTranscript,
    startGoal,
    touchGoal,
} from "./internal";
import { GOAL_MAX_COST_MICRODOLLARS } from "./logic";
import { GOAL_CONTINUATION_AGENT, parseGoalReviewNote } from "./shared";

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
const RUN_CONFIG = {
    autoMediaEnrichment: false,
    mcpServerNames: [],
    model: "m",
    researchDepth: "balanced",
    searchMode: "chat",
    shouldAutoContinue: true,
    toolNames: [],
};

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
const review = async (
    goalId: string,
    round: number,
    verdict: { cost?: number; lastMessage?: { id: string; order: number }; met: boolean; reason?: string; taintedBy?: string[] },
): Promise<any> => {
    const claimed = await run(claimGoalRound, { goalId, round });

    expect(claimed).not.toBeNull();

    return await run(recordGoalVerdict, {
        costMicrodollars: verdict.cost ?? 0,
        goalId,
        ...(verdict.lastMessage && { lastMessage: verdict.lastMessage }),
        met: verdict.met,
        reason: verdict.reason ?? "Not yet.",
        round,
        ...(verdict.taintedBy && { taintedBy: verdict.taintedBy }),
    });
};

/** Pushes a goal past the stall window, as an hour of silence would. */
const stall = async (goalId: string): Promise<void> => {
    await harness.run(async (ctx: any) => await ctx.db.patch(goalId, { updatedAt: Date.now() - GOAL_STALL_MS - 1000 }));
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
        // The run takes its prompt from the row's text; the reviewer's reason sits in a fenced note, not in the user's voice.
        expect(instruction.text).toContain("The charts are missing.");
        expect(instruction.text).not.toContain("Do that next");
        expect(parseGoalReviewNote(instruction.text)).toEqual({ reason: "The charts are missing.", taintedBy: [] });
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

    it("ends only the goal a failed run belonged to, never one that replaced it", async () => {
        const streamFor = async (messageId: string): Promise<string> =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("persistentStreams", {
                        createdAt: Date.now(),
                        messageId,
                        status: "streaming",
                        streamingConfig: { contentType: "text", model: "test-model" },
                        threadId,
                        userId: OWNER,
                    }),
            );
        const goalId = await start();
        // A run that answered an earlier prompt, before this goal replaced the one it belonged to.
        const earlier = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: "An older request", role: "user" },
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "An older request",
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const oldStream = await streamFor(String(earlier));

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(otherGoalHoldsThread, { streamId: oldStream, threadId }))).toBe(true);
        expect(await run(endGoalsForThread, { reason: "error", streamId: oldStream, threadId })).toBe(false);
        expect(await read(goalId)).toMatchObject({ status: "active" });

        // The goal's own run holds nothing against itself, and its failure ends it.
        const ownStream = await streamFor(promptId);

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(otherGoalHoldsThread, { streamId: ownStream, threadId }))).toBe(false);
        expect(await run(endGoalsForThread, { reason: "error", streamId: ownStream, threadId })).toBe(true);
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "error" });
    });

    it("recognises an approval continuation as its goal's own round, through the paused run's snapshot", async () => {
        const goalId = await start();
        const streamId = await harness.run(async (ctx: any) => {
            await ctx.db.insert("toolApprovalRuns", {
                approvalId: "approval-1",
                config: {
                    autoMediaEnrichment: false,
                    mcpServerNames: [],
                    model: "test-model",
                    promptMessageId: promptId,
                    researchDepth: "balanced",
                    searchMode: "auto",
                    shouldAutoContinue: true,
                    toolNames: [],
                },
                createdAt: Date.now(),
                status: "approved",
                threadId,
                userId: OWNER,
            });

            // `resumeClaimedRun` keys the continuation's stream on the approval id.
            return String(
                await ctx.db.insert("persistentStreams", {
                    createdAt: Date.now(),
                    messageId: "approval-1",
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "test-model" },
                    threadId,
                    userId: OWNER,
                }),
            );
        });

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(getActiveGoalForRun, { streamId, threadId }))).toMatchObject({ goalId });
        expect(await harness.run(async (ctx: any) => await ctx.runQuery(otherGoalHoldsThread, { streamId, threadId }))).toBe(false);
        expect(await run(endGoalsForThread, { reason: "error", streamId, threadId })).toBe(true);
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

describe("the instruction that opens the next round", () => {
    it("carries the taint of the tool results the round read", async () => {
        const goalId = await start();
        const outcome = await review(goalId, 1, { met: false, reason: "Check the page again.", taintedBy: ["web", "mcp"] });

        expect(parseGoalReviewNote((await read(outcome.next.messageId)).text)).toEqual({ reason: "Check the page again.", taintedBy: ["web", "mcp"] });
    });

    it("roundTranscript reports the taint of the round's tool results and its last row", async () => {
        const goalId = await start();
        const lastId = await harness.run(async (ctx: any) => {
            const base = { order: 0, status: "success", threadId, userId: OWNER };

            await ctx.db.insert("messages", {
                ...base,
                message: {
                    content: [{ output: { type: "text", value: "page text" }, toolCallId: "1", toolName: "webSearch", type: "tool-result" }],
                    role: "tool",
                },
                stepOrder: 1,
                tool: true,
            });

            return String(await ctx.db.insert("messages", { ...base, message: { content: "Done.", role: "assistant" }, stepOrder: 2, tool: false }));
        });
        const result = await harness.run(async (ctx: any) => await ctx.runQuery(roundTranscript, { goalId }));

        expect(result.taintedBy).toEqual(["web"]);
        expect(result.lastMessage).toEqual({ id: lastId, order: 0 });
    });
});

describe("the next round's settings", () => {
    it("keep the MCP servers the user picked for the goal", async () => {
        const goalId = await start({ config: { ...CONFIG, mcpServerNames: ["github"] } });

        expect(await review(goalId, 1, { met: false })).toMatchObject({ outcome: "continue" });

        const [stream] = await harness.run(async (ctx: any) => await ctx.db.query("persistentStreams").collect());

        expect(stream.streamingConfig.mcpServerNames).toEqual(["github"]);
    });
});

describe("a chat locked while its goal runs", () => {
    it("ends the goal instead of starting another round", async () => {
        const goalId = await start();

        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { lockedAt: Date.now() }));

        const outcome = await review(goalId, 1, { met: false });

        expect(outcome).toEqual({ outcome: "ended" });
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "user" });
        expect(await count("persistentStreams")).toBe(0);
    });
});

describe("a round whose branch was left", () => {
    /** The round's reply, then a sibling reply the user switched to. Returns both ids. */
    const branch = async (): Promise<{ other: string; reply: string }> =>
        await harness.run(async (ctx: any) => {
            const base = { order: 0, status: "success", threadId, tool: false, userId: OWNER };
            const reply = String(await ctx.db.insert("messages", { ...base, message: { content: "Draft.", role: "assistant" }, stepOrder: 1 }));
            const other = String(
                await ctx.db.insert("messages", { ...base, message: { content: "Other.", role: "assistant" }, parentMessageId: promptId, stepOrder: 2 }),
            );

            return { other, reply };
        });
    const setLeaf = async (leaf: string): Promise<void> => {
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: leaf }));
    };

    it("shows the reviewer only the branch on display", async () => {
        const { other, reply } = await branch();
        const goalId = await start();
        const transcript = async (): Promise<string> => (await harness.run(async (ctx: any) => await ctx.runQuery(roundTranscript, { goalId }))).transcript;

        await setLeaf(reply);

        expect(await transcript()).toContain("Draft.");
        expect(await transcript()).not.toContain("Other.");

        await setLeaf(other);

        expect(await transcript()).toContain("Other.");
        expect(await transcript()).not.toContain("Draft.");
    });

    it("continues while the displayed branch still ends at the round's last row", async () => {
        const { reply } = await branch();

        await setLeaf(reply);

        const goalId = await start();
        const outcome = await review(goalId, 1, { lastMessage: { id: reply, order: 0 }, met: false });

        expect(outcome.outcome).toBe("continue");
    });

    it("ends the goal, charges nothing and opens no stream once the thread shows another branch", async () => {
        const { other, reply } = await branch();
        const goalId = await start();

        await setLeaf(other);

        const outcome = await review(goalId, 1, { lastMessage: { id: reply, order: 0 }, met: false });

        expect(outcome).toEqual({ outcome: "ended" });
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "superseded" });
        expect(chargeRound).not.toHaveBeenCalled();
        expect(await count("persistentStreams")).toBe(0);
        expect((await read(threadId)).status).toBe("active");
    });

    it("does not record a win for a reply the thread no longer shows", async () => {
        const { other, reply } = await branch();
        const goalId = await start();

        await setLeaf(other);

        const outcome = await review(goalId, 1, { lastMessage: { id: reply, order: 0 }, met: true });

        expect(outcome).toEqual({ outcome: "ended" });
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "superseded" });
    });
});

describe("a goal whose thread is gone", () => {
    const deleteThread = async (): Promise<void> => {
        await harness.run(async (ctx: any) => await ctx.db.delete(threadId));
    };

    it("ends on a verdict without throwing", async () => {
        const goalId = await start();

        await deleteThread();

        expect(await review(goalId, 1, { met: true })).toEqual({ outcome: "ended" });
        expect(await read(goalId)).toMatchObject({ status: "met" });
    });

    it("ends instead of opening a round when the verdict says to go on", async () => {
        const goalId = await start();

        await deleteThread();

        expect(await review(goalId, 1, { met: false })).toEqual({ outcome: "ended" });
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "error" });
    });

    it("failGoalReview ends it without throwing", async () => {
        const goalId = await start();

        await run(claimGoalRound, { goalId, round: 1 });
        await deleteThread();

        expect(await run(failGoalReview, { goalId, reason: "review_failed", round: 1 })).toBe(true);
        expect(await read(goalId)).toMatchObject({ status: "stopped" });
    });

    it("does not stop the sweep from reaping the goals of other threads", async () => {
        const gone = await start();
        const otherThread = await harness.run(async (ctx: any) => String(await ctx.db.insert("threads", { status: "running", title: "Other", userId: OWNER })));
        const kept = await start({ threadId: otherThread });

        await stall(gone);
        await stall(kept);
        await deleteThread();

        expect(await run(reapStalledGoals, {})).toBe(2);
        expect(await read(gone)).toMatchObject({ status: "stopped", stopReason: "error" });
        expect(await read(kept)).toMatchObject({ status: "stopped", stopReason: "error" });
        expect((await read(otherThread)).status).toBe("active");
    });

    it("ends when the chat is moved to the trash, and a verdict that arrives after opens no round", async () => {
        const goalId = await start();

        await run(claimGoalRound, { goalId, round: 1 });
        await run(softDeleteThread, { threadId });

        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "user" });
        expect(await run(recordGoalVerdict, { costMicrodollars: 0, goalId, met: false, reason: "More.", round: 1 })).toEqual({ outcome: "ignored" });
        expect(await count("persistentStreams")).toBe(0);
    });

    it("treats a trashed chat as gone when a goal somehow outlives it", async () => {
        const goalId = await start();

        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { deleted: true, deletedAt: Date.now() }));

        expect(await review(goalId, 1, { met: false })).toEqual({ outcome: "ended" });
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "error" });
        expect(chargeRound).not.toHaveBeenCalled();
        expect(await count("persistentStreams")).toBe(0);
    });

    it("is removed with the thread, whatever its status", async () => {
        const active = await start();
        const ended = await start({ threadId });

        await run(endGoalsForThread, { reason: "user", threadId });
        await harness.run(async (ctx: any) => await ctx.runMutation(deleteAllForThreadIdAsync, { threadId }));

        expect(await read(active)).toBeNull();
        expect(await read(ended)).toBeNull();
        expect(await count("threadGoals")).toBe(0);
    });

    it("ends an active goal on the first page, before the rest of the thread goes", async () => {
        const goalId = await start();

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: [{ text: "Working on it.", type: "text" }], role: "assistant" },
                    order: 0,
                    status: "success",
                    stepOrder: 1,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        const page = await harness.run(async (ctx: any) => await ctx.runMutation(_deletePageForThreadId, { limit: 1, threadId }));

        expect(page.isDone).toBe(false);
        expect(await read(goalId)).toMatchObject({ status: "stopped", stopReason: "user" });
    });
});

describe("the sweep leaves a goal that is waiting", () => {
    const insertStream = async (status: string): Promise<void> => {
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: promptId,
                    status,
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId,
                    userId: OWNER,
                }),
        );
    };

    it.each(["pending", "streaming"])("on a %s stream", async (status) => {
        const goalId = await start();

        await stall(goalId);
        await insertStream(status);

        expect(await run(reapStalledGoals, {})).toBe(0);
        expect(await read(goalId)).toMatchObject({ status: "active" });
    });

    it("on a tool approval nobody has answered yet", async () => {
        const goalId = await start();

        await stall(goalId);
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: "a1",
                    config: RUN_CONFIG,
                    createdAt: Date.now(),
                    status: "pending",
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await run(reapStalledGoals, {})).toBe(0);
        expect(await read(goalId)).toMatchObject({ status: "active" });
    });

    it("on a pending approval that is newer than twenty answered ones", async () => {
        const goalId = await start();

        await stall(goalId);
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 21; index += 1) {
                // Distinct creation times: the pending one is the newest of the thread's approvals.
                await new Promise((resolve) => {
                    setTimeout(resolve, 2);
                });
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: `old-${String(index)}`,
                    config: RUN_CONFIG,
                    createdAt: 1000 + index,
                    status: index === 20 ? "pending" : "approved",
                    threadId,
                    userId: OWNER,
                });
            }
        });

        expect(await run(reapStalledGoals, {})).toBe(0);
        expect(await read(goalId)).toMatchObject({ status: "active" });
    });

    it("but still ends one whose approval was answered and whose run never came back", async () => {
        const goalId = await start();

        await stall(goalId);
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: "a1",
                    config: RUN_CONFIG,
                    createdAt: Date.now(),
                    status: "approved",
                    threadId,
                    userId: OWNER,
                }),
        );
        await insertStream("done");

        expect(await run(reapStalledGoals, {})).toBe(1);
    });

    it("touchGoal restarts a goal's stall clock", async () => {
        const goalId = await start();

        await stall(goalId);
        expect(await run(touchGoal, { threadId })).toBe(true);
        expect(await run(reapStalledGoals, {})).toBe(0);

        const quiet = await harness.run(async (ctx: any) => String(await ctx.db.insert("threads", { status: "active", title: "Quiet", userId: OWNER })));

        expect(await run(touchGoal, { threadId: quiet })).toBe(false);
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

describe("a goal's taint across rounds", () => {
    it("roundTranscript keeps the taint the round's instruction row carries when the round used no new tool", async () => {
        const goalId = await start();
        const outcome = await review(goalId, 1, { met: false, reason: "Check the page again.", taintedBy: ["web"] });

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("messages", {
                message: { content: "Nothing new.", role: "assistant" },
                order: 5,
                status: "success",
                stepOrder: 0,
                threadId,
                tool: false,
                userId: OWNER,
            });
        });

        const result = await harness.run(async (ctx: any) => await ctx.runQuery(roundTranscript, { goalId }));

        expect(outcome.outcome).toBe("continue");
        expect(result.taintedBy).toEqual(["web"]);
    });
});

describe("starting a goal while another is active", () => {
    it("ends the previous goal in the same transaction, so a later start is never ended by an earlier one", async () => {
        const first = await start();
        const second = await start();

        expect(await read(first)).toMatchObject({ status: "stopped", stopReason: "superseded" });
        expect(await read(second)).toMatchObject({ status: "active" });
    });
});

describe("a goal's queued round", () => {
    it("runs while its goal is still active at that round", async () => {
        const goalId = await start();
        const outcome = await review(goalId, 1, { met: false });

        expect(await run(closeStaleGoalRound, { messageId: outcome.next.messageId, streamId: outcome.next.streamId })).toBe(true);
        expect((await read(outcome.next.streamId)).status).toBe("pending");
    });

    it("does not run once a new message ended the goal, closes its stream and gives the thread back", async () => {
        const goalId = await start();
        const outcome = await review(goalId, 1, { met: false });

        await run(endGoalsForThread, { reason: "superseded", threadId });

        expect(await run(closeStaleGoalRound, { messageId: outcome.next.messageId, streamId: outcome.next.streamId })).toBe(false);
        expect((await read(outcome.next.streamId)).status).toBe("done");
        expect((await read(threadId)).status).toBe("active");
    });

    it("leaves the thread to a run that holds it", async () => {
        const goalId = await start();
        const outcome = await review(goalId, 1, { met: false });

        await run(endGoalsForThread, { reason: "superseded", threadId });
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: promptId,
                    status: "pending",
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await run(closeStaleGoalRound, { messageId: outcome.next.messageId, streamId: outcome.next.streamId })).toBe(false);
        expect((await read(threadId)).status).toBe("running");
    });

    it("hands a run off only to the goal whose current round it is", async () => {
        const goalId = await start();

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(getActiveGoalForRun, { messageId: promptId, threadId }))).toEqual({ goalId, round: 0 });
        expect(await harness.run(async (ctx: any) => await ctx.runQuery(getActiveGoalForRun, { messageId: "another-run", threadId }))).toBeNull();
    });
});
