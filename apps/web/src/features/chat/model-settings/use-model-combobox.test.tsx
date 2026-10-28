import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useModelStore } from "@/features/chat/core/stores/model-store";

import useModelCombobox from "./use-model-combobox";

const hoisted = vi.hoisted(() => {
    return { showError: vi.fn(), switchAgent: vi.fn(), thread: { current: undefined as unknown } };
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
                fetchQuery: async () => {
                    return { coldStartCostly: false };
                },
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
    return { trackEvent: vi.fn() };
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
