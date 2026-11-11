/**
 * The tap listener answers a tap on approve or deny: the tap that opened the app from closed (the launch response), a tap that
 * arrives more than one way, a tap refused and then retried, and nothing after it is removed.
 */
import { describe, expect, it, vi } from "vitest";

import type { ApprovalAnswer } from "./approval-response";
import type { TapResponse, TapSource } from "./approval-tap-listener";
import { attachApprovalTapListener } from "./approval-tap-listener";

const DATA = { approvalId: "approval-1", notificationId: "n1", threadId: "thread-1" };

const tap = (identifier: string, actionIdentifier: string): TapResponse => {
    return { actionIdentifier, notification: { request: { content: { data: DATA }, identifier } } };
};

/** A stand-in for expo-notifications: a launch response to read, and a listener the test can fire. */
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

/** Fresh record of what this test has answered and read, so tests do not share state. */
const attach = (source: TapSource, answer: (value: unknown) => Promise<void>) =>
    attachApprovalTapListener(source, answer as never, new Set<string>(), new Set<string>());

describe("attachApprovalTapListener", () => {
    it("leaves a launch response to the next listener when this one was removed while reading it", async () => {
        const answered = new Set<string>();
        const replayed = new Set<string>();
        const answer = vi.fn(async (_value: ApprovalAnswer) => true as const);
        const slow: TapSource = {
            addListener: () => ({ remove: () => undefined }),
            getLast: () =>
                new Promise<TapResponse>((resolve) => {
                    setTimeout(() => {
                        resolve(tap("n1", "approve"));
                    }, 5);
                }),
        };

        const removed = attachApprovalTapListener(slow, answer, answered, replayed);

        removed.remove();
        await removed.launched;

        expect(answer).not.toHaveBeenCalled();
        expect(replayed.size).toBe(0);

        const next = attachApprovalTapListener(fakeSource(tap("n1", "approve")), answer, answered, replayed);

        await next.launched;

        expect(answer).toHaveBeenCalledTimes(1);
    });

    it("logs a failure's code only when it has the shape of a machine code, never a token that a code could carry", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const failing = vi.fn(async (_value: ApprovalAnswer): Promise<boolean | undefined> => {
            throw Object.assign(new Error("boom"), { code: "tok_SECRET-1234" });
        });
        const source = fakeSource(tap("n1", "approve"));

        const listener = attachApprovalTapListener(source, failing, new Set<string>(), new Set<string>());

        await listener.launched;

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("(unknown)"));
        expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
        warn.mockRestore();
    });

    it("answers an approve on an alert whose earlier default tap was read by another listener", async () => {
        const answered = new Set<string>();
        const replayed = new Set<string>();
        const answer = vi.fn(async (_value: ApprovalAnswer) => true as const);

        const first = attachApprovalTapListener(fakeSource(tap("n1", "default")), answer, answered, replayed);

        await first.launched;

        const later = attachApprovalTapListener(fakeSource(tap("n1", "approve")), answer, answered, replayed);

        await later.launched;

        expect(answer).toHaveBeenCalledTimes(1);
        expect(answer).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "approve", threadId: "thread-1" });
    });

    it("does not record a tap as answered when the answer was skipped, so it is read again", async () => {
        const skipped = vi.fn(async (_value: ApprovalAnswer) => false as const);
        const answered = new Set<string>();
        const source = fakeSource(tap("n1", "approve"));

        const listener = attachApprovalTapListener(source, skipped, answered, new Set<string>());

        await listener.launched;

        expect(skipped).toHaveBeenCalledTimes(1);
        expect(answered.size).toBe(0);
    });

    it("lets a later listener answer the stored launch tap that an earlier one skipped, reading it itself", async () => {
        const answered = new Set<string>();
        const replayed = new Set<string>();
        const skipped = vi.fn(async (_value: ApprovalAnswer) => false as const);
        const answerLater = vi.fn(async (_value: ApprovalAnswer) => true as const);

        const first = attachApprovalTapListener(fakeSource(tap("n1", "approve")), skipped, answered, replayed);

        await first.launched;

        const later = attachApprovalTapListener(fakeSource(tap("n1", "approve")), answerLater, answered, replayed);

        await later.launched;

        expect(skipped).toHaveBeenCalledTimes(1);
        expect(answerLater).toHaveBeenCalledTimes(1);
        expect(answerLater).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "approve", threadId: "thread-1" });
    });

    it("answers a tap that opened the app from closed, from the launch response", async () => {
        const answer = vi.fn(async () => undefined);

        const listener = attach(fakeSource(tap("n1", "approve")), answer);

        await listener.launched;

        expect(answer).toHaveBeenCalledTimes(1);
        expect(answer).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "approve", threadId: "thread-1" });
    });

    it("answers a tap once when it arrives live and is also the launch response", async () => {
        const answer = vi.fn(async () => undefined);
        const source = fakeSource(tap("n1", "deny"));

        const listener = attach(source, answer);

        await listener.launched;
        await source.fire(tap("n1", "deny"));

        expect(answer).toHaveBeenCalledTimes(1);
    });

    it("answers two live deliveries of the same tap at the same moment once", async () => {
        const answer = vi.fn(async () => undefined);
        const source = fakeSource(null);

        attach(source, answer);
        await Promise.all([source.fire(tap("n2", "approve")), source.fire(tap("n2", "approve"))]);

        expect(answer).toHaveBeenCalledTimes(1);
    });

    it("does not answer again a tap an earlier listener answered, after a restart or a new sign-in", async () => {
        const answered = new Set<string>();
        const replayed = new Set<string>();
        const answer = vi.fn(async () => undefined);

        await attachApprovalTapListener(fakeSource(tap("n1", "approve")), answer as never, answered, replayed).launched;
        await attachApprovalTapListener(fakeSource(tap("n1", "approve")), answer as never, answered, replayed).launched;

        expect(answer).toHaveBeenCalledTimes(1);
    });

    it("does not answer a stored tap again after a restart when its first answer was refused offline", async () => {
        const answered = new Set<string>();
        const replayed = new Set<string>();
        const answer = vi.fn(async () => {
            throw Object.assign(new Error("offline"), { code: "OFFLINE" });
        });

        await attachApprovalTapListener(fakeSource(tap("n1", "approve")), answer as never, answered, replayed).launched;
        await attachApprovalTapListener(fakeSource(tap("n1", "approve")), answer as never, answered, replayed).launched;

        expect(answer).toHaveBeenCalledTimes(1);
    });

    it("lets a new tap retry an answer that was refused, then records it once it succeeds", async () => {
        const answered = new Set<string>();
        const replayed = new Set<string>();
        const answer = vi
            .fn<(value: unknown) => Promise<void>>()
            .mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "OFFLINE" }))
            .mockResolvedValue(undefined);
        const source = fakeSource(null);

        attachApprovalTapListener(source, answer as never, answered, replayed);
        await source.fire(tap("n3", "approve"));
        await source.fire(tap("n3", "approve"));
        await source.fire(tap("n3", "approve"));

        expect(answer).toHaveBeenCalledTimes(2);
    });

    it("does not let a default tap block a later approve on the same notification", async () => {
        const answer = vi.fn(async () => undefined);
        const source = fakeSource(tap("n4", "expo.modules.notifications.actions.DEFAULT"));

        const listener = attach(source, answer);

        await listener.launched;
        await source.fire(tap("n4", "approve"));

        expect(answer).toHaveBeenCalledTimes(1);
        expect(answer).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "approve", threadId: "thread-1" });
    });

    it("answers nothing once removed, including a launch response that was still being read", async () => {
        const answer = vi.fn(async () => undefined);

        const listener = attach(fakeSource(tap("n1", "approve")), answer);

        listener.remove();
        await listener.launched;

        expect(answer).not.toHaveBeenCalled();
    });

    it("answers nothing when there is no launch response and no tap", async () => {
        const answer = vi.fn(async () => undefined);

        const listener = attach(fakeSource(null), answer);

        await listener.launched;

        expect(answer).not.toHaveBeenCalled();
    });

    it("does not answer a launch response that is the default tap, which only opens the app", async () => {
        const answer = vi.fn(async () => undefined);

        const listener = attach(fakeSource(tap("n1", "expo.modules.notifications.actions.DEFAULT")), answer);

        await listener.launched;

        expect(answer).not.toHaveBeenCalled();
    });
});
