// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FIND_IN_THREAD_EVENT } from "@/features/keyboard/lib/find-in-thread-target";

import ThreadFindBar from "./thread-find-bar";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatMessages: () => {
            return { loadMore: vi.fn(), messages: [], messagesStatus: "Exhausted" };
        },
        useChatThread: () => {
            return { threadId: "thread-1" };
        },
    };
});
vi.mock("../message-list", () => {
    return { scrollToMessage: vi.fn() };
});

describe("ThreadFindBar", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps every key typed right after it opens, though a frame comes between them", async () => {
        vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
        const user = userEvent.setup();

        render(<ThreadFindBar />);
        act(() => {
            globalThis.dispatchEvent(new CustomEvent(FIND_IN_THREAD_EVENT));
        });
        const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Find in thread" });

        await user.type(input, "zeb");
        // A frame that selected the field here would have the next key replace what was typed.
        act(() => {
            vi.advanceTimersToNextFrame();
        });
        await user.keyboard("ra");

        expect(input.value).toBe("zebra");
    });
});
