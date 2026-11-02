import { describe, expect, it, vi } from "vitest";

import type { SendMessageEnv } from "./send-message";
import { runSendMessage } from "./send-message";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});
vi.mock("@/lib/lunora/crpc", () => {
    return { useCRPC: vi.fn() };
});

const HIDDEN = "\u{E0041}\u{E0042}\u{202E}";

const localEnv = (sendLocalTurn: ReturnType<typeof vi.fn>): SendMessageEnv =>
    ({
        authGate: { isReady: () => true, wait: async () => true },
        authHeader: vi.fn(),
        crpc: {},
        defaultLanguage: "en",
        getPendingSettingsFromStore: () => null,
        handleError: vi.fn(),
        localTarget: { endpoint: "local" },
        messagesRef: { current: [] },
        model: "local-model",
        refetchSession: vi.fn(),
        sendLocalTurn,
        setError: vi.fn(),
        setIsRegenerating: vi.fn(),
        setOptimisticMessages: vi.fn(),
        startTurn: () => 1,
        streamingMessageRef: { current: null },
        texts: { bannedContent: () => "", localTextOnly: () => "", sessionNotReady: () => "" },
        threadDataRef: { current: null },
        threadId: undefined,
        turnRef: { current: 0 },
    }) as unknown as SendMessageEnv;

describe("runSendMessage hidden characters", () => {
    it("hands a local model the text without tag or bidi characters (voice sends raw text)", async () => {
        const sendLocalTurn = vi.fn();

        await runSendMessage(localEnv(sendLocalTurn), `what is the weather${HIDDEN}`);

        expect(sendLocalTurn).toHaveBeenCalledTimes(1);
        expect(sendLocalTurn.mock.calls[0]?.[0].prompt).toBe("what is the weather");
    });

    it("sends nothing for a message that was only hidden characters", async () => {
        const sendLocalTurn = vi.fn();

        await runSendMessage(localEnv(sendLocalTurn), HIDDEN);

        expect(sendLocalTurn).not.toHaveBeenCalled();
    });
});
