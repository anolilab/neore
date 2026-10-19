import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import useLocalModelTurn from "./use-local-model-turn";

const saveLocalTurn = vi.fn();
const runLocalTurn = vi.fn();

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { i18n: { _: String } };
        },
    };
});

vi.mock("@/features/auth/hooks/use-is-anonymous", () => {
    return {
        default: () => {
            return { isAnonymous: false };
        },
    };
});

vi.mock("@/features/settings/lib/custom-models", () => {
    return {
        findLocalModelTarget: () => {
            return { baseUrl: "http://localhost:11434/v1", modelId: "llama3.2:3b" };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    custom_providers: { listCustomProviders: { queryOptions: (args: unknown) => args } },
                    local_models: {
                        saveLocalTurn: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skipToken"),
        useMutation: () => {
            return { mutateAsync: saveLocalTurn };
        },
        useQuery: () => {
            return { data: undefined };
        },
    };
});

// The real turn runner streams from the user's machine; here it only calls `save`, which is the path under test.
vi.mock("../lib/run-local-turn", () => {
    return {
        runLocalTurn: (options: { prompt: string; save: (input: unknown) => Promise<unknown> }) => runLocalTurn(options),
    };
});

const MODEL = "custom:ollama/llama3.2:3b";

const sendOptions = (overrides: Record<string, unknown>) => {
    return {
        history: [],
        onNotSaved: vi.fn(),
        onSaved: vi.fn(),
        prompt: "hi",
        threadId: undefined,
        ...overrides,
    };
};

beforeEach(() => {
    saveLocalTurn.mockReset().mockResolvedValue({ assistantMessageId: "a1", threadId: "t1", userMessageId: "u1" });
    runLocalTurn.mockReset().mockImplementation(async (options: { prompt: string; save: (input: unknown) => Promise<{ threadId: string }> }) => {
        const saved = await options.save({ outcome: "complete", prompt: options.prompt, reply: "hello" });

        return { outcome: "complete", saved: true, threadId: saved.threadId };
    });
});

describe("useLocalModelTurn temporary choice", () => {
    it("saves a new chat as temporary with the given retention", async () => {
        const { result } = renderHook(() => useLocalModelTurn(MODEL, new Set()));

        await act(async () => {
            await result.current.send(sendOptions({ temporary: { retentionHours: 72, temporary: true } }));
        });

        expect(saveLocalTurn).toHaveBeenCalledWith(expect.objectContaining({ retentionHours: 72, temporary: true }));
    });

    it("omits the flag when the new chat was not set to temporary", async () => {
        const { result } = renderHook(() => useLocalModelTurn(MODEL, new Set()));

        await act(async () => {
            await result.current.send(sendOptions({ temporary: undefined }));
        });

        expect(saveLocalTurn.mock.calls[0]?.[0]).not.toHaveProperty("temporary");
        expect(saveLocalTurn.mock.calls[0]?.[0]).not.toHaveProperty("retentionHours");
    });

    it("never sends the flag for a turn into an existing thread", async () => {
        const { result } = renderHook(() => useLocalModelTurn(MODEL, new Set()));

        await act(async () => {
            await result.current.send(sendOptions({ temporary: { temporary: true }, threadId: "t0" }));
        });

        expect(saveLocalTurn.mock.calls[0]?.[0]).not.toHaveProperty("temporary");
        expect(saveLocalTurn.mock.calls[0]?.[0]).toMatchObject({ threadId: "t0" });
    });
});
