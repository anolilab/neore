import { describe, expect, it, vi } from "vitest";

import type { EditMessageEnv } from "./branch-actions";
import { runEditMessage } from "./branch-actions";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});

const HIDDEN = "\u{E0041}\u{E0042}\u{202E}";

const localEnv = (sendLocalTurn: ReturnType<typeof vi.fn>): EditMessageEnv =>
    ({
        authHeader: vi.fn(),
        handleError: vi.fn(),
        isAuthenticated: true,
        localTarget: { endpoint: "local" },
        messagesRef: { current: [{ id: "m1", role: "user" }] },
        sendLocalTurn,
        setError: vi.fn(),
        setHiddenMessageIds: vi.fn(),
        setIsRegenerating: vi.fn(),
        setOptimisticMessages: vi.fn(),
        startTurn: () => 1,
        streamingMessageRef: { current: null },
        threadDataRef: { current: null },
        threadId: "t1",
    }) as unknown as EditMessageEnv;

describe("runEditMessage hidden characters", () => {
    it("hands a local model the edited text without tag or bidi characters", async () => {
        const sendLocalTurn = vi.fn();

        await runEditMessage(localEnv(sendLocalTurn), "m1", `what is the weather${HIDDEN}`);

        expect(sendLocalTurn).toHaveBeenCalledTimes(1);
        expect(sendLocalTurn.mock.calls[0]?.[0].prompt).toBe("what is the weather");
    });

    it("sends nothing for an edit that was only hidden characters", async () => {
        const sendLocalTurn = vi.fn();

        await runEditMessage(localEnv(sendLocalTurn), "m1", HIDDEN);

        expect(sendLocalTurn).not.toHaveBeenCalled();
    });
});
