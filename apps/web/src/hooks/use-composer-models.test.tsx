/**
 * A prompt link's model is selected only if the composer's own list offers it. The list is built for real here: the catalog, the
 * user's filter rules (their blocked models), and the link hook that applies the model all run, so a blocked model in a link is
 * refused by the same list the picker shows.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptLinkDraft } from "@/features/chat/core/hooks/use-prompt-link-draft";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { ModelId } from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";

import { useComposerModels, useComposerModelsSettled } from "./use-composer-models";

const harness = vi.hoisted(() => {
    return {
        catalog: [] as unknown[],
        navigate: vi.fn(),
        prefs: {} as Record<string, unknown>,
        prefsFail: false,
        showWarning: vi.fn(),
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
        usePostHog: () => undefined,
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

/** The composer's list and the link hook, as the route wires them: the link waits until the list is final. */
const useLinkWithComposerList = (model: string | undefined) => {
    const models = useComposerModels();
    const settled = useComposerModelsSettled();
    const allowedModelIds = useMemo(() => new Set(models.map((entry) => entry.id)), [models]);

    usePromptLinkDraft({ allowedModelIds, model, prompt: "hi", ready: settled });

    return { models, settled };
};

describe("a prompt link and the user's blocked models", () => {
    beforeEach(() => {
        harness.navigate.mockReset();
        harness.showWarning.mockReset();
        harness.catalog = textModels;
        harness.prefs = { modelFilterRules: { blockedModels: blockedModel ? [blockedModel.id] : [] } };
        harness.prefsFail = false;
        useChatUIStore.getState().setComposerText("");
        useChatUIStore.setState({ attachedReferences: [], composerAttachments: [] });
        useModelStore.setState({ comparisonMode: false, newThreadMode: "text", pendingSettings: undefined, selectedModel: DEFAULT_CHAT_MODEL as ModelId });
    });

    it("leaves a blocked model out of the composer's list, and a link naming it keeps the chat's model and says so", async () => {
        expect(blockedModel).toBeDefined();

        const { result } = renderHook(() => useLinkWithComposerList(blockedModel?.id), { wrapper });

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE));

        expect(result.current.models.map((model) => model.id)).not.toContain(blockedModel?.id);
        expect(useModelStore.getState().selectedModel).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("a link that arrives before the rules have loaded waits, so a blocked model cannot be selected in that window", async () => {
        expect(blockedModel).toBeDefined();

        const { result } = renderHook(() => useLinkWithComposerList(blockedModel?.id), { wrapper });

        // Synchronously the rules have not answered: nothing is applied yet, and the list is not final.
        expect(result.current.settled).toBe(false);
        expect(useChatUIStore.getState().composerText).toBe("");
        expect(useModelStore.getState().selectedModel).toBe(DEFAULT_CHAT_MODEL);

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE));
        expect(useModelStore.getState().selectedModel).toBe(DEFAULT_CHAT_MODEL);
    });

    it("when the user's rules cannot be read, the list is empty: a link names no model, and its prompt still applies", async () => {
        harness.prefsFail = true;

        const { result } = renderHook(() => useLinkWithComposerList(textModels[1]?.id), { wrapper });

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE));

        expect(result.current.models).toEqual([]);
        expect(useModelStore.getState().selectedModel).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("a link naming a model the user has not blocked selects it, from the same list", async () => {
        const allowed = textModels.find((model) => model.id !== blockedModel?.id && model.id !== DEFAULT_CHAT_MODEL);

        expect(allowed).toBeDefined();

        const { result } = renderHook(() => useLinkWithComposerList(allowed?.id), { wrapper });

        await waitFor(() => expect(result.current.settled).toBe(true));
        await waitFor(() => expect(useModelStore.getState().selectedModel).toBe(allowed?.id));
        expect(harness.showWarning).not.toHaveBeenCalled();
    });
});
