import { describe, expect, it } from "vitest";

import type { MessagePart } from "../types/message";
import { segmentTurn } from "./turn-summary";

const tool = (name: string, state = "output-available", id = name): MessagePart => ({ state, toolCallId: id, type: `tool-${name}` }) as MessagePart;
const text: MessagePart = { text: "answer", type: "text" };
const reasoning: MessagePart = { text: "hmm", type: "reasoning" };

describe("segmentTurn", () => {
    it("folds a run of finished calls into one group", () => {
        const segments = segmentTurn([
            tool("dateTime", "output-available", "a"),
            tool("dateTime", "output-available", "b"),
            tool("dateTime", "output-available", "c"),
            reasoning,
            text,
        ]);

        expect(segments).toEqual([
            { end: 2, kind: "group", names: [{ count: 3, name: "dateTime" }], start: 0, toolCount: 3 },
            { index: 3, kind: "part" },
            { index: 4, kind: "part" },
        ]);
    });

    it("leaves a single call ungrouped", () => {
        expect(segmentTurn([tool("dateTime"), text])).toEqual([
            { index: 0, kind: "part" },
            { index: 1, kind: "part" },
        ]);
    });

    it("splits runs at text", () => {
        const segments = segmentTurn([tool("a"), tool("b"), text, tool("c"), tool("d")]);

        expect(segments.map((s) => s.kind)).toEqual(["group", "part", "group"]);
    });

    it("keeps reasoning between calls inside the group and orders trailing reasoning after it", () => {
        const segments = segmentTurn([tool("a"), reasoning, tool("b"), reasoning]);

        expect(segments).toEqual([
            {
                end: 2,
                kind: "group",
                names: [
                    { count: 1, name: "a" },
                    { count: 1, name: "b" },
                ],
                start: 0,
                toolCount: 2,
            },
            { index: 3, kind: "part" },
        ]);
    });

    it.each(["input-streaming", "input-available", "approval-requested", "approval-responded", "output-error", "output-denied"])(
        "never folds a %s call",
        (state) => {
            const segments = segmentTurn([tool("a"), tool("b", state), tool("c")]);

            expect(segments.every((s) => s.kind === "part")).toBe(true);
        },
    );

    it("respects canFold", () => {
        const segments = segmentTurn([tool("askUser"), tool("a"), tool("b")], (part) => part.type !== "tool-askUser");

        expect(segments.map((s) => s.kind)).toEqual(["part", "group"]);
    });

    it("orders names by count, then first seen", () => {
        const segments = segmentTurn([tool("a"), tool("b"), tool("b"), tool("c")]);

        expect(segments[0]).toMatchObject({
            names: [
                { count: 2, name: "b" },
                { count: 1, name: "a" },
                { count: 1, name: "c" },
            ],
        });
    });
});
