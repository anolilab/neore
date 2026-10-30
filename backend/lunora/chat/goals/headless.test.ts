/* eslint-disable unicorn/no-await-expression-member -- the assertions read one field of an awaited result */
import { describe, expect, it, vi } from "vitest";

import { runHeadlessGoalRounds, stepsTranscript } from "./headless";
import { GOAL_MAX_COST_MICRODOLLARS } from "./logic";

const round = (text: string, costMicrodollars = 0) => {
    return { costMicrodollars, text, totalTokens: 10, transcript: `assistant: ${text}` };
};

const setup = (
    verdicts: { cost?: number; met: boolean; reason?: string }[],
    options: { charge?: boolean; goal?: { maxCostMicrodollars?: number; maxRounds?: number } } = {},
) => {
    const queue = [...verdicts];
    const review = vi.fn(async () => {
        const next = queue.shift() ?? { met: false };

        return { costMicrodollars: next.cost ?? 0, met: next.met, reason: next.reason ?? "Keep going." };
    });
    const runRound = vi.fn(async (prompt: string) => round(`round for: ${prompt.slice(0, 20)}`));
    const charge = vi.fn(async () => options.charge ?? true);

    return {
        charge,
        review,
        run: async (extra: Record<string, unknown> = {}) =>
            await runHeadlessGoalRounds({ charge, first: round("first"), goal: { text: "Ship it", ...options.goal }, review, runRound, ...extra }),
        runRound,
    };
};

describe("runHeadlessGoalRounds", () => {
    it("stops after one review when the goal is met, and runs and charges nothing more", async () => {
        const { charge, run, runRound } = setup([{ met: true, reason: "Done." }]);
        const outcome = await run();

        expect(outcome).toMatchObject({ ended: "met", reason: "Done.", rounds: 1 });
        expect(runRound).not.toHaveBeenCalled();
        expect(charge).not.toHaveBeenCalled();
    });

    it("continues with the reviewer's reason as the next instruction, charging each round", async () => {
        const { charge, run, runRound } = setup([
            { met: false, reason: "Add the charts." },
            { met: true, reason: "Charts added." },
        ]);
        const outcome = await run();

        expect(outcome).toMatchObject({ ended: "met", rounds: 2, totalTokens: 20 });
        expect(runRound).toHaveBeenCalledTimes(1);
        expect(runRound.mock.calls[0]![0]).toContain("Add the charts.");
        expect(runRound.mock.calls[0]![0]).toContain("Ship it");
        expect(charge).toHaveBeenCalledTimes(1);
    });

    it("stops at the round cap", async () => {
        const { run, runRound } = setup([], { goal: { maxRounds: 2 } });
        const outcome = await run();

        expect(outcome).toMatchObject({ ended: "round_limit", rounds: 2 });
        expect(runRound).toHaveBeenCalledTimes(1);
    });

    it("stops at the cost cap, counting the rounds and the reviews", async () => {
        const { run, runRound } = setup([{ cost: GOAL_MAX_COST_MICRODOLLARS, met: false }]);
        const outcome = await run();

        expect(outcome).toMatchObject({ ended: "cost_limit", rounds: 1 });
        expect(outcome.costMicrodollars).toBe(GOAL_MAX_COST_MICRODOLLARS);
        expect(runRound).not.toHaveBeenCalled();
    });

    it("stops when the daily limit is spent, or the reviewer fails, or the time budget is", async () => {
        expect((await setup([{ met: false }], { charge: false }).run()).ended).toBe("daily_limit");

        const failing = setup([]);

        failing.review.mockRejectedValueOnce(new Error("down"));
        expect((await failing.run()).ended).toBe("review_failed");

        const clock = [0, 1_000_000];
        const timed = setup([{ met: false }]);

        expect((await timed.run({ budgetMs: 1000, now: () => clock.shift() ?? 1_000_000 })).ended).toBe("time_limit");
        expect(timed.runRound).not.toHaveBeenCalled();
    });
});

describe("the time budget", () => {
    it("counts from when the run began, so a long first generation leaves less for further rounds", async () => {
        const { run, runRound } = setup([{ met: false }]);
        // The run began nine minutes ago, so the 8-minute budget is spent before the loop starts.
        const outcome = await run({ budgetMs: 8 * 60_000, now: () => 9 * 60_000, startedAt: 0 });

        expect(outcome.ended).toBe("time_limit");
        expect(runRound).not.toHaveBeenCalled();
    });

    it("still runs a further round while the budget lasts", async () => {
        const { run, runRound } = setup([{ met: false }, { met: true }]);

        expect((await run({ budgetMs: 8 * 60_000, now: () => 60_000, startedAt: 0 })).ended).toBe("met");
        expect(runRound).toHaveBeenCalledTimes(1);
    });
});

describe("stopped and stepsTranscript", () => {
    it("ends the goal when the caller says the run was stopped", async () => {
        const { run, runRound } = setup([{ met: false }]);

        expect((await run({ stopped: async () => true })).ended).toBe("user");
        expect(runRound).not.toHaveBeenCalled();
    });

    it("reads a result's steps as text and tool results only", () => {
        const transcript = stepsTranscript([{ text: "Searching.", toolResults: [{ output: { hits: 3 }, toolName: "search" }] }, { text: "Found three." }]);

        expect(transcript).toBe('assistant: Searching.\n\ntool result (search): {"hits":3}\n\nassistant: Found three.');
    });
});
