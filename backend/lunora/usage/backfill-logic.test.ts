import { describe, expect, it } from "vitest";

import { GATEWAY_COST_METADATA_KEY } from "../agent/message-cost";
import { DEFAULT_SKILL_KEY } from "./activity-logic";
import type { BackfillRow } from "./backfill-logic";
import { backfillIncrement, completeOrders, groupReplies } from "./backfill-logic";

const at = Date.parse("2026-09-20T12:00:00Z");
let next = 0;

const row = (order: number, role: string, overrides: Partial<BackfillRow> = {}): BackfillRow => {
    next += 1;

    return { _creationTime: at, _id: `m${String(next)}`, message: { role }, order, status: "success", stepOrder: next, userId: "u1", ...overrides };
};

const ids = (groups: ReturnType<typeof groupReplies>): string[][] => groups.map((group) => group.rows.map((r) => r._id));

describe("groupReplies", () => {
    it("cuts one reply per run: after a prompt, at a new order, at a sibling, at a new speaker", () => {
        const prompt = row(0, "user", { _id: "p0" });
        const rows = [
            prompt,
            row(0, "assistant", { _id: "a" }),
            row(0, "tool", { _id: "a-tool" }),
            row(0, "assistant", { _id: "sibling", parentMessageId: "p0" }),
            row(1, "assistant", { _id: "continuation" }),
            row(2, "user", { _id: "p2" }),
            row(2, "assistant", { _id: "alice", speakerSkillId: "sk_a" }),
            row(2, "assistant", { _id: "bob", speakerSkillId: "sk_b" }),
        ];

        expect(ids(groupReplies(rows))).toStrictEqual([["a", "a-tool"], ["sibling"], ["continuation"], ["alice"], ["bob"]]);
    });

    it("names the prompt's author only for replies in the prompt's order", () => {
        const groups = groupReplies([row(0, "user", { userId: "collaborator" }), row(0, "assistant"), row(1, "assistant")]);

        expect(groups.map((group) => group.promptUserId)).toStrictEqual(["collaborator", undefined]);
    });
});

describe("completeOrders", () => {
    it("keeps a partial page whole", () => {
        const rows = [row(0, "user"), row(1, "user")];

        expect(completeOrders(rows, false)).toStrictEqual({ lastOrder: 1, rows, splitOrder: undefined });
    });

    it("leaves a full page's last order for the next read", () => {
        const rows = [row(0, "user"), row(1, "user"), row(1, "assistant")];

        expect(completeOrders(rows, true)).toStrictEqual({ lastOrder: 0, rows: [rows[0]], splitOrder: undefined });
    });

    it("asks for an order read on its own when it filled the page", () => {
        expect(completeOrders([row(4, "user"), row(4, "assistant")], true)).toStrictEqual({ lastOrder: undefined, rows: [], splitOrder: 4 });
    });
});

describe("backfillIncrement", () => {
    const window = { cutoff: at + 1, oldestDate: "2025-01-01", userId: "u1" };
    const priced = (tokens: number, cost: number) => {
        return { providerMetadata: { [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: cost } }, usage: { totalTokens: tokens } };
    };

    it("adds a finished reply of the user's under its day and skill", () => {
        expect(backfillIncrement({ rows: [row(0, "assistant", priced(5, 50)), row(0, "tool", priced(1, 10))] }, window)).toStrictEqual({
            costMicrodollars: 60,
            date: "2026-09-20",
            replies: 1,
            skillKey: DEFAULT_SKILL_KEY,
            tokens: 6,
        });
        expect(backfillIncrement({ rows: [row(0, "assistant", { agentName: "Alice", speakerSkillId: "sk_a" })] }, window)).toMatchObject({
            skillKey: "sk_a",
            skillName: "Alice",
        });
    });

    it("leaves running, later, someone else's and expired replies alone", () => {
        expect(backfillIncrement({ rows: [row(0, "assistant"), row(0, "assistant", { status: "pending" })] }, window)).toBeUndefined();
        expect(backfillIncrement({ rows: [row(0, "assistant", { _creationTime: at + 1 })] }, window)).toBeUndefined();
        expect(backfillIncrement({ promptUserId: "collaborator", rows: [row(0, "assistant")] }, window)).toBeUndefined();
        expect(backfillIncrement({ rows: [row(0, "assistant", { userId: "collaborator" })] }, window)).toBeUndefined();
        expect(backfillIncrement({ rows: [row(0, "assistant")] }, { ...window, oldestDate: "2026-09-21" })).toBeUndefined();
    });
});
