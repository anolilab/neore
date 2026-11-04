import { describe, expect, it } from "vitest";

import { hostActivityOf, MAX_ACTIVITY_TOOLS } from "./activity";

const tool = (id: string, status: "completed" | "in_progress" | "pending", title = `Run ${id}`) => {
    return { event: { id, kind: "tool" as const, status, title, toolKind: "execute" } };
};

const plan = (status: "completed" | "in_progress" | "pending") => {
    return { event: { entries: [{ content: "Read the code", priority: "high" as const, status }], kind: "plan" as const } };
};

describe(hostActivityOf, () => {
    it("has nothing for a turn with neither a plan nor a tool call", () => {
        expect(hostActivityOf([{ event: undefined }, { event: { kind: "turn_start", text: "" } }])).toBeUndefined();
    });

    it("keeps the latest plan only: each one replaces the one before", () => {
        expect(hostActivityOf([plan("in_progress"), tool("a", "pending"), plan("completed")])?.plan).toEqual([
            { content: "Read the code", priority: "high", status: "completed" },
        ]);
    });

    it("shows each tool call once, at its latest report, in the order the calls started", () => {
        expect(hostActivityOf([tool("a", "pending"), tool("b", "in_progress"), tool("a", "completed", "Ran a")])?.tools).toEqual([
            { id: "a", status: "completed", title: "Ran a", toolKind: "execute" },
            { id: "b", status: "in_progress", title: "Run b", toolKind: "execute" },
        ]);
    });

    it("keeps the most recent calls of a long turn", () => {
        const chunks = Array.from({ length: MAX_ACTIVITY_TOOLS + 3 }, (_, index) => tool(`t${String(index)}`, "completed"));
        const tools = hostActivityOf(chunks)?.tools ?? [];

        expect(tools).toHaveLength(MAX_ACTIVITY_TOOLS);
        expect(tools[0]?.id).toBe("t3");
    });
});
