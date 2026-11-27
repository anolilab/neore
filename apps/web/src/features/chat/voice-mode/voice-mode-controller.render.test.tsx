/**
 * A spoken utterance is joined onto the draft the composer held when listening began: a draft the owner did not type keeps
 * its mark on the send (`core/utils/draft-origin.ts`), and the spoken words alone carry none.
 */
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import type { UtteranceDetectorOptions } from "./utterance-detector";
import { sendVoiceModeEvent } from "./voice-mode-store";

const harness = vi.hoisted(() => {
    return {
        detector: undefined as { onUtterance: (text: string) => void } | undefined,
        sendMessage: vi.fn(async () => undefined),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatActions: () => {
            return { sendMessage: harness.sendMessage };
        },
        useChatError: () => {
            return { error: null };
        },
        useChatMessages: () => {
            return { isStreaming: false, messages: [] };
        },
        useChatThread: () => {
            return { threadId: "thread-1" };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: undefined };
        },
    };
});

vi.mock("./use-speak-reply", () => {
    return { default: () => vi.fn() };
});

vi.mock("./listen", () => {
    return {
        classifyListenError: () => "other",
        startListening: async () => {
            return { stop: async () => undefined };
        },
    };
});

vi.mock("./utterance-detector", () => {
    return {
        createUtteranceDetector: (options: UtteranceDetectorOptions) => {
            harness.detector = options as unknown as { onUtterance: (text: string) => void };

            return { commit: vi.fn(), dispose: vi.fn(), flush: vi.fn(), partial: vi.fn() };
        },
    };
});

const { default: VoiceModeController } = await import("./voice-mode-controller");

afterEach(() => {
    sendVoiceModeEvent({ type: "STOP" });
    useChatUIStore.getState().reset();
    harness.detector = undefined;
    harness.sendMessage.mockClear();
});

/** Listening starts on `draft` (marked `mark`), and the owner then says `words`. */
const speak = async (draft: string, mark: "promptLink" | undefined, words: string): Promise<void> => {
    useChatUIStore.getState().setComposerText(draft);
    useChatUIStore.getState().setComposerDraftFrom(mark);
    sendVoiceModeEvent({ type: "START" });
    render(<VoiceModeController />);

    await waitFor(() => {
        expect(harness.detector).toBeDefined();
    });

    harness.detector?.onUtterance(words);
};

describe("VoiceModeController not-typed mark", () => {
    it("sends an utterance joined onto a marked draft with the draft's mark", async () => {
        await speak("Sign in to my bank and move the savings", "promptLink", "go ahead");

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledWith(expect.stringContaining("go ahead"), undefined, { draftFrom: "promptLink" });
        });
    });

    it("sends the owner's own spoken words unmarked", async () => {
        await speak("", undefined, "what is the weather");

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledWith("what is the weather", undefined, { draftFrom: undefined });
        });
    });
});
