import { describe, expect, it } from "vitest";

import { GATEWAY_COST_METADATA_KEY } from "../agent/message-cost";
import {
    addDays,
    DEFAULT_SKILL_KEY,
    foldDayTotals,
    foldSkillTotals,
    HEATMAP_DAYS,
    isDayKey,
    replyUsageArgs,
    skillKeyOf,
    summariseReply,
    TOTAL_SKILL_KEY,
    usageDayOf,
    withDayTotals,
} from "./activity-logic";

const row = (overrides: Partial<Parameters<typeof foldSkillTotals>[0][number]>) => {
    return { costMicrodollars: 0, date: "2026-09-01", replies: 1, skillKey: TOTAL_SKILL_KEY, tokens: 0, updatedAt: 0, ...overrides };
};

describe("isDayKey", () => {
    it("accepts real calendar days only", () => {
        expect(isDayKey("2026-09-25")).toBe(true);
        expect(isDayKey("2024-02-29")).toBe(true);
        expect(isDayKey("2026-02-29")).toBe(false);
        expect(isDayKey("2026-13-01")).toBe(false);
        expect(isDayKey("2026-9-25")).toBe(false);
        expect(isDayKey("2026-09-25T00:00")).toBe(false);
        expect(isDayKey("")).toBe(false);
    });
});

describe("addDays", () => {
    it("shifts across month, year and leap boundaries", () => {
        expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
        expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
        expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
        expect(addDays("2026-09-25", -(HEATMAP_DAYS - 1))).toBe("2025-09-20");
    });
});

describe("skillKeyOf", () => {
    it("keys the plain assistant, a saved skill and a draft apart", () => {
        expect(skillKeyOf(undefined)).toBe(DEFAULT_SKILL_KEY);
        expect(skillKeyOf({ id: "sk_1", name: "/writer" })).toBe("sk_1");
        expect(skillKeyOf({ name: "/draft" })).toBe("draft:/draft");
    });
});

describe("summariseReply", () => {
    it("sums gateway cost and tokens over the reply rows, ignoring the prompt", () => {
        const usage = summariseReply([
            { message: { role: "user" }, providerMetadata: { [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: 999 } }, usage: { totalTokens: 999 } },
            { message: { role: "assistant" }, providerMetadata: { [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: 120.4 } }, usage: { totalTokens: 50 } },
            { message: { role: "tool" }, usage: { totalTokens: 5 } },
            { message: { role: "assistant" }, providerMetadata: { [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: 30 } }, usage: { totalTokens: 10 } },
        ]);

        expect(usage).toStrictEqual({ costMicrodollars: 150, tokens: 65 });
    });

    it("counts a reply without cost metadata as zero cost", () => {
        expect(summariseReply([{ message: { role: "assistant" } }])).toStrictEqual({ costMicrodollars: 0, tokens: 0 });
    });

    it("counts nothing when no reply row was saved", () => {
        expect(summariseReply([])).toBeUndefined();
        expect(summariseReply([{ message: { role: "user" } }])).toBeUndefined();
    });
});

describe("usageDayOf", () => {
    it("files a reply under the user's local day", () => {
        const instant = Date.parse("2026-09-25T23:30:00Z");

        expect(usageDayOf(instant, "UTC")).toBe("2026-09-25");
        expect(usageDayOf(instant, "Europe/Berlin")).toBe("2026-09-26");
        expect(usageDayOf(instant, "America/Los_Angeles")).toBe("2026-09-25");
        expect(usageDayOf(instant, "Not/AZone")).toBe("2026-09-25");
        expect(usageDayOf(instant, undefined)).toBe("2026-09-25");
    });
});

describe("foldDayTotals", () => {
    it("sums duplicate rows for one day and sorts oldest first", () => {
        const days = foldDayTotals([
            row({ costMicrodollars: 10, date: "2026-09-02", replies: 2, tokens: 100 }),
            row({ costMicrodollars: 5, date: "2026-09-01", replies: 1, tokens: 7 }),
            row({ costMicrodollars: 1, date: "2026-09-02", replies: 1, tokens: 3 }),
        ]);

        expect(days).toStrictEqual([
            { costMicrodollars: 5, date: "2026-09-01", replies: 1, tokens: 7 },
            { costMicrodollars: 11, date: "2026-09-02", replies: 3, tokens: 103 },
        ]);
    });
});

describe("foldSkillTotals", () => {
    it("skips total rows, sums per skill, keeps the newest name and sorts costliest first", () => {
        const skills = foldSkillTotals([
            row({ costMicrodollars: 1000, replies: 9 }),
            row({ costMicrodollars: 20, replies: 2, skillKey: DEFAULT_SKILL_KEY, tokens: 40 }),
            row({ costMicrodollars: 50, replies: 1, skillKey: "sk_1", skillName: "/old", tokens: 5, updatedAt: 1 }),
            row({ costMicrodollars: 25, date: "2026-09-02", replies: 3, skillKey: "sk_1", skillName: "/writer", tokens: 6, updatedAt: 2 }),
            row({ costMicrodollars: 20, replies: 5, skillKey: "sk_2", skillName: "Reviewer", tokens: 1 }),
        ]);

        expect(skills).toStrictEqual([
            { costMicrodollars: 75, replies: 4, skillKey: "sk_1", skillName: "/writer", tokens: 11 },
            { costMicrodollars: 20, replies: 5, skillKey: "sk_2", skillName: "Reviewer", tokens: 1 },
            { costMicrodollars: 20, replies: 2, skillKey: DEFAULT_SKILL_KEY, tokens: 40 },
        ]);
    });
});

describe("replyUsageArgs", () => {
    const at = Date.parse("2026-09-25T23:30:00Z");

    it("keys a run's record on its first reply row, so a redelivery records it once", () => {
        const args = replyUsageArgs(
            [
                { _id: "m_prompt", message: { role: "user" } },
                {
                    _id: "m_reply",
                    message: { role: "assistant" },
                    providerMetadata: { [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: 12 } },
                    usage: { totalTokens: 7 },
                },
                { _id: "m_tool", message: { role: "tool" }, usage: { totalTokens: 3 } },
            ],
            { at, skill: { id: "sk_1", name: "/writer" }, timeZone: "Europe/Berlin", userId: "u1" },
        );

        expect(args).toStrictEqual({
            at,
            costMicrodollars: 12,
            date: "2026-09-26",
            replyKey: "m_reply",
            skillKey: "sk_1",
            skillName: "/writer",
            tokens: 10,
            userId: "u1",
        });
    });

    it("records nothing for a run that saved no reply row", () => {
        expect(replyUsageArgs([{ _id: "m_prompt", message: { role: "user" } }], { at, userId: "u1" })).toBeUndefined();
        expect(replyUsageArgs([{ message: { role: "assistant" } }], { at, userId: "u1" })).toBeUndefined();
    });
});

describe("withDayTotals", () => {
    it("folds increments per day and skill, and adds one total row per day", () => {
        expect(
            withDayTotals([
                { costMicrodollars: 10, date: "2026-09-01", replies: 1, skillKey: DEFAULT_SKILL_KEY, tokens: 1 },
                { costMicrodollars: 20, date: "2026-09-01", replies: 1, skillKey: "sk_1", skillName: "Alice", tokens: 2 },
                { costMicrodollars: 30, date: "2026-09-01", replies: 1, skillKey: DEFAULT_SKILL_KEY, tokens: 3 },
                { costMicrodollars: 5, date: "2026-09-02", replies: 2, skillKey: "sk_1", tokens: 4 },
                { costMicrodollars: 99, date: "2026-09-02", replies: 9, skillKey: TOTAL_SKILL_KEY, tokens: 99 },
            ]),
        ).toStrictEqual([
            { costMicrodollars: 40, date: "2026-09-01", replies: 2, skillKey: DEFAULT_SKILL_KEY, tokens: 4 },
            { costMicrodollars: 60, date: "2026-09-01", replies: 3, skillKey: TOTAL_SKILL_KEY, tokens: 6 },
            { costMicrodollars: 20, date: "2026-09-01", replies: 1, skillKey: "sk_1", skillName: "Alice", tokens: 2 },
            { costMicrodollars: 5, date: "2026-09-02", replies: 2, skillKey: "sk_1", tokens: 4 },
            { costMicrodollars: 5, date: "2026-09-02", replies: 2, skillKey: TOTAL_SKILL_KEY, tokens: 4 },
        ]);
    });
});
