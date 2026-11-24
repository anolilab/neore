import { describe, expect, it, vi } from "vitest";

import type { ReloadMessageEnv } from "./branch-actions";
import { runReloadMessage } from "./branch-actions";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});

const messages = [
    { id: "u1", role: "user", text: "write it again" },
    // A saved local reply records the bare local model id, not the `custom:<provider>/<model>` the composer holds.
    { id: "a1", localReply: true, model: "llama3", role: "assistant", status: "failed" },
];

const envFor = (overrides: Partial<ReloadMessageEnv>): ReloadMessageEnv =>
    ({
        authHeader: vi.fn(),
        defaultLanguage: "en",
        getChangedSettings: () => null,
        handleError: vi.fn(),
        isAuthenticated: true,
        kickOffMedia: vi.fn(),
        localTarget: undefined,
        messagesRef: { current: messages },
        model: "gateway-model",
        sendLocalTurn: vi.fn(),
        setError: vi.fn(),
        setGatewayInfo: vi.fn(),
        setHiddenMessageIds: vi.fn(),
        setIsRegenerating: vi.fn(),
        startTurn: () => 1,
        streamingMessageRef: { current: null },
        threadDataRef: { current: null },
        threadId: "t1",
        turnRef: { current: 0 },
        ...overrides,
    }) as unknown as ReloadMessageEnv;

describe("runReloadMessage for a local reply", () => {
    it("refuses to send a local reply to the gateway or another model", async () => {
        expect.assertions(3);

        const sendLocalTurn = vi.fn();
        const setIsRegenerating = vi.fn();

        // The viewer now has a gateway model selected: the local reply must not be regenerated through it.
        await expect(runReloadMessage(envFor({ sendLocalTurn, setIsRegenerating }), "a1")).resolves.toBe("model-unavailable");
        expect(sendLocalTurn).not.toHaveBeenCalled();
        expect(setIsRegenerating).not.toHaveBeenCalled();
    });

    it("refuses a local reply when a different local model is selected", async () => {
        expect.assertions(2);

        const sendLocalTurn = vi.fn();
        const localTarget = { baseUrl: "http://localhost:11434", modelId: "qwen", providerId: "ollama", providerName: "Ollama" };

        await expect(runReloadMessage(envFor({ localTarget, model: "custom:ollama/qwen", sendLocalTurn }), "a1")).resolves.toBe("model-unavailable");
        expect(sendLocalTurn).not.toHaveBeenCalled();
    });

    it("regenerates a local reply on the local model that wrote it", async () => {
        expect.assertions(2);

        const sendLocalTurn = vi.fn();
        const localTarget = { baseUrl: "http://localhost:11434", modelId: "llama3", providerId: "ollama", providerName: "Ollama" };

        await expect(runReloadMessage(envFor({ localTarget, model: "custom:ollama/llama3", sendLocalTurn }), "a1")).resolves.toBe(true);
        expect(sendLocalTurn).toHaveBeenCalledTimes(1);
    });
});
