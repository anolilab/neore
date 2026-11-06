/**
 * A prompt link's model is selected only if the composer's own list offers it. The list is built for real here: the catalog, the
 * user's filter rules (their blocked models), and the link hook that applies the model all run, so a blocked model in a link is
 * refused by the same list the picker shows.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptLinkDraft } from "@/features/chat/core/hooks/use-prompt-link-draft";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { ModelId } from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { buildPromptLink, readPromptLinkSearch } from "@/features/chat/core/utils/prompt-link";

import { LINK_WAIT_MS, useComposerModelEntries, useLinkWaitOver } from "./use-composer-models";

const harness = vi.hoisted(() => {
    return {
        catalog: [] as unknown[],
        client: undefined as undefined | QueryClient,
        gate: undefined as undefined | Promise<void>,
        userId: "account-a" as string | null,
        flagCallback: undefined as undefined | ((flags?: unknown, variants?: unknown, context?: { errorsLoading?: boolean }) => void),
        flagEnabled: false,
        navigate: vi.fn(),
        posthog: undefined as undefined | Record<string, unknown>,
        prefs: {} as Record<string, unknown>,
        prefsFail: false,
        showWarning: vi.fn(),
    };
});

vi.mock("@/lib/env", () => {
    return {
        default: { VITE_POSTHOG_API_KEY: "phc_test" },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: harness.userId ? { user: { id: harness.userId } } : undefined };
                    },
                },
            };
        },
    };
});

vi.mock("@/hooks/use-gateway-models", () => {
    return {
        useGatewayModels: () => harness.catalog,
        useGatewayModelsSettled: () => true,
    };
});

vi.mock("posthog-js/react", () => {
    return {
        usePostHog: () => harness.posthog,
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getAIUserPreferences: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        // A gate holds the read, as a slow network does: the cache keeps the previous account's read meanwhile.
                                        if (harness.gate) {
                                            await harness.gate;
                                        }

                                        if (harness.prefsFail) {
                                            throw new Error("unavailable");
                                        }

                                        return harness.prefs;
                                    },
                                    queryKey: ["ai-user-preferences"],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

// The creator blocks are a separate per-user list; none are set here, so only the model blocks decide.
vi.mock("@/hooks/use-model-filter-rules", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/hooks/use-model-filter-rules")>();

    return {
        ...actual,
        useBlockedCreators: () => {
            return { blockedCreators: [], isLoaded: true };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => harness.navigate,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return {
        showWarning: (message: unknown) => harness.showWarning(message),
    };
});

const textModels = MODEL_REGISTRY.filter((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");
const blockedModel = textModels.find((model) => model.id !== DEFAULT_CHAT_MODEL);

const MODEL_NOTICE = "This link's model is not available in this chat. The chat keeps its model.";

// One client per test: the rules are one cached read, and the account switch is the thing under test.
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={harness.client ?? new QueryClient()}>{children}</QueryClientProvider>;

/** The composer's entries and the link hook, as the route wires them: the link waits until the list is final. */
const useLinkWithComposerList = (model: string | undefined) => {
    const entries = useComposerModelEntries();
    const linkWaitOver = useLinkWaitOver();

    usePromptLinkDraft({ linkableModels: entries ?? new Map(), model, prompt: "hi", ready: entries !== undefined || linkWaitOver });

    return { ids: entries ? [...entries.keys()] : [], settled: entries !== undefined };
};

const selectedModel = (): string => useModelStore.getState().selectedModel;

describe("a prompt link and the user's blocked models", () => {
    beforeEach(() => {
        harness.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        harness.userId = "account-a";
        harness.navigate.mockReset();
        harness.showWarning.mockReset();
        harness.catalog = textModels;
        harness.prefs = { modelFilterRules: { blockedModels: blockedModel ? [blockedModel.id] : [] } };
        harness.prefsFail = false;
        harness.gate = undefined;
        harness.flagEnabled = false;
        harness.flagCallback = undefined;
        harness.posthog = undefined;
        useChatUIStore.getState().setComposerText("");
        useChatUIStore.setState({ attachedReferences: [], composerAttachments: [] });
        useModelStore.setState({ comparisonMode: false, newThreadMode: "text", pendingSettings: undefined, selectedModel: DEFAULT_CHAT_MODEL as ModelId });
    });

    it("leaves a blocked model out of the composer's list, and a link naming it keeps the chat's model and says so", async () => {
        expect(blockedModel).toBeDefined();

        const { result } = renderHook(() => useLinkWithComposerList(blockedModel?.id), { wrapper });

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE));

        expect(result.current.ids).not.toContain(blockedModel?.id);
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("a link that arrives before the rules have loaded waits, so a blocked model cannot be selected in that window", async () => {
        expect(blockedModel).toBeDefined();

        const { result } = renderHook(() => useLinkWithComposerList(blockedModel?.id), { wrapper });

        // Synchronously the rules have not answered: nothing is applied yet, and the list is not final.
        expect(result.current.settled).toBe(false);
        expect(useChatUIStore.getState().composerText).toBe("");
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE));
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
    });

    it("when the user's rules cannot be read, the list is empty: a link names no model, and its prompt still applies", async () => {
        harness.prefsFail = true;

        const { result } = renderHook(() => useLinkWithComposerList(textModels[1]?.id), { wrapper });

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE));

        expect(result.current.ids).toEqual([]);
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("a link naming a model the user has not blocked selects it, from the same list", async () => {
        const allowed = textModels.find((model) => model.id !== blockedModel?.id && model.id !== DEFAULT_CHAT_MODEL);

        expect(allowed).toBeDefined();

        const { result } = renderHook(() => useLinkWithComposerList(allowed?.id), { wrapper });

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(selectedModel()).toBe(allowed?.id));
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("a model the picker offers round-trips: the copied link names it, and opening the link selects it", async () => {
        // Not the blocked model: a model the user has not blocked, other than the chat's own.
        const offered = textModels.find((model) => model.id !== DEFAULT_CHAT_MODEL && model.id !== blockedModel?.id);

        expect(offered).toBeDefined();

        // The copy writes this link, and the route reads it back with the same parser (the query the browser carries).
        const link = buildPromptLink("https://app.example.com", { model: offered?.id, prompt: "hi" });
        const search = readPromptLinkSearch(Object.fromEntries(new URL(link).searchParams));

        const { result } = renderHook(() => useLinkWithComposerList(search.model), { wrapper });

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(selectedModel()).toBe(offered?.id));
        expect(result.current.ids).toContain(offered?.id);
    });

    describe("a model behind a feature flag", () => {
        const flagged = { ...textModels[0], featureFlag: "beta-models", id: "flagged-text-model" };

        /** Lets the reads answer: they resolve on the microtask queue, and react-query's notifications on a zero-delay timer. */
        const settle = async (): Promise<void> => {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
            });
        };

        beforeEach(() => {
            vi.useFakeTimers();
            harness.catalog = [...textModels, flagged];
            harness.posthog = {
                flagsEndpointWasHit: false,
                isFeatureEnabled: () => harness.flagEnabled,
                onFeatureFlags: (callback: () => void) => {
                    harness.flagCallback = callback;

                    return () => undefined;
                },
            };
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("waits until the flags are known, then selects the usable model a link names", async () => {
            const { result } = renderHook(() => useLinkWithComposerList(flagged.id), { wrapper });

            // The catalog and the rules have answered; the flags have not, so the list is not final and the link waits.
            await settle();
            expect(result.current.settled).toBe(false);
            expect(harness.showWarning).not.toHaveBeenCalled();

            act(() => {
                harness.flagEnabled = true;
                harness.posthog = { ...harness.posthog, flagsEndpointWasHit: true };
                harness.flagCallback?.();
            });

            await settle();
            expect(result.current.settled).toBe(true);
            expect(selectedModel()).toBe(flagged.id);
            expect(harness.showWarning).not.toHaveBeenCalled();
        });

        it("a wait that never resolves: the link applies its prompt within the bound, and says the model is unavailable", async () => {
            // The account's rules never load: nothing decides the model, so the link waits, and is not applied before the bound.
            harness.gate = new Promise<void>(() => {
                // Never resolves: the account's rules never load.
            });

            const { result } = renderHook(() => useLinkWithComposerList(flagged.id), { wrapper });

            await settle();
            expect(result.current.settled).toBe(false);
            expect(useChatUIStore.getState().composerText).toBe("");

            await act(async () => {
                await vi.advanceTimersByTimeAsync(LINK_WAIT_MS);
            });

            // Past the bound the link has applied: the prompt is drafted, the model is refused with its notice, and the chat keeps its model.
            expect(useChatUIStore.getState().composerText).toBe("hi");
            expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        }, 15_000);

        it("a flag request that fails decides the link at once, without the wait", async () => {
            const { result } = renderHook(() => useLinkWithComposerList(flagged.id), { wrapper });

            await settle();
            expect(result.current.settled).toBe(false);

            act(() => {
                harness.flagCallback?.(undefined, undefined, { errorsLoading: true });
            });

            await settle();
            expect(result.current.settled).toBe(true);
            expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        });

        it("when the flags never arrive, the link decides after the wait without the flagged model, and its prompt still applies", async () => {
            const { result } = renderHook(() => useLinkWithComposerList(flagged.id), { wrapper });

            await settle();
            expect(result.current.settled).toBe(false);

            // The clock, not the wall clock, moves past the wait.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(LINK_WAIT_MS);
            });

            // The flags never came, so the list stayed unfinished; the link applied at the bound, with the flagged model refused.
            expect(result.current.settled).toBe(false);
            expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
            expect(useChatUIStore.getState().composerText).toBe("hi");
        });
    });

    it("an account switch that blocks a model the previous account could use does not select it until the new account's rules load", async () => {
        expect(blockedModel).toBeDefined();

        // The previous account can use the model: its link selects it.
        harness.prefs = { modelFilterRules: { blockedModels: [] } };
        const { result: firstResult, unmount: unmountFirst } = renderHook(() => useLinkWithComposerList(blockedModel?.id), { wrapper });

        await waitFor(() => expect(firstResult.current.settled).toBe(true));
        await waitFor(() => expect(selectedModel()).toBe(blockedModel?.id));
        unmountFirst();

        // The account switches, and the new account has blocked that model. The new account's read is held: until it lands, the cache holds
        // the previous account's read, and a visit to a link for the model must not use it.
        useModelStore.setState({ selectedModel: DEFAULT_CHAT_MODEL as ModelId });
        harness.userId = "account-b";
        harness.prefs = { modelFilterRules: { blockedModels: [blockedModel?.id] } };
        let resolveGate: () => void = () => undefined;

        harness.gate = new Promise<void>((resolve) => {
            resolveGate = () => {
                resolve();
            };
        });

        // The first visit's draft is cleared, as a person who sends or discards it would have: the second visit starts with no draft.
        useChatUIStore.getState().setComposerText("");

        const { result: secondResult } = renderHook(() => useLinkWithComposerList(blockedModel?.id), { wrapper });

        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 20);
            });
        });
        expect(secondResult.current.settled).toBe(false);
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);

        // The new account's read lands: the model is refused, with its notice.
        harness.gate = undefined;
        resolveGate();
        await waitFor(() => expect(secondResult.current.settled).toBe(true));
        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE));
        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
    });

    it("the list keeps its identity across re-renders while its entries do not change", async () => {
        const { result, rerender } = renderHook(() => useComposerModelEntries(), { wrapper });

        await waitFor(() => expect(result.current).toBeDefined());

        const first = result.current;

        for (let renders = 0; renders < 5; renders += 1) {
            rerender();
        }

        // Before the list was keyed by its entries, every render gave a new map, and every thread consumer re-rendered with it.
        expect(result.current).toBe(first);
    });
});
