/**
 * A new thread's first send files it in the project the composer chip picked, once the gateway has returned the thread id.
 * A temporary chat is never filed: the backend keeps it out of every project.
 */
import { api } from "@neore/backend/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingSettings } from "../stores/model-store";
import type { SendMessageEnv } from "./send-message";
import { runSendMessage } from "./send-message";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});

const gatewayReply = () =>
    Response.json(
        { gatewayUrl: "https://gateway.test/stream", messageId: "m1", streamId: "s1", streamToken: "tok", threadId: "t-new" },
        {
            headers: { "Content-Type": "application/json" },
            status: 200,
        },
    );

const envWith = (pending: PendingSettings | null) => {
    const lunora = {
        mutation: vi.fn<(mutation: unknown, args: Record<string, unknown>) => Promise<unknown>>(async () => {
            return { success: true };
        }),
    };

    const env = {
        authGate: { isReady: () => true, wait: async () => true },
        authHeader: () => {
            return {};
        },
        crpc: {
            chat: {
                composite: { getThreadWithData: { queryKey: () => ["composite"] } },
                functions: { getThread: { queryKey: () => ["thread"] } },
            },
        },
        defaultLanguage: "en",
        getChangedSettings: () => null,
        getPendingSettingsFromStore: () => pending,
        handleError: vi.fn(),
        isMountedRef: { current: true },
        kickOffMedia: vi.fn(),
        localTarget: undefined,
        lunora,
        messagesRef: { current: [] },
        model: "m",
        navigate: vi.fn(),
        newChatsTemporary: false,
        queryClient: { setQueryData: vi.fn() },
        refetchSession: vi.fn(),
        sendLocalTurn: vi.fn(),
        setError: vi.fn(),
        setGatewayInfo: vi.fn(),
        setIsRegenerating: vi.fn(),
        setOptimisticMessages: vi.fn(),
        setTransitioningMessage: vi.fn(),
        startTurn: () => 1,
        streamingMessageRef: { current: null },
        texts: {
            bannedContent: () => "banned",
            guestNoteNotLocal: () => "hosted only",
            localTextOnly: () => "text only",
            sessionNotReady: () => "no session",
        },
        threadDataRef: { current: undefined },
        threadId: undefined,
        turnRef: { current: 1 },
    };

    return { env: env as unknown as SendMessageEnv, lunora };
};

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => gatewayReply()),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("runSendMessage project hint", () => {
    it("files a new local-model thread in the picked project once it is saved", async () => {
        const { env, lunora } = envWith({ projectId: "p-billing" });
        const sendLocalTurn = vi.fn(async (args: { onSaved: (saved: { isNewThread: boolean; threadId: string }) => void }) => {
            args.onSaved({ isNewThread: true, threadId: "t-local" });
        });

        Object.assign(env, { localTarget: { endpoint: "local" }, sendLocalTurn });

        await runSendMessage(env, "invoice export");

        expect(lunora.mutation.mock.calls[0]?.[1]).toEqual({ projectId: "p-billing", threadId: "t-local" });
    });

    it("files the new thread in the picked project once the gateway returns its id", async () => {
        const { env, lunora } = envWith({ projectId: "p-billing" });

        await runSendMessage(env, "invoice export");

        expect(lunora.mutation).toHaveBeenCalledTimes(1);
        expect(lunora.mutation.mock.calls[0]?.[0]).toBe(api.projects.functions.moveThreadToProject);
        expect(lunora.mutation.mock.calls[0]?.[1]).toEqual({ projectId: "p-billing", threadId: "t-new" });
    });

    it("moves nothing when no project was picked", async () => {
        const { env, lunora } = envWith(null);

        await runSendMessage(env, "invoice export");

        expect(lunora.mutation).not.toHaveBeenCalled();
    });

    it("moves nothing for a temporary chat, which the backend keeps out of projects", async () => {
        const { env, lunora } = envWith({ isTempChat: true, projectId: "p-billing" });

        await runSendMessage(env, "invoice export");

        expect(lunora.mutation).not.toHaveBeenCalled();
    });
});
