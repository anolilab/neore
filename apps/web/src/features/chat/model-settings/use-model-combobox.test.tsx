import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useModelStore } from "@/features/chat/core/stores/model-store";

import useModelCombobox from "./use-model-combobox";

const hoisted = vi.hoisted(() => {
    return {
        preview: vi.fn(async (): Promise<unknown> => {
            return { coldStartCostly: false };
        }),
        showError: vi.fn(),
        switchAgent: vi.fn(),
        thread: { current: undefined as unknown },
        trackEvent: vi.fn(),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings[0] };
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: { chat: { agent_switch: { switchThreadAgent: { name: "switch" } }, functions: { updateThread: {} } } } };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skipToken"),
        useMutation: (options: { mutationFn: (...args: unknown[]) => Promise<unknown> }) => {
            return { mutateAsync: options.mutationFn };
        },
        useQuery: () => {
            return { data: hoisted.thread.current };
        },
        useQueryClient: () => {
            return {
                fetchQuery: async () => await hoisted.preview(),
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    agent_switch: {
                        previewAgentSwitch: {
                            queryOptions: () => {
                                return {};
                            },
                        },
                        switchThreadAgent: {
                            mutationOptions: () => {
                                return { mutationFn: hoisted.switchAgent };
                            },
                        },
                    },
                    functions: {
                        getThread: {
                            queryOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
        useLunoraActionOptions: (reference: { name?: string }) => {
            return { mutationFn: reference.name === "switch" ? hoisted.switchAgent : vi.fn() };
        },
    };
});

vi.mock("@/lib/analytics", () => {
    return { trackEvent: hoisted.trackEvent };
});

vi.mock("@/lib/toast", () => {
    return { showError: hoisted.showError, showInfo: vi.fn() };
});

const A = "openai/gpt-4.1-mini";
const B = "google/gemini-2.0-flash-001";

describe("useModelCombobox: a switch that settles after the user opened another thread", () => {
    beforeEach(() => {
        hoisted.thread.current = { _id: "t1", mode: "text", model: A };
        hoisted.switchAgent.mockReset();
        hoisted.showError.mockReset();
        useModelStore.getState().loadThreadData({ mode: "text", model: A }, "t1");
    });

    it("writes the server's answer to the store while the thread is still open", async () => {
        hoisted.switchAgent.mockResolvedValue({ agent: { kind: "model", model: B }, coldStartCostly: false, messageId: "m", switched: true });

        const { result } = renderHook(() => useModelCombobox({ threadId: "t1" }));

        await act(async () => {
            await result.current.changeModel(B);
        });

        expect(useModelStore.getState()).toMatchObject({ selectedModel: B, selectedModelThreadId: "t1" });
    });

    const pickThenNavigate = async (finish: (settle: { reject: (error: Error) => void; resolve: (value: unknown) => void }) => void) => {
        let controls = { reject: (_error: Error) => {}, resolve: (_value: unknown) => {} };
        // The tsconfig lib predates `Promise.withResolvers`.

        const answer = new Promise((resolve, reject) => {
            controls = { reject, resolve };
        });

        // The pick can be dropped before it reaches the server, leaving this rejection unclaimed.
        answer.catch(() => {});
        hoisted.switchAgent.mockReturnValue(answer);

        const { result } = renderHook(() => useModelCombobox({ threadId: "t1" }));
        let pick: Promise<void> = Promise.resolve();

        act(() => {
            pick = result.current.changeModel(B);
        });

        // The user opens another thread before the server answers.
        act(() => {
            useModelStore.getState().loadThreadData({ mode: "text", model: "openai/gpt-5-nano" }, "t2");
        });

        await act(async () => {
            finish(controls);
            await pick;
        });
    };

    it("restores the thread's current agent, not the one it had when the failed pick was made", async () => {
        let controls = { reject: (_error: Error) => {} };
        // The tsconfig lib predates `Promise.withResolvers`.

        const answer = new Promise((_resolve, reject) => {
            controls = { reject };
        });

        hoisted.switchAgent.mockReturnValue(answer);

        const { rerender, result } = renderHook(() => useModelCombobox({ threadId: "t1" }));
        let pick: Promise<void> = Promise.resolve();

        act(() => {
            pick = result.current.changeModel("openai/gpt-5-nano");
        });

        // An earlier pick already switched the thread to B on the server, and the live row arrives first.
        hoisted.thread.current = { _id: "t1", activeAgent: { kind: "model", model: B }, mode: "text", model: A };
        rerender();

        await act(async () => {
            controls.reject(new Error("boom"));
            await pick;
        });

        expect(useModelStore.getState()).toMatchObject({ selectedModel: B, selectedModelThreadId: "t1" });
    });

    it("leaves the store to the new thread when the answer lands after navigating", async () => {
        await pickThenNavigate(({ resolve }) => resolve({ agent: { kind: "model", model: B }, coldStartCostly: false, messageId: "m", switched: true }));

        expect(useModelStore.getState()).toMatchObject({ selectedModel: "openai/gpt-5-nano", selectedModelThreadId: "t2" });
    });

    it("does not roll the store back to the old thread when the failure lands after navigating", async () => {
        await pickThenNavigate(({ reject }) => reject(new Error("boom")));

        expect(useModelStore.getState()).toMatchObject({ selectedModel: "openai/gpt-5-nano", selectedModelThreadId: "t2" });
        expect(hoisted.showError).not.toHaveBeenCalled();
    });
});

describe("useModelCombobox: the confirmation step", () => {
    beforeEach(() => {
        hoisted.thread.current = { _id: "t1", mode: "text", model: A };
        hoisted.switchAgent.mockReset();
        hoisted.trackEvent.mockReset();
        hoisted.preview.mockReset();
        useModelStore.getState().loadThreadData({ mode: "text", model: A }, "t1");
    });

    it("counts no switch while the confirmation is open or after it is cancelled", async () => {
        hoisted.preview.mockResolvedValue({ coldStartCostly: true });

        const { result } = renderHook(() => useModelCombobox({ threadId: "t1" }));

        await act(async () => {
            await result.current.changeModel(B);
        });

        expect(result.current.pendingSwitch).toMatchObject({ model: B });

        act(() => {
            result.current.cancelSwitch();
        });

        expect(hoisted.trackEvent).not.toHaveBeenCalled();
        expect(hoisted.switchAgent).not.toHaveBeenCalled();
    });

    it("counts the switch once the thread took it", async () => {
        hoisted.switchAgent.mockResolvedValue({ agent: { kind: "model", model: B }, coldStartCostly: false, messageId: "m", switched: true });
        hoisted.preview.mockResolvedValue({ coldStartCostly: false });

        const { result } = renderHook(() => useModelCombobox({ threadId: "t1" }));

        await act(async () => {
            await result.current.changeModel(B);
        });

        expect(hoisted.trackEvent).toHaveBeenCalledExactlyOnceWith("model_switched", { from_model: A, to_model: B });
    });

    it("keeps the whole history, with no summary, when the estimate fails", async () => {
        hoisted.preview.mockRejectedValue(new Error("offline"));
        hoisted.switchAgent.mockResolvedValue({ agent: { kind: "model", model: B }, coldStartCostly: false, messageId: "m", switched: true });

        const { result } = renderHook(() => useModelCombobox({ threadId: "t1" }));

        await act(async () => {
            await result.current.changeModel(B);
        });

        expect(hoisted.switchAgent).toHaveBeenCalledWith(expect.objectContaining({ mode: "full" }));
    });

    it("drops a preview that lands after the user picked another model", async () => {
        let controls = { resolve: (_value: unknown) => {} };

        hoisted.preview.mockReturnValue(
            new Promise((resolve) => {
                controls = { resolve };
            }),
        );

        const { result } = renderHook(() => useModelCombobox({ threadId: "t1" }));
        let pick: Promise<void> = Promise.resolve();

        act(() => {
            pick = result.current.changeModel(B);
        });

        // A second pick replaces the first before its estimate lands.
        act(() => {
            useModelStore.getState().setSelectedModel("openai/gpt-4.1-nano", "t1");
        });

        await act(async () => {
            controls.resolve({ coldStartCostly: true });
            await pick;
        });

        expect(result.current.pendingSwitch).toBeNull();
        expect(hoisted.switchAgent).not.toHaveBeenCalled();
    });

    it("drops an open confirmation when another thread is shown, so confirming it switches nothing there", async () => {
        hoisted.preview.mockResolvedValue({ coldStartCostly: true, contextTokens: 1000, defaultMode: "full", handoffTokens: 100 });
        hoisted.switchAgent.mockResolvedValue({ agent: { kind: "model", model: B }, coldStartCostly: false, messageId: "m", switched: true });

        const { rerender, result } = renderHook(({ id }) => useModelCombobox({ threadId: id }), { initialProps: { id: "t1" } });

        await act(async () => {
            await result.current.changeModel(B);
        });

        expect(result.current.pendingSwitch).toMatchObject({ model: B });

        hoisted.thread.current = { _id: "t2", mode: "text", model: A };
        rerender({ id: "t2" });

        expect(result.current.pendingSwitch).toBeNull();

        await act(async () => {
            await result.current.confirmSwitch("full");
        });

        expect(hoisted.switchAgent).not.toHaveBeenCalled();
    });

    it("drops a preview that lands after the user opened another thread on the same model", async () => {
        let controls = { resolve: (_value: unknown) => {} };

        hoisted.preview.mockReturnValue(
            new Promise((resolve) => {
                controls = { resolve };
            }),
        );

        const { result } = renderHook(() => useModelCombobox({ threadId: "t1" }));
        let pick: Promise<void> = Promise.resolve();

        act(() => {
            pick = result.current.changeModel(B);
        });

        act(() => {
            useModelStore.getState().setSelectedModel(B, "t2");
        });

        await act(async () => {
            controls.resolve({ coldStartCostly: false });
            await pick;
        });

        expect(hoisted.switchAgent).not.toHaveBeenCalled();
    });

    it("does not run the fallback switch when the estimate fails after the user picked again", async () => {
        let controls = { reject: (_reason: unknown) => {} };

        hoisted.preview.mockReturnValue(
            new Promise((_resolve, reject) => {
                controls = { reject };
            }),
        );

        const { result } = renderHook(() => useModelCombobox({ threadId: "t1" }));
        let pick: Promise<void> = Promise.resolve();

        act(() => {
            pick = result.current.changeModel(B);
        });

        act(() => {
            useModelStore.getState().setSelectedModel("openai/gpt-4.1-nano", "t1");
        });

        await act(async () => {
            controls.reject(new Error("offline"));
            await pick;
        });

        expect(hoisted.switchAgent).not.toHaveBeenCalled();
    });
});
