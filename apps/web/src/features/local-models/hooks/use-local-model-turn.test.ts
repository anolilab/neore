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

/** Whether a `beforeunload` is cancelled, i.e. whether a close warning is registered. */
const isGuarded = (): boolean => {
    const event = new Event("beforeunload", { cancelable: true });

    globalThis.dispatchEvent(event);

    return event.defaultPrevented;
};

/** A turn that stays in flight until `finish` is called. */
const heldTurn = () => {
    let finish!: () => void;
    // The tsconfig lib predates `Promise.withResolvers`.
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
    });

    runLocalTurn.mockImplementationOnce(async () => {
        await gate;

        return { outcome: "complete", saved: true, threadId: "t1" };
    });

    return finish;
};

describe("useLocalModelTurn close warning", () => {
    it("guards the tab while a reply is in flight and releases it once saved", async () => {
        const finish = heldTurn();
        const { result } = renderHook(() => useLocalModelTurn(MODEL, new Set()));
        let sent!: Promise<void>;

        act(() => {
            sent = result.current.send(sendOptions({}));
        });

        expect(isGuarded()).toBe(true);

        await act(async () => {
            finish();
            await sent;
        });

        expect(isGuarded()).toBe(false);
    });

    it("keeps the warning while a second reply runs after the first one finished", async () => {
        const finishFirst = heldTurn();
        const finishSecond = heldTurn();
        const { result } = renderHook(() => useLocalModelTurn(MODEL, new Set()));
        let first!: Promise<void>;
        let second!: Promise<void>;

        act(() => {
            first = result.current.send(sendOptions({}));
            second = result.current.send(sendOptions({ branch: { kind: "regenerate", messageId: "m1" } }));
        });

        await act(async () => {
            finishFirst();
            await first;
        });

        expect(isGuarded()).toBe(true);

        await act(async () => {
            finishSecond();
            await second;
        });

        expect(isGuarded()).toBe(false);
    });

    it("keeps the warning after the provider unmounts, until the reply ends", async () => {
        const finish = heldTurn();
        const { result, unmount } = renderHook(() => useLocalModelTurn(MODEL, new Set()));
        let sent!: Promise<void>;

        act(() => {
            sent = result.current.send(sendOptions({}));
        });
        unmount();

        expect(isGuarded()).toBe(true);

        finish();
        await sent;

        expect(isGuarded()).toBe(false);
    });

    it("releases the warning when the save fails, leaving another reply's guard alone", async () => {
        const finishOther = heldTurn();
        const { result } = renderHook(() => useLocalModelTurn(MODEL, new Set()));
        let other!: Promise<void>;

        act(() => {
            other = result.current.send(sendOptions({}));
        });

        saveLocalTurn.mockRejectedValueOnce(new Error("rate limited"));

        await act(async () => {
            await result.current.send(sendOptions({}));
        });

        expect(isGuarded()).toBe(true);

        await act(async () => {
            finishOther();
            await other;
        });

        expect(isGuarded()).toBe(false);
    });
});
