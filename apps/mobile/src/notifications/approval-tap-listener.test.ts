/**
 * The tap listener answers a tap on approve or deny, including the tap that opened the app from closed (the launch response),
 * and answers each tap once even when it arrives both ways.
 */
import { describe, expect, it, vi } from "vitest";

import type { TapResponse, TapSource } from "./approval-tap-listener";
import { attachApprovalTapListener } from "./approval-tap-listener";

const DATA = { approvalId: "approval-1", notificationId: "n1", threadId: "thread-1" };

const tap = (identifier: string, actionIdentifier: string): TapResponse => {
    return { actionIdentifier, notification: { request: { content: { data: DATA }, identifier } } };
};

/** A stand-in for expo-notifications: a launch response to read once, and a listener the test can fire. */
const fakeSource = (launch: TapResponse | null) => {
    const source = {
        addListener: (listener: (response: TapResponse) => Promise<void>) => {
            source.fire = listener;

            return { remove: () => undefined };
        },
        fire: async (_response: TapResponse): Promise<void> => undefined,
        getLast: async () => launch,
    };

    return source satisfies TapSource & { fire: (response: TapResponse) => Promise<void> };
};

describe("attachApprovalTapListener", () => {
    it("answers a tap that opened the app from closed, from the launch response", async () => {
        const answer = vi.fn(async () => undefined);

        const listener = attachApprovalTapListener(fakeSource(tap("n1", "approve")), answer);

        await listener.launched;

        expect(answer).toHaveBeenCalledTimes(1);
        expect(answer).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "approve", threadId: "thread-1" });
    });

    it("answers a tap once when it arrives live and is also the launch response", async () => {
        const answer = vi.fn(async () => undefined);
        const source = fakeSource(tap("n1", "deny"));

        const listener = attachApprovalTapListener(source, answer);

        await listener.launched;
        await source.fire(tap("n1", "deny"));

        expect(answer).toHaveBeenCalledTimes(1);
        expect(answer).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "deny", threadId: "thread-1" });
    });

    it("answers a live tap on a different notification as well", async () => {
        const answer = vi.fn(async () => undefined);
        const source = fakeSource(null);

        const listener = attachApprovalTapListener(source, answer);

        await listener.launched;
        await source.fire(tap("n2", "approve"));

        expect(answer).toHaveBeenCalledTimes(1);
    });

    it("answers nothing when there is no launch response and no tap", async () => {
        const answer = vi.fn(async () => undefined);

        const listener = attachApprovalTapListener(fakeSource(null), answer);

        await listener.launched;

        expect(answer).not.toHaveBeenCalled();
    });

    it("does not answer a launch response that is the default tap, which only opens the app", async () => {
        const answer = vi.fn(async () => undefined);

        const listener = attachApprovalTapListener(fakeSource(tap("n1", "expo.modules.notifications.actions.DEFAULT")), answer);

        await listener.launched;

        expect(answer).not.toHaveBeenCalled();
    });
});
