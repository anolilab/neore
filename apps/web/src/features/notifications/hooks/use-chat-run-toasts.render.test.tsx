// @vitest-environment jsdom

/**
 * Each chat toast is gated by its own setting: a toggle that is off suppresses only its toast, and the other two still
 * show. A toast fires on a transition (a run ending, a reply erroring, a call starting to wait), never on the first snapshot.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toAppError } from "@/features/chat/core/context/chat-action-shared";
import type { AppError } from "@/lib/errors";

import type { ChatToastSettings, ToastMessage } from "../lib/chat-toasts";
import useChatRunToasts from "./use-chat-run-toasts";

const toastSuccess = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => {
    return { toast: { error: toastError, success: toastSuccess, warning: toastWarning } };
});
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

interface Props {
    activeStreamId: string | null;
    error: AppError | null;
    messages: ReadonlyArray<ToastMessage>;
    settings: ChatToastSettings | null | undefined;
    threadId: string | undefined;
}

// A thread with its first message in it: a call can only start waiting after that.
const userMessage: Props["messages"] = [{ parts: [{ text: "hello", type: "text" }] }];
const idle: Props = { activeStreamId: null, error: null, messages: userMessage, settings: {}, threadId: "thread-1" };
const streaming = (props: Props): Props => {
    return { ...props, activeStreamId: "stream-1" };
};
const waitingOn = (toolCallId: string): Props["messages"] => [{ parts: [{ state: "approval-requested", toolCallId, type: "tool-shell" }] }];

/** Starts a run, then ends it cleanly. */
const finishRun = (rerender: (props: Props) => void, props: Props): void => {
    rerender(streaming(props));
    rerender({ ...props, activeStreamId: null });
};

const setup = (initial: Props) => renderHook((props: Props) => useChatRunToasts(props), { initialProps: initial });

beforeEach(() => {
    toastSuccess.mockClear();
    toastWarning.mockClear();
    toastError.mockClear();
});

describe("useChatRunToasts: each toggle suppresses its own toast", () => {
    it("shows no finished toast when the finished toggle is off", () => {
        const { rerender } = setup({ ...idle, settings: { chatFinishedToastEnabled: false } });

        finishRun(rerender, { ...idle, settings: { chatFinishedToastEnabled: false } });

        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("shows no failed toast when the failed toggle is off", () => {
        const { rerender } = setup({ ...idle, settings: { chatFailedToastEnabled: false } });

        rerender({ ...idle, error: toAppError(new Error("Reply failed")), settings: { chatFailedToastEnabled: false } });

        expect(toastError).not.toHaveBeenCalled();
    });

    it("shows no needs-input toast when the input toggle is off", () => {
        const { rerender } = setup({ ...idle, settings: { chatInputToastEnabled: false } });

        rerender({ ...idle, messages: waitingOn("call-1"), settings: { chatInputToastEnabled: false } });

        expect(toastWarning).not.toHaveBeenCalled();
    });
});

describe("useChatRunToasts: a run's outcome", () => {
    it("shows a failed toast, not a finished one, when the stream ends on an errored reply", () => {
        const erroredReply: Props["messages"] = [
            { parts: [{ text: "hello", type: "text" }], role: "user" },
            { parts: [], role: "assistant", status: "error" },
        ];
        const { rerender } = setup({ ...idle, settings: {} });

        finishRun(rerender, { ...idle, messages: erroredReply, settings: {} });

        expect(toastSuccess).not.toHaveBeenCalled();
        expect(toastError).toHaveBeenCalledTimes(1);
    });

    it("suppresses the failed toast for an errored reply when the failed toggle is off, and still shows nothing finished", () => {
        const erroredReply: Props["messages"] = [{ parts: [], role: "assistant", status: "error" }];
        const { rerender } = setup({ ...idle, settings: { chatFailedToastEnabled: false } });

        finishRun(rerender, { ...idle, messages: erroredReply, settings: { chatFailedToastEnabled: false } });

        expect(toastError).not.toHaveBeenCalled();
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("shows a finished toast when a browser-local reply ends", () => {
        const { rerender } = setup({ ...idle, settings: {} });

        rerender({ ...idle, activeStreamId: "local-browser-reply", settings: {} });
        rerender({ ...idle, activeStreamId: null, settings: {} });

        expect(toastSuccess).toHaveBeenCalledTimes(1);
    });
});

describe("useChatRunToasts: settling a run", () => {
    const streamingReply: Props["messages"] = [{ parts: [], role: "assistant", status: "streaming" }];
    const erroredReply: Props["messages"] = [{ parts: [], role: "assistant", status: "error" }];

    it("shows the finished toast when only an older turn's approval is still waiting", () => {
        const stale = waitingOn("stale-call");
        const { rerender } = setup({ ...idle, messages: stale, settings: {} });

        finishRun(rerender, { ...idle, messages: stale, settings: {} });

        expect(toastSuccess).toHaveBeenCalledTimes(1);
    });

    it("waits for the reply to settle before deciding the outcome", () => {
        const { rerender } = setup({ ...idle, settings: {} });

        rerender({ ...idle, activeStreamId: "stream-1", messages: streamingReply, settings: {} });
        rerender({ ...idle, activeStreamId: null, messages: streamingReply, settings: {} });

        expect(toastSuccess).not.toHaveBeenCalled();

        rerender({ ...idle, activeStreamId: null, messages: erroredReply, settings: {} });

        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("decides a finished run once the settle window passes, even if the reply stays streaming", () => {
        vi.useFakeTimers();

        try {
            const { rerender } = setup({ ...idle, settings: {} });

            rerender({ ...idle, activeStreamId: "stream-1", messages: streamingReply, settings: {} });
            rerender({ ...idle, activeStreamId: null, messages: streamingReply, settings: {} });

            expect(toastSuccess).not.toHaveBeenCalled();

            vi.advanceTimersByTime(2000);

            expect(toastSuccess).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("shows one failed toast, not a finished one, when a local reply errors as its stream ends", () => {
        const { rerender } = setup({ ...idle, settings: {} });

        rerender({ ...idle, activeStreamId: "local-browser-reply", settings: {} });
        rerender({ ...idle, activeStreamId: null, error: toAppError(new Error("Reply failed")), settings: {} });

        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastSuccess).not.toHaveBeenCalled();
    });
});

describe("useChatRunToasts: the other toasts still show", () => {
    it("shows the failed and needs-input toasts while the finished toggle is off", () => {
        const { rerender } = setup({ ...idle, settings: { chatFinishedToastEnabled: false } });

        rerender({ ...idle, error: toAppError(new Error("Reply failed")), settings: { chatFinishedToastEnabled: false } });
        rerender({ ...idle, error: null, messages: waitingOn("call-2"), settings: { chatFinishedToastEnabled: false } });

        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastWarning).toHaveBeenCalledTimes(1);
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("shows the finished and needs-input toasts while the failed toggle is off", () => {
        const { rerender } = setup({ ...idle, settings: { chatFailedToastEnabled: false } });

        finishRun(rerender, { ...idle, settings: { chatFailedToastEnabled: false } });
        rerender({ ...idle, messages: waitingOn("call-3"), settings: { chatFailedToastEnabled: false } });

        expect(toastSuccess).toHaveBeenCalledTimes(1);
        expect(toastWarning).toHaveBeenCalledTimes(1);
        expect(toastError).not.toHaveBeenCalled();
    });

    it("shows the finished and failed toasts while the needs-input toggle is off", () => {
        const { rerender } = setup({ ...idle, settings: { chatInputToastEnabled: false } });

        rerender({ ...idle, messages: waitingOn("call-4"), settings: { chatInputToastEnabled: false } });
        finishRun(rerender, { ...idle, messages: waitingOn("call-4"), settings: { chatInputToastEnabled: false } });

        // The run ended with its call still waiting: no finished toast, but the failed one (not waiting) still shows.
        rerender({ ...idle, error: toAppError(new Error("Reply failed")), settings: { chatInputToastEnabled: false } });

        expect(toastWarning).not.toHaveBeenCalled();
        expect(toastError).toHaveBeenCalledTimes(1);
    });

    it("does not announce a call that is waiting when a thread loads after an empty snapshot", () => {
        const { rerender } = setup({ ...idle, messages: [], settings: {} });

        rerender({ ...idle, messages: waitingOn("call-open"), settings: {} });

        expect(toastWarning).not.toHaveBeenCalled();
    });

    it("announces a call that arrives after the thread's first populated snapshot", () => {
        const { rerender } = setup({ ...idle, messages: [], settings: {} });

        rerender({ ...idle, messages: userMessage, settings: {} });
        rerender({ ...idle, messages: waitingOn("call-late"), settings: {} });

        expect(toastWarning).toHaveBeenCalledTimes(1);
    });

    it("announces nothing for a call already waiting when the thread opens", () => {
        setup({ ...idle, messages: waitingOn("call-open") });

        expect(toastWarning).not.toHaveBeenCalled();
    });

    it("shows all three toasts when every toggle is absent (the default)", () => {
        const { rerender } = setup({ ...idle, settings: {} });

        finishRun(rerender, { ...idle, settings: {} });
        rerender({ ...idle, error: toAppError(new Error("Reply failed")), settings: {} });
        rerender({ ...idle, error: null, messages: waitingOn("call-5"), settings: {} });

        expect(toastSuccess).toHaveBeenCalledTimes(1);
        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastWarning).toHaveBeenCalledTimes(1);
    });
});
