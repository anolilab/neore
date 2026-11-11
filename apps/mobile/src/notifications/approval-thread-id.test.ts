/**
 * A tap whose alert carries a malformed thread id is declined before any answer is made with it.
 */
import { describe, expect, it, vi } from "vitest";

import type { NotificationTap } from "./approval-response";
import { answerApprovalFromTap, isThreadId } from "./approval-response";

const tap = (threadId: unknown): NotificationTap => {
    return { actionIdentifier: "approve", notification: { request: { content: { data: { approvalId: "a1", threadId } } } } };
};

describe("isThreadId", () => {
    it("accepts a bounded run of letters, digits, dots, underscores and hyphens, including an imported id", () => {
        expect(isThreadId("thread_01-AB")).toBe(true);
        expect(isThreadId("import.2024-05.chat")).toBe(true);
        expect(isThreadId("a".repeat(256))).toBe(true);
    });

    it("refuses an empty, over-long, or markup-bearing value", () => {
        expect(isThreadId("")).toBe(false);
        expect(isThreadId("a".repeat(257))).toBe(false);
        expect(isThreadId("<script>")).toBe(false);
        expect(isThreadId("a/b")).toBe(false);
    });
});

describe("answerApprovalFromTap with a malformed thread id", () => {
    it("declines the tap and makes no answer", async () => {
        const answer = vi.fn(async () => undefined);

        expect(await answerApprovalFromTap(tap("../../other"), answer)).toBe(false);
        expect(answer).not.toHaveBeenCalled();
    });

    it("answers a well-formed one", async () => {
        const answer = vi.fn(async () => undefined);

        expect(await answerApprovalFromTap(tap("thread_01"), answer)).toBe(true);
        expect(answer).toHaveBeenCalledTimes(1);
    });
});
