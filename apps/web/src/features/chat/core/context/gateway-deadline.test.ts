// @vitest-environment jsdom

/**
 * A gateway that never answers `/v1/chat` or `/v1/chat/edit` ends in the chat error handler instead of
 * hanging. After a deadline the backend may already have saved the work, so a send does NOT hand the draft
 * back (a resend would duplicate it); the other failures still do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";
import { TimeoutError } from "@/lib/errors";

import { useChatUIStore } from "../stores/chat-ui-store";
import { runEditMessage, runReloadMessage } from "./branch-actions";
import { runSendMessage } from "./send-message";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});
vi.mock("@neore/client-runtime", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("@neore/client-runtime")>()), withUnlockProofBody: (body: unknown) => body };
});

/** A fetch that never answers but honours its abort signal, like the real one. */
const stalledFetch = () =>
    vi.fn(
        (_url: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(init.signal?.reason);
                });
            }),
    );

const message = (id: string, role: "assistant" | "user"): UIMessage =>
    ({ _creationTime: 0, id, key: id, order: 0, parts: [{ text: id, type: "text" }], role, status: "success", stepOrder: 0, text: id }) as unknown as UIMessage;

const base = () => {
    return {
        authHeader: () => {
            return {};
        },
        handleError: vi.fn(),
        isAuthenticated: true,
        localTarget: undefined,
        messagesRef: { current: [message("u1", "user"), message("a1", "assistant")] },
        sendLocalTurn: vi.fn(),
        setError: vi.fn(),
        setHiddenMessageIds: vi.fn(),
        setIsRegenerating: vi.fn(),
        startTurn: () => 1,
        streamingMessageRef: { current: null },
        threadDataRef: { current: undefined },
        threadId: "t1" as string | undefined,
    };
};

describe("gateway deadline in chat actions", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", stalledFetch());
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("send: reports the timeout, drops the optimistic message and keeps the cleared composer", async () => {
        const env = {
            ...base(),
            authGate: { isReady: () => true, set: vi.fn(), wait: vi.fn() },
            crpc: {},
            defaultLanguage: "en",
            getChangedSettings: () => null,
            getPendingSettingsFromStore: () => null,
            isMountedRef: { current: true },
            kickOffMedia: vi.fn(),
            model: "m",
            navigate: vi.fn(),
            newChatsTemporary: false,
            queryClient: {},
            refetchSession: vi.fn(),
            setGatewayInfo: vi.fn(),
            setOptimisticMessages: vi.fn(),
            setTransitioningMessage: vi.fn(),
            texts: { bannedContent: () => "banned", localTextOnly: () => "text only", sessionNotReady: () => "no session" },
            turnRef: { current: 1 },
        };

        useChatUIStore.getState().setComposerText("hello");

        const pending = runSendMessage(env as never, "hello");

        await vi.advanceTimersByTimeAsync(31_000);
        await pending;

        expect(env.handleError).toHaveBeenCalledWith(expect.any(TimeoutError));
        expect(env.setIsRegenerating).toHaveBeenLastCalledWith(false);
        // added once, then removed by the updater passed second
        expect(env.setOptimisticMessages).toHaveBeenCalledTimes(2);
        // The draft is not handed back: the prompt may already be saved.
        expect(useChatUIStore.getState().composerText).toBe("");
    });

    it("regenerate: reports the timeout and shows the hidden replies again", async () => {
        const env = { ...base(), defaultLanguage: "en", getChangedSettings: () => null, kickOffMedia: vi.fn(), model: "m", setGatewayInfo: vi.fn(), turnRef: { current: 1 } };

        const pending = runReloadMessage(env as never, "a1");

        await vi.advanceTimersByTimeAsync(31_000);
        await pending;

        expect(env.handleError).toHaveBeenCalledWith(expect.any(TimeoutError));
        expect(env.setIsRegenerating).toHaveBeenLastCalledWith(false);
        expect(env.setHiddenMessageIds).toHaveBeenCalledTimes(2);
    });

    it("edit: reports the timeout and shows the hidden replies again", async () => {
        const env = { ...base(), setOptimisticMessages: vi.fn() };

        const pending = runEditMessage(env as never, "u1", "edited");

        await vi.advanceTimersByTimeAsync(31_000);
        await pending;

        expect(env.handleError).toHaveBeenCalledWith(expect.any(TimeoutError));
        expect(env.setIsRegenerating).toHaveBeenLastCalledWith(false);
        expect(env.setHiddenMessageIds).toHaveBeenCalledTimes(2);
    });
});
