/**
 * One deadline covers the whole classifier call: a utility model that never resolves must leave the call
 * with the person, not hang the run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOW_RISK_DEADLINE_MS } from "./low-risk-approval";
import { createRunLowRiskCheck } from "./low-risk-check";

vi.mock("../../lib/utility-model", () => {
    return { getUtilityModel: vi.fn(async () => await new Promise(() => {})) };
});
vi.mock("../../lib/services", () => {
    return { gatewayFetch: () => async () => new Response() };
});
vi.mock("../../_generated/internal", () => {
    return { internal: { chat: { tool_permissions: { consumeLowRiskCheck: "consume", getLowRiskApprovalContext: "allowed" } } } };
});

afterEach(() => {
    vi.useRealTimers();
});

describe("createRunLowRiskCheck", () => {
    it("asks the person when resolving the utility model outlasts the deadline", async () => {
        vi.useFakeTimers();

        const outcomes: string[] = [];
        const ctx = {
            log: {
                event: (_name: string, data: { outcome: string }) => {
                    outcomes.push(data.outcome);
                },
            },
            runMutation: vi.fn(async () => true),
            runQuery: vi.fn(async () => true),
        };
        const { check } = createRunLowRiskCheck(ctx as never, { threadId: "t", untrustedContext: Promise.resolve(false), userId: "u" });
        const result = check({
            input: { city: "Berlin" },
            key: "mcp:Weather:get_forecast",
            messages: [{ content: [{ text: "weather?", type: "text" }], role: "user" }],
            toolCallId: "call-1",
        });

        await vi.advanceTimersByTimeAsync(LOW_RISK_DEADLINE_MS + 1);

        await expect(result).resolves.toBe(false);
        expect(outcomes).toEqual(["failed"]);
    });
});
