import { describe, expect, it } from "vitest";

import { labelMcpToolCalls } from "./mcp-tool-labels";

// Two servers whose names sanitise alike: only the label can tell them apart.
const LABELS = {
    mcp_my_server__delete: { serverName: "my server", toolName: "delete" },
    mcp_my_server__delete_2: { serverName: "my_server", toolName: "delete" },
};

describe("labelMcpToolCalls", () => {
    it("stamps each MCP tool call with its real server and tool, keeping existing provider options", () => {
        const content = [
            { text: "Deleting", type: "text" },
            { input: {}, providerOptions: { anthropic: { cache: true } }, toolCallId: "c1", toolName: "mcp_my_server__delete_2", type: "tool-call" },
            { input: {}, toolCallId: "c2", toolName: "webSearch", type: "tool-call" },
        ];

        expect(labelMcpToolCalls(content, LABELS)).toStrictEqual([
            content[0],
            {
                ...content[1],
                providerOptions: { anthropic: { cache: true }, neore: { mcpServerName: "my_server", mcpToolName: "delete" } },
            },
            content[2],
        ]);
    });

    it("reports nothing to do when there is no MCP call or it is already stamped", () => {
        const stamped = [
            { providerOptions: { neore: { mcpServerName: "my server", mcpToolName: "delete" } }, toolName: "mcp_my_server__delete", type: "tool-call" },
        ];

        expect(labelMcpToolCalls(stamped, LABELS)).toBeUndefined();
        expect(labelMcpToolCalls([{ toolName: "webSearch", type: "tool-call" }], LABELS)).toBeUndefined();
        expect(labelMcpToolCalls("plain text", LABELS)).toBeUndefined();
    });
});

describe("labelMcpToolCalls: auto-approved calls", () => {
    const approval = { at: 10, by: "quick-check", model: "m", reason: "Reads a forecast." } as const;

    it("stamps the call by its id and keeps the MCP label next to it", () => {
        const content = [
            { input: {}, toolCallId: "c1", toolName: "mcp_my_server__delete_2", type: "tool-call" },
            { input: {}, toolCallId: "c2", toolName: "mcp_my_server__delete_2", type: "tool-call" },
        ];

        expect(labelMcpToolCalls(content, LABELS, { c1: approval })).toStrictEqual([
            { ...content[0], providerOptions: { neore: { autoApproval: approval, mcpServerName: "my_server", mcpToolName: "delete" } } },
            { ...content[1], providerOptions: { neore: { mcpServerName: "my_server", mcpToolName: "delete" } } },
        ]);
    });

    it("stamps a call that is not an MCP tool, and only that call", () => {
        const content = [{ input: {}, toolCallId: "c1", toolName: "somethingElse", type: "tool-call" }];

        expect(labelMcpToolCalls(content, {}, { c1: approval })).toStrictEqual([{ ...content[0], providerOptions: { neore: { autoApproval: approval } } }]);
        expect(labelMcpToolCalls(content, {}, { other: approval })).toBeUndefined();
    });

    it("reports nothing to do once the approval is stamped", () => {
        const stamped = [{ providerOptions: { neore: { autoApproval: approval } }, toolCallId: "c1", toolName: "x", type: "tool-call" }];

        expect(labelMcpToolCalls(stamped, {}, { c1: approval })).toBeUndefined();
    });
});
