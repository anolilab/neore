// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import CompletionSound from "./completion-sound";

const ping = vi.hoisted(() => vi.fn());
const chat = vi.hoisted(() => {
    return { messages: [] as { id: string; role: string; status: string; text: string }[], isStreaming: false, threadId: "thread-1" };
});

vi.mock("./completion-ping", () => {
    return { default: ping };
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

describe("completion sound", () => {
    beforeEach(() => {
        ping.mockClear();
        setChat(false, [reply("old")]);
        useUIStateStore.setState((state) => {
            return { preferences: { ...state.preferences, soundEffects: true } };
        });
    });

    it("pings once when a streamed reply finishes", () => {
        const view = render(<CompletionSound />);

        setChat(true, [reply("old"), reply("new", "streaming")]);
        view.rerender(<CompletionSound />);
        expect(ping).not.toHaveBeenCalled();

        setChat(false, [reply("old"), reply("new")]);
        view.rerender(<CompletionSound />);
        expect(ping).toHaveBeenCalledTimes(1);

        view.rerender(<CompletionSound />);
        expect(ping).toHaveBeenCalledTimes(1);
    });

    it("stays silent for a failed reply", () => {
        const view = render(<CompletionSound />);

        setChat(true, [reply("old"), reply("new", "streaming")]);
        view.rerender(<CompletionSound />);
        setChat(false, [reply("old"), reply("new", "failed")]);
        view.rerender(<CompletionSound />);

        expect(ping).not.toHaveBeenCalled();
    });

    it("stays silent for history that was already there", () => {
        const view = render(<CompletionSound />);

        view.rerender(<CompletionSound />);

        expect(ping).not.toHaveBeenCalled();
    });

    it("does nothing when the setting is off", () => {
        useUIStateStore.setState((state) => {
            return { preferences: { ...state.preferences, soundEffects: false } };
        });

        const view = render(<CompletionSound />);

        setChat(true, [reply("old"), reply("new", "streaming")]);
        view.rerender(<CompletionSound />);
        setChat(false, [reply("old"), reply("new")]);
        view.rerender(<CompletionSound />);

        expect(ping).not.toHaveBeenCalled();
    });
});
