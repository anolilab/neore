import { describe, expect, it } from "vitest";

import { applyStepLabels } from "./step-labels";

describe("applyStepLabels", () => {
    it("replaces the content of the rows the labeller changes, and keeps the others as they were", () => {
        const labelled = { message: { content: [{ toolName: "mcp_a" }], role: "assistant" }, status: "success" };
        const plain = { message: { content: [{ text: "hi" }], role: "assistant" }, status: "success" };

        const result = applyStepLabels([labelled, plain], (content) =>
            Array.isArray(content) && content.some((part) => part.toolName === "mcp_a") ? [{ labelled: true, toolName: "mcp_a" }] : undefined,
        );

        expect(result[0]).toStrictEqual({ message: { content: [{ labelled: true, toolName: "mcp_a" }], role: "assistant" }, status: "success" });
        expect(result[1]).toBe(plain);
    });

    it("leaves every row alone when the labeller changes nothing", () => {
        const rows = [{ message: { content: [], role: "assistant" } }];

        expect(applyStepLabels(rows, () => undefined)).toEqual(rows);
    });
});
