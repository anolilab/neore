// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ReplyCompleteAnnouncement from "./reply-complete-announcement";

const chat = vi.hoisted(() => {
    return { messages: [] as { id: string; role: string; status: string; text: string }[], isStreaming: false, threadId: "thread-1" };
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
        useChatMessages: () => {
            return { isStreaming: chat.isStreaming, messages: chat.messages };
        },
        useChatThread: () => {
            return { threadId: chat.threadId };
        },
    };
});

const reply = (id: string, status = "success") => {
    return { id, role: "assistant", status, text: "hi" };
};

const setChat = (isStreaming: boolean, messages: ReturnType<typeof reply>[]) => {
    chat.isStreaming = isStreaming;
    chat.messages = messages;
};

const region = () => screen.getByRole("status");

describe("reply complete announcement", () => {
    beforeEach(() => {
        setChat(false, [reply("old")]);
    });

    it("is a polite status region that starts empty", () => {
        render(<ReplyCompleteAnnouncement />);

        expect(region().getAttribute("aria-live")).toBe("polite");
        expect(region().textContent).toBe("");
    });

    it("announces once when a streamed reply finishes, not per chunk, and never the text", () => {
        const view = render(<ReplyCompleteAnnouncement />);

        setChat(true, [reply("old"), reply("new", "streaming")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        setChat(true, [reply("old"), { ...reply("new", "streaming"), text: "a longer chunk" }]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("");

        setChat(false, [reply("old"), reply("new")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("Reply complete");
        expect(region().textContent).not.toContain("hi");

        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("Reply complete");
    });

    it("clears while the next reply streams so its completion is announced again", () => {
        const view = render(<ReplyCompleteAnnouncement />);

        setChat(true, [reply("old"), reply("a", "streaming")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        setChat(false, [reply("old"), reply("a")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("Reply complete");

        setChat(true, [reply("old"), reply("a"), reply("b", "streaming")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("");

        setChat(false, [reply("old"), reply("a"), reply("b")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("Reply complete");
    });

    it("stays silent for history, a failed reply, and a thread switch", () => {
        const view = render(<ReplyCompleteAnnouncement />);

        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("");

        setChat(true, [reply("old"), reply("new", "streaming")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        setChat(false, [reply("old"), reply("new", "failed")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("");

        setChat(true, [reply("old"), reply("n2", "streaming")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        setChat(false, [reply("old"), reply("n2")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("Reply complete");

        act(() => {
            chat.threadId = "thread-2";
        });
        setChat(false, [reply("other")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("");
    });

    it("stays silent when a send fails and the earlier reply is last again", () => {
        const view = render(<ReplyCompleteAnnouncement />);

        setChat(true, [reply("old"), { id: "prompt", role: "user", status: "success", text: "hi" }]);
        view.rerender(<ReplyCompleteAnnouncement />);
        setChat(false, [reply("old")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("");
    });

    it("stays silent when a regenerate fails and the hidden reply comes back", () => {
        setChat(false, [reply("first"), reply("second")]);
        const view = render(<ReplyCompleteAnnouncement />);

        setChat(true, [reply("first")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        setChat(false, [reply("first"), reply("second")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("");
    });

    it("uses history that loads after mount as the baseline", () => {
        setChat(false, []);
        const view = render(<ReplyCompleteAnnouncement />);

        setChat(false, [reply("old")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        setChat(true, [reply("old")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        setChat(false, [reply("old")]);
        view.rerender(<ReplyCompleteAnnouncement />);
        expect(region().textContent).toBe("");
    });
});
