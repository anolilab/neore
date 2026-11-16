import { describe, expect, it, vi } from "vitest";

import type { NotificationTap } from "./approval-response";
import { answerApprovalFromTap } from "./approval-response";

const tap = (actionIdentifier: string, data: unknown): NotificationTap => {
    return { actionIdentifier, notification: { request: { content: { data } } } };
};

const ALERT_DATA = { approvalId: "approval-1", notificationId: "n1", threadId: "thread-1" };

describe("answerApprovalFromTap", () => {
    it("approves the named approval on the approve action", async () => {
        const answer = vi.fn(async () => undefined);

        expect(await answerApprovalFromTap(tap("approve", ALERT_DATA), answer)).toBe(true);
        expect(answer).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "approve", threadId: "thread-1" });
    });

    it("denies the named approval on the deny action", async () => {
        const answer = vi.fn(async () => undefined);

        expect(await answerApprovalFromTap(tap("deny", ALERT_DATA), answer)).toBe(true);
        expect(answer).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "deny", threadId: "thread-1" });
    });

    it("leaves the default tap, which opens the app, alone", async () => {
        const answer = vi.fn(async () => undefined);

        expect(await answerApprovalFromTap(tap("expo.modules.notifications.actions.DEFAULT", ALERT_DATA), answer)).toBe(false);
        expect(answer).not.toHaveBeenCalled();
    });

    it("answers nothing for an alert missing its approval or its chat", async () => {
        const answer = vi.fn(async () => undefined);

        expect(await answerApprovalFromTap(tap("approve", { threadId: "thread-1" }), answer)).toBe(false);
        expect(await answerApprovalFromTap(tap("approve", { approvalId: "approval-1" }), answer)).toBe(false);
        expect(await answerApprovalFromTap(tap("approve", { approvalId: "", threadId: "thread-1" }), answer)).toBe(false);
        expect(answer).not.toHaveBeenCalled();
    });

    it("answers nothing for data that is not an object", async () => {
        const answer = vi.fn(async () => undefined);

        expect(await answerApprovalFromTap(tap("approve", undefined), answer)).toBe(false);
        expect(await answerApprovalFromTap(tap("approve", "approval-1"), answer)).toBe(false);
        expect(answer).not.toHaveBeenCalled();
    });

    it("lets a failed answer reach the caller, so it can be logged", async () => {
        const answer = vi.fn(async () => {
            throw new Error("offline");
        });

        await expect(answerApprovalFromTap(tap("deny", ALERT_DATA), answer)).rejects.toThrow("offline");
    });
});
