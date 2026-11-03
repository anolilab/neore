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
            { callProviderMetadata?: { neore?: Record<string, unknown> } } | undefined;

        expect(part?.callProviderMetadata?.neore).toStrictEqual({ autoApproval: stamp, mcpServerName: "Weather", mcpToolName: "get_forecast" });
    });
});
