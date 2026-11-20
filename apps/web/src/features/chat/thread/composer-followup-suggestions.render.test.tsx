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

vi.mock("@neore/backend/api", () => {
    return { api: { chat: { functions: { getFollowupSuggestions: "getFollowupSuggestions" } } } };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return {};
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    const mutateAsync = async () => {
        return { suggestions: ["Sign in to my bank and pay the bill"] };
    };

    return {
        useMutation: () => {
            return { mutateAsync };
        },
    };
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
            return { threadId: "thread-1" };
        },
    };
});

vi.mock("./at-bottom-context", () => {
    return { useIsAtBottom: () => true };
});

const { default: ComposerFollowupSuggestions } = await import("./composer-followup-suggestions");

beforeEach(() => {
    useChatUIStore.getState().reset();
});

describe("ComposerFollowupSuggestions", () => {
    it("marks the composer's draft when a suggestion is picked", async () => {
        render(<ComposerFollowupSuggestions />);

        fireEvent.click(await screen.findByText(SUGGESTION));

        expect(useChatUIStore.getState().composerText).toBe(SUGGESTION);
        expect(useChatUIStore.getState().composerDraftFrom).toBe("suggestion");
    });
});
