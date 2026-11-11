import { describe, expect, it } from "vitest";

import { ALTERNATING_CALL_WINDOW, findRepeatedCallLoop, type LoopFinding, loopNoticeText, REPEATED_CALL_LIMIT, repeatedCallGuard } from "./repeated-call-guard";

type Call = [string, unknown];

const BRACE = /[{}]/;

/** One finished step making these calls, in order. */
const step = (...calls: Call[]) => {
    return {
        toolCalls: calls.map(([toolName, input]) => {
            return { input, toolName };
        }),
    };
};

/** One call per step, the usual shape of a turn. */
const steps = (...calls: Call[]) => calls.map((call) => step(call));

describe("findRepeatedCallLoop", () => {
    it("has a three-call repeat limit and a four-call alternation window, which fits the default five steps", () => {
        expect(REPEATED_CALL_LIMIT).toBe(3);
        expect(ALTERNATING_CALL_WINDOW).toBe(4);
    });

    it("does not end a repeat whose result changes each time, since the turn is making progress", () => {
        const withOutput = (toolName: string, output: string, id: string) => {
            return {
                toolCalls: [{ input: { action: "scroll" }, toolCallId: id, toolName }],
                toolResults: [{ output: { page: output }, toolCallId: id }],
            };
        };

        const found = findRepeatedCallLoop([withOutput("browser", "a", "1"), withOutput("browser", "b", "2"), withOutput("browser", "c", "3")]);

        expect(found).toBeUndefined();
    });

    it("ends a repeat whose result is the same each time", () => {
        const same = (id: string) => {
            return {
                toolCalls: [{ input: { q: "x" }, toolCallId: id, toolName: "search" }],
                toolResults: [{ output: { hits: 0 }, toolCallId: id }],
            };
        };

        expect(findRepeatedCallLoop([same("1"), same("2"), same("3")])).toEqual({ count: 3, kind: "repeat", toolName: "search" });
    });

    it("ends the turn on the third identical call in a row", () => {
        const found = findRepeatedCallLoop(steps(["search", { q: "x" }], ["search", { q: "x" }], ["search", { q: "x" }]));

        expect(found).toEqual({ count: 3, kind: "repeat", toolName: "search" });
    });

    it("does not end the turn on two identical calls", () => {
        expect(findRepeatedCallLoop(steps(["search", { q: "x" }], ["search", { q: "x" }]))).toBeUndefined();
    });

    it("counts identical calls made inside one step", () => {
        const found = findRepeatedCallLoop([step(["read", { path: "a" }], ["read", { path: "a" }], ["read", { path: "a" }])]);

        expect(found).toEqual({ count: 3, kind: "repeat", toolName: "read" });
    });

    it("treats the same arguments in another key order as the same call", () => {
        const reversed = JSON.parse('{"to": 2, "from": 1}') as unknown;
        const found = findRepeatedCallLoop(steps(["move", { from: 1, to: 2 }], ["move", reversed], ["move", { from: 1, to: 2 }]));

        expect(found).toEqual({ count: 3, kind: "repeat", toolName: "move" });
    });

    it("does not end the turn when the arguments change on each call", () => {
        const found = findRepeatedCallLoop(steps(["search", { q: "a" }], ["search", { q: "b" }], ["search", { q: "c" }], ["search", { q: "d" }]));

        expect(found).toBeUndefined();
    });

    it("does not end the turn when a repeat was broken by another call", () => {
        const found = findRepeatedCallLoop(steps(["search", { q: "x" }], ["search", { q: "x" }], ["open", {}], ["search", { q: "x" }]));

        expect(found).toBeUndefined();
    });

    it("ends the turn on an A-B-A-B cycle over four calls", () => {
        const found = findRepeatedCallLoop(steps(["read", { id: 1 }], ["write", { id: 1 }], ["read", { id: 1 }], ["write", { id: 1 }]));

        expect(found).toEqual({ kind: "alternate", toolNames: ["read", "write"] });
    });

    it("does not end the turn on a cycle that is still three calls long", () => {
        const found = findRepeatedCallLoop(steps(["read", {}], ["write", {}], ["read", {}]));

        expect(found).toBeUndefined();
    });

    it("names a long or Markdown-looking tool name bounded and escaped, and the notice still fits the stored limit", () => {
        const hostile = `![x](https://evil.example/${"a".repeat(80)})`;
        const text = loopNoticeText({ kind: "alternate", toolNames: [hostile, hostile] });

        expect(text).not.toContain("![x](");
        expect(text).toContain(String.raw`\!\[x\]`);
        expect(text.length).toBeLessThan(400);
    });

    it("does not end the turn on an alternation whose arguments change", () => {
        const found = findRepeatedCallLoop(
            steps(["read", { id: 1 }], ["write", { id: 1 }], ["read", { id: 2 }], ["write", { id: 2 }], ["read", { id: 3 }], ["write", { id: 3 }]),
        );

        expect(found).toBeUndefined();
    });

    it("ends the turn once the latest four calls alternate, after earlier varied calls", () => {
        const found = findRepeatedCallLoop(steps(["open", {}], ["read", {}], ["write", {}], ["read", {}], ["write", {}]));

        expect(found).toEqual({ kind: "alternate", toolNames: ["read", "write"] });
    });

    it("ignores steps with no tool calls", () => {
        expect(findRepeatedCallLoop([{ toolCalls: [] }, {}])).toBeUndefined();
    });
});

describe("loopNoticeText", () => {
    it("names the repeated tool and its count, never its arguments", () => {
        const text = loopNoticeText({ count: 3, kind: "repeat", toolName: "search" });

        expect(text).toContain('"search" was called 3 times');
        expect(text).not.toMatch(BRACE);
    });

    it("names both tools of an alternation", () => {
        const text = loopNoticeText({ kind: "alternate", toolNames: ["read", "write"] });

        expect(text).toContain('"read" and "write" kept alternating');
    });
});

describe("the notice never carries an argument or a result", () => {
    const SECRET = "tok-7f3c-do-not-show";

    it("keeps a repeated call's distinctive argument out of the notice", () => {
        const finding = findRepeatedCallLoop(steps(["search", { query: SECRET }], ["search", { query: SECRET }], ["search", { query: SECRET }]));

        expect(finding).toBeDefined();
        expect(loopNoticeText(finding as LoopFinding)).not.toContain(SECRET);
        expect(loopNoticeText(finding as LoopFinding)).toContain('"search"');
    });

    it("keeps an alternation's distinctive argument out of the notice", () => {
        const finding = findRepeatedCallLoop(
            steps(["read", { path: SECRET }], ["write", { path: SECRET }], ["read", { path: SECRET }], ["write", { path: SECRET }]),
        );

        expect(finding).toBeDefined();
        expect(loopNoticeText(finding as LoopFinding)).not.toContain(SECRET);
        expect(loopNoticeText(finding as LoopFinding)).toContain('"read" and "write"');
    });
});

describe("repeatedCallGuard", () => {
    it("ends the turn on the same loop the plain decision finds, and keeps that finding", () => {
        const guard = repeatedCallGuard();
        const looping = steps(["search", { q: 1 }], ["search", { q: 1 }], ["search", { q: 1 }]);

        expect(guard.finding).toBeUndefined();
        expect(guard.stop({ steps: looping })).toBe(true);
        expect(guard.finding).toStrictEqual({ count: 3, kind: "repeat", toolName: "search" });
    });

    it("clears the finding when a later evaluation finds no loop", () => {
        const guard = repeatedCallGuard();

        guard.stop({ steps: steps(["search", { q: 1 }], ["search", { q: 1 }], ["search", { q: 1 }]) });

        expect(guard.stop({ steps: steps(["search", { q: 2 }]) })).toBe(false);
        expect(guard.finding).toBeUndefined();
    });
});
