// @vitest-environment jsdom

/** A follow-up suggestion the model wrote goes into the composer marked: sent, it is not the person's own words. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

const SUGGESTION = "Sign in to my bank and pay the bill";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

// The panel reads the cached suggestions for the latest reply; the cache holds the suggestion for "m2".
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    functions: {
                        getCachedFollowupSuggestions: {
                            queryOptions: (input: unknown) => {
                                return { queryKey: ["getCachedFollowupSuggestions", input] };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@neore/client-runtime", () => {
    return { useUnlockProof: () => undefined };
});

// One stable object: a fresh one per render would make the panel's effect set new suggestions on every render.
const cached = vi.hoisted(() => {
    return { data: { lastMessageId: "m2", suggestions: ["Sign in to my bank and pay the bill"] }, isFetching: false };
});

// The options each read is sent with, so a test can see whether the cache query is enabled.
const readOptions = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => {
    return {
        useQuery: (options: unknown) => {
            readOptions(options);

            return cached;
        },
    };
});

// The thread the chat shows; a test sets it to a locked chat to check the read is held back.
const chat = vi.hoisted(() => {
    return { thread: undefined as { lockedAt?: number } | undefined };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    const messages = [
        { id: "m1", parts: [], role: "user" },
        { id: "m2", parts: [], role: "assistant" },
    ];

    return {
        useChatIsRunning: () => false,
        useChatMessages: () => {
            return { messages };
        },
        useChatThread: () => {
            return { thread: chat.thread, threadId: "thread-1" };
        },
    };
});

vi.mock("./at-bottom-context", () => {
    return { useIsAtBottom: () => true };
});

const { default: ComposerFollowupSuggestions } = await import("./composer-followup-suggestions");

beforeEach(() => {
    useChatUIStore.getState().reset();
    chat.thread = undefined;
    readOptions.mockClear();
});

describe("ComposerFollowupSuggestions", () => {
    it("marks the composer's draft when a suggestion is picked", async () => {
        render(<ComposerFollowupSuggestions />);

        fireEvent.click(await screen.findByText(SUGGESTION));

        expect(useChatUIStore.getState().composerText).toBe(SUGGESTION);
        expect(useChatUIStore.getState().composerDraftFrom).toBe("suggestion");
    });

    it("reads the cache for an open chat", () => {
        render(<ComposerFollowupSuggestions />);

        expect(readOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    });

    it("does not read the cache for a locked chat without its unlock proof", () => {
        chat.thread = { lockedAt: 1000 };

        render(<ComposerFollowupSuggestions />);

        expect(readOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    });
});
