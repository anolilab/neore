/**
 * A call the user's quick check approved is stamped on the saved tool-call part
 * (`chat/lib/mcp-tool-labels.ts`); the chat reads it off the UI part's
 * `callProviderMetadata.neore`, so the whole stamp has to survive `toUIMessages`.
 */
import { describe, expect, it } from "vitest";

import { toUIMessages } from "./ui-messages";

const stamp = { at: 10, by: "quick-check", model: "m", reason: "Reads a forecast." };

describe("toUIMessages: auto-approved tool calls", () => {
    it("carries the auto-approval stamp, with the MCP label, onto the UI tool part", () => {
        const [message] = toUIMessages([
            {
                _creationTime: 1,
                _id: "m1",
                message: {
                    content: [
                        {
                            input: { city: "Berlin" },
                            providerOptions: { neore: { autoApproval: stamp, mcpServerName: "Weather", mcpToolName: "get_forecast" } },
                            toolCallId: "call-1",
                            toolName: "mcp_Weather__get_forecast",
                            type: "tool-call",
                        },
                    ],
                    role: "assistant",
                },
                order: 1,
                status: "success",
                stepOrder: 0,
                threadId: "t1",
                tool: false,
            } as never,
        ]);
        const part = message?.parts.find((candidate) => candidate.type === "tool-mcp_Weather__get_forecast") as
            | { callProviderMetadata?: { neore?: Record<string, unknown> } }
            | undefined;

        expect(part?.callProviderMetadata?.neore).toStrictEqual({ autoApproval: stamp, mcpServerName: "Weather", mcpToolName: "get_forecast" });
    });

    it("labels a call still streaming with its real MCP names, as the saved call is", () => {
        const [message] = toUIMessages([
            {
                _creationTime: 1,
                _id: "m1",
                message: {
                    content: [
                        {
                            input: { city: "Berlin" },
                            providerOptions: { neore: { mcpServerName: "Weather", mcpToolName: "get_forecast" } },
                            toolCallId: "call-1",
                            toolName: "mcp_Weather__get_forecast_2",
                            type: "tool-call",
                        },
                    ],
                    role: "assistant",
                },
                order: 1,
                status: "streaming",
                stepOrder: 0,
                streaming: true,
                threadId: "t1",
                tool: false,
            } as never,
        ]);
        const part = message?.parts.find((candidate) => candidate.type === "tool-mcp_Weather__get_forecast_2") as
            | { callProviderMetadata?: { neore?: Record<string, unknown> }; state?: string }
            | undefined;

        expect(part?.state).toBe("input-streaming");
        expect(part?.callProviderMetadata?.neore).toStrictEqual({ mcpServerName: "Weather", mcpToolName: "get_forecast" });
    });

    it("does not give a later call in the same reply the label of an earlier MCP call", () => {
        const [message] = toUIMessages([
            {
                _creationTime: 1,
                _id: "m1",
                message: {
                    content: [
                        {
                            input: {},
                            providerOptions: { neore: { mcpServerName: "Weather", mcpToolName: "get_forecast" } },
                            toolCallId: "call-1",
                            toolName: "mcp_Weather__get_forecast",
                            type: "tool-call",
                        },
                        { input: {}, toolCallId: "call-2", toolName: "web_search", type: "tool-call" },
                    ],
                    role: "assistant",
                },
                order: 1,
                providerMetadata: { neore: { mcpServerName: "Weather", mcpToolName: "get_forecast" } },
                status: "streaming",
                stepOrder: 0,
                streaming: true,
                threadId: "t1",
                tool: false,
            } as never,
        ]);
        const later = message?.parts.find((candidate) => candidate.type === "tool-web_search") as { callProviderMetadata?: { neore?: unknown } } | undefined;

        expect(later?.callProviderMetadata?.neore).toBeUndefined();
    });

    it("carries the run that wrote a reply onto its UI message, so the reader can tell one reply from another", () => {
        const [message] = toUIMessages([
            {
                _creationTime: 1,
                _id: "m1",
                message: { content: [{ text: "hi", type: "text" }], role: "assistant" },
                order: 1,
                replyId: "run-42",
                status: "success",
                stepOrder: 0,
                threadId: "t1",
                tool: false,
            } as never,
        ]);

        expect((message as { replyId?: string } | undefined)?.replyId).toBe("run-42");
    });
});
