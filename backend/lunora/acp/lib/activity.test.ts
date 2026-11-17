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

    it("puts a call's latest output and exit on its row, and keeps them through a later status report", () => {
        const printed = (output: string, code?: number) => {
            return { event: { id: "a", kind: "tool_output" as const, output, ...(code !== undefined && { exit: { code } }) } };
        };

        expect(hostActivityOf([tool("a", "in_progress"), printed("half"), printed("ok", 0), tool("a", "completed")])?.tools).toEqual([
            { exit: { code: 0 }, id: "a", output: "ok", status: "completed", title: "Run a", toolKind: "execute" },
        ]);
        // Output for a call never reported has no row.
        expect(hostActivityOf([printed("orphan")])).toBeUndefined();
    });

    it("keeps the most recent calls of a long turn", () => {
        const chunks = Array.from({ length: MAX_ACTIVITY_TOOLS + 3 }, (_, index) => tool(`t${String(index)}`, "completed"));
        const tools = hostActivityOf(chunks)?.tools ?? [];

        expect(tools).toHaveLength(MAX_ACTIVITY_TOOLS);
        expect(tools[0]?.id).toBe("t3");
    });
});
