import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** Animation frames that run only when the test says so. */
const stubFrames = () => {
    const frames = new Map<number, FrameRequestCallback>();
    let lastId = 0;

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        lastId += 1;
        frames.set(lastId, callback);

        return lastId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
        frames.delete(id);
    });

    return () => {
        act(() => {
            const due = [...frames.values()];

            frames.clear();

            for (const frame of due) {
                frame(0);
            }
        });
    };
};

type StreamedOptions = { onUpdate: (text: string, reasoning: string) => void; prompt: string; save: (input: unknown) => Promise<{ threadId: string }> };

/** A turn that streams through `onUpdate` and saves `reply` once `finish` is called. */
const streamingTurn = (reply: string) => {
    const turn = { finish: undefined as unknown as () => void, onUpdate: undefined as unknown as StreamedOptions["onUpdate"] };

    const gate = new Promise<void>((resolve) => {
        turn.finish = resolve;
    });

    runLocalTurn.mockImplementationOnce(async (options: StreamedOptions) => {
        turn.onUpdate = options.onUpdate;
        await gate;

        const saved = await options.save({ outcome: "complete", prompt: options.prompt, reply });

        return { outcome: "complete", saved: true, threadId: saved.threadId };
    });

    return turn;
};

/** The hook, recording the live reply of every render. */
const renderTurn = () => {
    const rendered: ({ status: string | undefined; text: string } | null)[] = [];
    const view = renderHook(() => {
        const turn = useLocalModelTurn(MODEL, new Set());

        rendered.push(turn.streamingMessage ? { status: turn.streamingMessage.status, text: turn.streamingMessage.text } : null);

        return turn;
    });

    return { rendered, result: view.result };
};

describe("useLocalModelTurn streaming updates", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("shows the tokens that arrive within one frame in one update", async () => {
        const runFrames = stubFrames();
        const turn = streamingTurn("Hello");
        const { rendered, result } = renderTurn();
        let sent!: Promise<void>;

        act(() => {
            sent = result.current.send(sendOptions({}));
        });

        const rendersBefore = rendered.length;

        // Five network reads, each its own task, before the next frame.
        for (const text of ["H", "He", "Hel", "Hell", "Hello"]) {
            act(() => {
                turn.onUpdate(text, "");
            });
        }

        expect(rendered).toHaveLength(rendersBefore);

        runFrames();

        expect(rendered.slice(rendersBefore).map((reply) => reply?.text)).toStrictEqual(["Hello"]);

        await act(async () => {
            turn.finish();
            await sent;
        });
    });

    it("never shows an older turn's queued text in a newer turn's reply", async () => {
        const runFrames = stubFrames();
        const older = streamingTurn("old reply");
        const newer = streamingTurn("new reply");
        const { rendered, result } = renderTurn();
        let olderSent!: Promise<void>;
        let newerSent!: Promise<void>;

        act(() => {
            olderSent = result.current.send(sendOptions({}));
        });
        act(() => {
            older.onUpdate("old reply", "old thoughts");
        });

        // A regenerate starts before the older turn's frame ran.
        act(() => {
            newerSent = result.current.send(sendOptions({ branch: { kind: "regenerate", messageId: "u1" } }));
        });

        const newerStart = rendered.length - 1;

        runFrames();

        expect(rendered.slice(newerStart).map((reply) => reply?.text)).not.toContain("old reply");
        expect(result.current.streamingMessage?.parts).toStrictEqual([{ text: "", type: "text" }]);

        await act(async () => {
            older.finish();
            newer.finish();
            await Promise.all([olderSent, newerSent]);
        });
    });

    it("shows the last tokens, still waiting for a frame, when the reply is saved", async () => {
        stubFrames();
        const turn = streamingTurn("Hello");
        const { rendered, result } = renderTurn();
        let sent!: Promise<void>;

        act(() => {
            sent = result.current.send(sendOptions({}));
        });
        act(() => {
            turn.onUpdate("Hel", "");
        });
        act(() => {
            turn.onUpdate("Hello", "");
        });

        await act(async () => {
            turn.finish();
            await sent;
        });

        expect(rendered.at(-1)).toStrictEqual({ status: "success", text: "Hello" });
    });
});
