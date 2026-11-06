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

import { useComposerModelEntries } from "./use-composer-models";

const harness = vi.hoisted(() => {
    return {
        catalog: [] as unknown[],
        flagCallback: undefined as undefined | (() => void),
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
                                    queryFn: () => (harness.prefsFail ? Promise.reject(new Error("unavailable")) : Promise.resolve(harness.prefs)),
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

const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

/** The composer's entries and the link hook, as the route wires them: the link waits until the list is final. */
const useLinkWithComposerList = (model: string | undefined) => {
    const entries = useComposerModelEntries();

    usePromptLinkDraft({ linkableModels: entries ?? new Map(), model, prompt: "hi", ready: entries !== undefined });

    return { ids: entries ? [...entries.keys()] : [], settled: entries !== undefined };
};

const selectedModel = (): string => useModelStore.getState().selectedModel;

describe("a prompt link and the user's blocked models", () => {
    beforeEach(() => {
        harness.navigate.mockReset();
        harness.showWarning.mockReset();
        harness.catalog = textModels;
        harness.prefs = { modelFilterRules: { blockedModels: blockedModel ? [blockedModel.id] : [] } };
        harness.prefsFail = false;
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

        beforeEach(() => {
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

        it("waits until the flags are known, then selects the usable model a link names: nothing is refused before the flags load", async () => {
            const { result } = renderHook(() => useLinkWithComposerList(flagged.id), { wrapper });

            // Let the catalog and the user's rules answer; the flags have not, so the list is still not final and the link waits.
            await act(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 50);
                });
            });
            expect(result.current.settled).toBe(false);
            expect(harness.showWarning).not.toHaveBeenCalled();

            act(() => {
                harness.flagEnabled = true;
                harness.posthog = { ...harness.posthog, flagsEndpointWasHit: true };
                harness.flagCallback?.();
            });

            await waitFor(() => expect(result.current.settled).toBe(true));
            await waitFor(() => expect(selectedModel()).toBe(flagged.id));
            expect(harness.showWarning).not.toHaveBeenCalled();
        }, 15_000);

        it("when the flags never arrive, the link decides after the wait without the flagged model, and its prompt still applies", async () => {
            const { result } = renderHook(() => useLinkWithComposerList(flagged.id), { wrapper });

            await waitFor(() => expect(result.current.settled).toBe(true), { timeout: 8000 });
            await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE), { timeout: 8000 });

            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
            expect(useChatUIStore.getState().composerText).toBe("hi");
        }, 15_000);
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
