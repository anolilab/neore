import { describe, expect, it } from "vitest";

import type { ComposerSubmitState } from "./composer-submit-intent";
import { composerSubmitIntent } from "./composer-submit-intent";

const THREAD: ComposerSubmitState = {
    hasAttachments: false,
    isComparisonValid: false,
    isStreaming: false,
    isThreadComposer: true,
    text: "hello",
    threadId: "thread-1",
};

describe(composerSubmitIntent, () => {
    it("sends a message when no reply streams", () => {
        expect(composerSubmitIntent(THREAD)).toBe("send");
    });

    it("queues a follow-up in a thread while a reply streams", () => {
        expect(composerSubmitIntent({ ...THREAD, isStreaming: true })).toBe("queue");
    });

    it.each([
        ["a comparison", { isComparisonValid: true }],
        ["a composer that is not the thread's", { isThreadComposer: false }],
        ["a new chat", { isThreadComposer: false, threadId: undefined }],
    ])("waits while a reply streams in %s, which has no queue", (_label: string, overrides: Partial<ComposerSubmitState>) => {
        expect(composerSubmitIntent({ ...THREAD, isStreaming: true, ...overrides })).toBe("wait");
    });

    it.each([
        ["/compact", "compact"],
        ["  /CLEAR ", "clear"],
    ])("runs %s as a command, also while a reply streams and in a new chat", (text: string, intent: string) => {
        expect(composerSubmitIntent({ ...THREAD, text })).toBe(intent);
        expect(composerSubmitIntent({ ...THREAD, isStreaming: true, text })).toBe(intent);
        expect(composerSubmitIntent({ ...THREAD, isThreadComposer: false, text, threadId: undefined })).toBe(intent);
    });

    it("treats a command with an attachment as a message", () => {
        expect(composerSubmitIntent({ ...THREAD, hasAttachments: true, text: "/compact" })).toBe("send");
        expect(composerSubmitIntent({ ...THREAD, hasAttachments: true, isStreaming: true, text: "/clear" })).toBe("queue");
    });

    it("sends a command typed in a composer other than the thread's own (compact, comparison parent) as a message", () => {
        expect(composerSubmitIntent({ ...THREAD, isThreadComposer: false, text: "/compact" })).toBe("send");
    });
});
