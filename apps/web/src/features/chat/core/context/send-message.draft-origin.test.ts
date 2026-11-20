/**
 * A send carries its draft's not-typed mark (`draftFrom`) to the server, and a send that fails hands the draft back with it, so
 * a resend is marked too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "../stores/chat-ui-store";
import type { SendMessageEnv } from "./send-message";
import { holdSendForSignIn, runSendMessage } from "./send-message";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});
vi.mock("@/features/auth/stores/login-prompt-store", () => {
    return { openLoginPrompt: vi.fn() };
});

const gatewayReply = () =>
    Response.json({ gatewayUrl: "https://gateway.test/stream", messageId: "m1", streamId: "s1", streamToken: "tok", threadId: "t-new" }, { status: 200 });

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => gatewayReply());

const makeEnv = (overrides: Record<string, unknown> = {}): SendMessageEnv =>
    ({
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
        getPendingSettingsFromStore: () => null,
        handleError: vi.fn(),
        isMountedRef: { current: true },
        kickOffMedia: vi.fn(),
        localTarget: undefined,
        lunora: { mutation: vi.fn() },
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
        texts: { bannedContent: () => "", guestNoteNotLocal: () => "", localTextOnly: () => "", sessionNotReady: () => "" },
        threadDataRef: { current: undefined },
        threadId: undefined,
        turnRef: { current: 1 },
        ...overrides,
    }) as unknown as SendMessageEnv;

const sentBody = (): Record<string, unknown> => JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    useChatUIStore.getState().reset();
});

afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
});

describe("runSendMessage not-typed mark", () => {
    it("names the draft's origin in the request, and nothing for the owner's own words", async () => {
        await runSendMessage(makeEnv(), "sign in to my bank", undefined, { draftFrom: "promptLink" });

        expect(sentBody()).toMatchObject({ draftFrom: "promptLink", prompt: "sign in to my bank" });

        fetchMock.mockClear();
        await runSendMessage(makeEnv(), "what is the weather");

        expect(sentBody()).not.toHaveProperty("draftFrom");
    });

    it("hands a failed send's draft back with its mark", async () => {
        fetchMock.mockRejectedValueOnce(new Error("offline"));

        await runSendMessage(makeEnv(), "shared from another app", undefined, { draftFrom: "shellLink" });

        expect(useChatUIStore.getState()).toMatchObject({ composerDraftFrom: "shellLink", composerText: "shared from another app" });
    });

    it("passes the mark to a local model's saved turn, and hands it back when the turn is not saved", async () => {
        const sendLocalTurn = vi.fn(async (args: { onNotSaved: (message: string | undefined) => void }) => {
            args.onNotSaved(undefined);
        });

        await runSendMessage(makeEnv({ localTarget: { endpoint: "local" }, sendLocalTurn }), "a colleague's prompt", undefined, { draftFrom: "sharedPrompt" });

        expect(sendLocalTurn.mock.calls[0]?.[0]).toMatchObject({ draftFrom: "sharedPrompt", prompt: "a colleague's prompt" });
        expect(useChatUIStore.getState()).toMatchObject({ composerDraftFrom: "sharedPrompt", composerText: "a colleague's prompt" });
    });

    it("holds the mark with a send kept for after sign-in", () => {
        holdSendForSignIn("from a link", { draftFrom: "promptLink" });

        expect(useChatUIStore.getState().composerDraftFrom).toBe("promptLink");
        expect(JSON.parse(sessionStorage.getItem("neore:pending-send") ?? "{}")).toMatchObject({ draftFrom: "promptLink", text: "from a link" });
    });
});
