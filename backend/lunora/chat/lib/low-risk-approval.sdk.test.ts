/**
 * The quick check against the real AI SDK `streamText`: the hook `applyToolPermissions` installs is
 * called with the messages the model saw and the call's id, a cleared call executes without a
 * `tool-approval-request`, and a call the check does not clear pauses for one.
 */
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { isStepCount, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createLowRiskApprover } from "./low-risk-approval";
import { applyToolPermissions, toolPermissionKey } from "./tool-permissions";

const usage = {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
    outputTokens: { reasoning: 0, text: 1, total: 1 },
};

const NAME = "mcp_Weather__get_forecast";

const steps = (): LanguageModelV3StreamPart[][] => [
    [
        { type: "stream-start", warnings: [] },
        { input: '{"city":"Berlin"}', toolCallId: "call-1", toolName: NAME, type: "tool-call" },
        { finishReason: { raw: "tool-calls", unified: "tool-calls" }, type: "finish", usage },
    ],
    [
        { type: "stream-start", warnings: [] },
        { id: "t", type: "text-start" },
        { delta: "Done.", id: "t", type: "text-delta" },
        { id: "t", type: "text-end" },
        { finishReason: { raw: "stop", unified: "stop" }, type: "finish", usage },
    ],
];

const run = async (classify: () => Promise<unknown>) => {
    const executed = vi.fn(async () => "sunny");
    const classifyMock = vi.fn(classify);
    const records: Record<string, unknown> = {};
    const check = createLowRiskApprover({
        classify: classifyMock,
        consumeBudget: async () => true,
        model: "utility",
        now: () => 1,
        record: (id, record) => {
            records[id] = record;
        },
    });
    const { tools } = applyToolPermissions(
        { [NAME]: tool({ description: "forecast", execute: executed, inputSchema: z.object({ city: z.string() }) }) },
        () => {
            return { key: toolPermissionKey("mcp", "get_forecast", "Weather"), source: "mcp" };
        },
        {},
        { lowRiskCheck: check },
    );
    let call = 0;
    const result = streamText({
        model: new MockLanguageModelV3({
            doStream: async () => {
                const parts = steps()[Math.min(call, 1)] ?? [];

                call += 1;

                return {
                    stream: new ReadableStream<LanguageModelV3StreamPart>({
                        start(controller) {
                            for (const part of parts) {
                                controller.enqueue(part);
                            }

                            controller.close();
                        },
                    }),
                };
            },
        }),
        prompt: "weather in Berlin?",
        stopWhen: isStepCount(5),
        tools,
    });
    const types: string[] = [];

    for await (const part of result.fullStream) {
        types.push(part.type);
    }

    return { classifyMock, executed, records, types };
};

describe("the quick check through streamText", () => {
    it("runs a call the classifier clears, without an approval request, and records it", async () => {
        const { classifyMock, executed, records, types } = await run(async () => {
            return { lowRisk: true, reason: "Reads a forecast." };
        });

        expect(types).not.toContain("tool-approval-request");
        expect(executed).toHaveBeenCalledTimes(1);
        expect(classifyMock).toHaveBeenCalledTimes(1);
        // The classifier saw the call as JSON evidence, with the tool's key.
        expect(String((classifyMock.mock.calls[0] as unknown[])[0])).toContain("mcp:Weather:get_forecast");
        expect(records["call-1"]).toMatchObject({ by: "quick-check", reason: "Reads a forecast." });
    });

    it("pauses for a person when the classifier does not clear it", async () => {
        const { executed, records, types } = await run(async () => {
            return { lowRisk: false, reason: "Unsure." };
        });

        expect(types).toContain("tool-approval-request");
        expect(executed).not.toHaveBeenCalled();
        expect(records).toStrictEqual({});
    });

    it("pauses for a person when the classifier fails", async () => {
        const { executed, types } = await run(async () => {
            throw new Error("gateway down");
        });

        expect(types).toContain("tool-approval-request");
        expect(executed).not.toHaveBeenCalled();
    });
});
