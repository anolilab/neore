/**
 * The jump-to-my-last-message control and shortcut resolve one target: the newest prompt the person sent among
 * the rendered messages. A goal's own instruction is also a user-role row but is never rendered, so it must not
 * be the target, or the jump would find nothing and report the message missing.
 */
import { GOAL_CONTINUATION_AGENT } from "@neore/backend/chat/goals";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";
import { showInfo } from "@/lib/toast";

import JumpToLastMessageListener, { jumpTargetId } from "./jump-to-last-message";

// Unit tests do not compile the Lingui macros.
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showInfo: vi.fn() };
});

const { scrollToMessageMock } = vi.hoisted(() => {
    return { scrollToMessageMock: vi.fn() };
});

vi.mock("@/features/chat/core/utils/scroll-to-message", () => {
    return { scrollToMessage: scrollToMessageMock };
});

const { chatState } = vi.hoisted(() => {
    return { chatState: { messages: [] as unknown[], threadId: "thread-1" } };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatMessages: () => {
            return { messages: chatState.messages };
        },
        useChatThread: () => {
            return { threadId: chatState.threadId };
        },
    };
});

const message = (id: string, role: "assistant" | "user", extra: Record<string, unknown> = {}): UIMessage =>
    ({ id, parts: [], role, ...extra }) as unknown as UIMessage;

const press = () => {
    act(() => {
        globalThis.dispatchEvent(new Event("jumpToLastMessage"));
    });
};

beforeEach(() => {
    chatState.threadId = "thread-1";
    chatState.messages = [];
    vi.mocked(showInfo).mockClear();
    scrollToMessageMock.mockClear();
});

describe(jumpTargetId, () => {
    it("is the newest prompt of the person's, not a reply", () => {
        const messages = [message("u1", "user"), message("a1", "assistant"), message("u2", "user"), message("a2", "assistant")];

        expect(jumpTargetId(messages)).toBe("u2");
    });

    it("skips a goal's own instruction, which is never rendered", () => {
        const messages = [
            message("u1", "user"),
            message("a1", "assistant"),
            message("goal-instruction", "user", { agentName: GOAL_CONTINUATION_AGENT }),
            message("a2", "assistant"),
        ];

        expect(jumpTargetId(messages)).toBe("u1");
    });

    it("is undefined when no prompt of the person's is loaded", () => {
        expect(jumpTargetId([message("a1", "assistant")])).toBeUndefined();
        expect(jumpTargetId([])).toBeUndefined();
    });
});

describe("jump to my last message shortcut", () => {
    it("scrolls to the newest prompt in the open thread", () => {
        chatState.messages = [message("u1", "user"), message("a1", "assistant"), message("u2", "user"), message("a2", "assistant")];
        render(<JumpToLastMessageListener />);

        press();

        expect(scrollToMessageMock).toHaveBeenCalledTimes(1);
        expect(scrollToMessageMock).toHaveBeenCalledWith("u2", { threadId: "thread-1" });
        expect(showInfo).not.toHaveBeenCalled();
    });

    it("reads the messages as they are at press time, not at mount", () => {
        chatState.messages = [message("u1", "user")];
        const { rerender } = render(<JumpToLastMessageListener />);

        chatState.messages = [message("u1", "user"), message("a1", "assistant"), message("u2", "user")];
        rerender(<JumpToLastMessageListener />);
        press();

        expect(scrollToMessageMock).toHaveBeenCalledWith("u2", { threadId: "thread-1" });
    });

    it("says so, and does not scroll, when no prompt of the person's is loaded", () => {
        chatState.messages = [message("a1", "assistant")];
        render(<JumpToLastMessageListener />);

        press();

        expect(scrollToMessageMock).not.toHaveBeenCalled();
        expect(showInfo).toHaveBeenCalledTimes(1);
    });

    it("stops listening on unmount", () => {
        chatState.messages = [message("u1", "user")];
        const { unmount } = render(<JumpToLastMessageListener />);

        unmount();
        press();

        expect(scrollToMessageMock).not.toHaveBeenCalled();
    });
});

afterEach(() => {
    vi.clearAllMocks();
});
