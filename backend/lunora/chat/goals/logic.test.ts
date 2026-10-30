import { describe, expect, it } from "vitest";

import {
    buildGoalContinuationPrompt,
    buildGoalReviewPrompt,
    buildGoalTranscript,
    clampGoalRounds,
    decideGoalRound,
    GOAL_DEFAULT_ROUNDS,
    GOAL_MAX_ROUNDS,
    GOAL_REASON_MAX,
    GOAL_TRANSCRIPT_MAX,
    parseGoalVerdict,
} from "./logic";

const base = { costMicrodollars: 0, maxCostMicrodollars: 1_000_000, maxRounds: 5, met: false, round: 1 };

describe("decideGoalRound", () => {
    it("ends a met goal, whatever the caps say", () => {
        expect(decideGoalRound({ ...base, costMicrodollars: 9_000_000, met: true, round: 5 })).toBe("met");
    });

    it("continues while the goal is not met and both caps have room", () => {
        expect(decideGoalRound(base)).toBe("continue");
        expect(decideGoalRound({ ...base, round: 4 })).toBe("continue");
    });

    it("stops at the round cap: the Nth review is the last", () => {
        expect(decideGoalRound({ ...base, round: 5 })).toBe("round_limit");
        expect(decideGoalRound({ ...base, maxRounds: 1 })).toBe("round_limit");
    });

    it("stops at the cost cap, and the round cap wins a tie", () => {
        expect(decideGoalRound({ ...base, costMicrodollars: 1_000_000 })).toBe("cost_limit");
        expect(decideGoalRound({ ...base, costMicrodollars: 1_000_000, round: 5 })).toBe("round_limit");
    });

    it("never trips the cost cap on a run nobody priced", () => {
        expect(decideGoalRound({ ...base, costMicrodollars: 0 })).toBe("continue");
    });
});

describe("clampGoalRounds", () => {
    it("defaults to five and never exceeds ten", () => {
        expect(clampGoalRounds(undefined)).toBe(GOAL_DEFAULT_ROUNDS);
        expect(clampGoalRounds(NaN)).toBe(GOAL_DEFAULT_ROUNDS);
        expect(clampGoalRounds(99)).toBe(GOAL_MAX_ROUNDS);
        expect(clampGoalRounds(0)).toBe(1);
        expect(clampGoalRounds(3.9)).toBe(3);
    });
});

describe("parseGoalVerdict", () => {
    it("reads a met verdict, with prose or a fence around it", () => {
        expect(parseGoalVerdict('{"met": true, "reason": "Tests pass."}')).toEqual({ met: true, reason: "Tests pass." });
        expect(parseGoalVerdict('Sure:\n```json\n{"met": true, "reason": "Done"}\n```')).toEqual({ met: true, reason: "Done" });
    });

    it("counts anything but a literal true as not met", () => {
        expect(parseGoalVerdict('{"met": "yes", "reason": "x"}').met).toBe(false);
        expect(parseGoalVerdict('{"met": 1, "reason": "x"}').met).toBe(false);
        expect(parseGoalVerdict("The goal is met!").met).toBe(false);
        expect(parseGoalVerdict("").met).toBe(false);
        expect(parseGoalVerdict('{"met": "true", "reason": "x"}').met).toBe(true);
    });

    it("keeps the reason to one line of bounded length, and supplies one when missing", () => {
        const long = parseGoalVerdict(JSON.stringify({ met: false, reason: `a\n\nb ${"x".repeat(1000)}` }));

        expect(long.reason).not.toContain("\n");
        expect(long.reason.length).toBeLessThanOrEqual(GOAL_REASON_MAX);
        expect(parseGoalVerdict('{"met": false}').reason).toContain("no reason");
        expect(parseGoalVerdict("nothing").reason).toContain("no readable verdict");
    });
});

describe("buildGoalTranscript", () => {
    const rows = [
        {
            message: {
                content: [
                    { text: "Looking.", type: "text" },
                    { input: { query: "SECRET-INPUT" }, toolCallId: "1", toolName: "search", type: "tool-call" },
                ],
                role: "assistant",
            },
        },
        {
            message: {
                content: [{ output: { type: "text", value: "found 3 files" }, toolCallId: "1", toolName: "search", type: "tool-result" }],
                role: "tool",
            },
        },
        { message: { content: "All three updated.", role: "assistant" } },
    ];

    it("carries assistant text and tool results in order, and never a tool call's input", () => {
        const transcript = buildGoalTranscript(rows);

        expect(transcript).toBe("assistant: Looking.\n\ntool result (search): found 3 files\n\nassistant: All three updated.");
        expect(transcript).not.toContain("SECRET-INPUT");
    });

    it("cuts a long result and keeps the end of a long turn", () => {
        const big = [{ message: { content: [{ output: { type: "text", value: "y".repeat(5000) }, toolName: "fetch", type: "tool-result" }], role: "tool" } }];

        expect(buildGoalTranscript(big).length).toBeLessThan(1600);

        const many = Array.from({ length: 40 }, (_, index) => {
            return { message: { content: `${"z".repeat(1000)} step-${index}`, role: "assistant" } };
        });
        const transcript = buildGoalTranscript(many);

        expect(transcript.length).toBeLessThanOrEqual(GOAL_TRANSCRIPT_MAX + 1);
        expect(transcript).toContain("step-39");
        expect(transcript).not.toContain("step-0 ");
    });
});

describe("prompts", () => {
    it("hands the goal and transcript over as JSON data", () => {
        const prompt = buildGoalReviewPrompt({ goal: 'Fix "it"', round: 2, transcript: "assistant: ok" });

        expect(prompt).toContain(String.raw`"goal": "Fix \"it\""`);
        expect(prompt).toContain('"round": 2');
    });

    it("states the goal and the reviewer's reason in the next instruction", () => {
        const prompt = buildGoalContinuationPrompt({ goal: "Ship the report", reason: "The charts are missing." });

        expect(prompt).toContain("Ship the report");
        expect(prompt).toContain("The charts are missing.");
    });
});
