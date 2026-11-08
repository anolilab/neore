import { MODEL_REGISTRY } from "@neore/ai/models";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCreatorSlug } from "@/components/model-picker/utilities";

import { useChatUIStore } from "../stores/chat-ui-store";
import { useModelStore } from "../stores/model-store";
import { useLinkSearchAsWritten, usePromptLinkDraft } from "./use-prompt-link-draft";

const navigate = vi.fn();
const showWarning = vi.fn();

vi.mock("@lingui/react/macro", () => {
    // One `t`, as Lingui keeps it across renders: a new one each render would re-run the hook's effects by itself.
    const t = (strings: TemplateStringsArray) => strings.join("");

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => navigate };
});

vi.mock("@/lib/toast", () => {
    return { showWarning: (message: string) => showWarning(message) };
});

/** The models the picker offers this person, and whether that list has settled. */
const picker = vi.hoisted(() => {
    return { blockedCreators: [] as string[], ids: [] as string[], preferencesFailed: false, settled: true };
});

vi.mock("@/hooks/use-model-filter-rules", () => {
    return {
        useModelFilterRules: () => {
            return { blockedCreators: picker.blockedCreators };
        },
    };
});

const lists = vi.hoisted(() => new WeakMap<string[], { id: string }[]>());

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return {
        // One array per id list, as a memoized list is: a new array on each render would re-run the hook's effects by itself.
        default: () => {
            const known =
                lists.get(picker.ids) ??
                picker.ids.map((id) => {
                    return { id };
                });

            lists.set(picker.ids, known);

            return known;
        },
        useFeatureFlaggedModelsSettled: () => picker.settled,
        useModelPreferencesFailed: () => picker.preferencesFailed,
    };
});

const textModel = MODEL_REGISTRY.find((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");
const externalModel = MODEL_REGISTRY.find((model) => model.provider === "external");
const startModel = useModelStore.getState().selectedModel;

/** The search the hook writes back to the address. */
const strippedSearch = (): unknown => {
    const call = navigate.mock.calls.at(-1)?.[0] as { search: (previous: Record<string, unknown>) => unknown };

    return call.search({ model: "m", prompt: "p", promptId: "kept" });
};

beforeEach(() => {
    picker.ids = textModel ? [textModel.id] : [];
    picker.settled = true;
    picker.blockedCreators = [];
    picker.preferencesFailed = false;
    navigate.mockClear();
    showWarning.mockClear();
    useChatUIStore.getState().clearComposer();
    useModelStore.getState().setSelectedModel(startModel, undefined);
    useModelStore.getState().setComparisonMode(false);
});

describe(usePromptLinkDraft, () => {
    it("puts the prompt in the composer, selects the model, and removes the link from the address", () => {
        renderHook(() => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
        // Replaced, not pushed: Back must not return to the link and apply it again.
        expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ hash: true, replace: true }));
        expect(useModelStore.getState().selectedModel).toBe(textModel?.id);
        expect(showWarning).not.toHaveBeenCalled();
        expect(strippedSearch()).toStrictEqual({ model: undefined, prompt: undefined, promptId: "kept" });
    });

    it("only clears a link with nothing usable in it from the address, with no notice about a draft it never had", () => {
        useChatUIStore.getState().setComposerText("Mine");
        renderHook(() => usePromptLinkDraft({ model: undefined, otherDraftSource: false, prompt: "" }));

        expect(useChatUIStore.getState().composerText).toBe("Mine");
        expect(showWarning).not.toHaveBeenCalled();
        expect(strippedSearch()).toStrictEqual({ model: undefined, prompt: undefined, promptId: "kept" });
    });

    it("applies the same link again once it has left the address and is opened anew", () => {
        const { rerender } = renderHook((prompt: string | undefined) => usePromptLinkDraft({ model: undefined, otherDraftSource: false, prompt }), {
            initialProps: "Draft me",
        });

        useChatUIStore.getState().clearComposer();
        rerender(undefined);
        rerender("Draft me");

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
        expect(navigate).toHaveBeenCalledTimes(2);
    });

    it("waits in the address while a saved prompt is still loading, then applies once it settles with no draft", () => {
        const { rerender } = renderHook((ready: boolean) => usePromptLinkDraft({ model: undefined, otherDraftSource: false, prompt: "Draft me", ready }), {
            initialProps: false,
        });

        expect(navigate).not.toHaveBeenCalled();
        expect(useChatUIStore.getState().composerText).toBe("");

        rerender(true);

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
    });

    it("keeps a draft already in the composer, and the chat's model, with a notice", () => {
        useChatUIStore.getState().setComposerText("Mine");

        renderHook(() => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        expect(useChatUIStore.getState().composerText).toBe("Mine");
        expect(useModelStore.getState().selectedModel).toBe(startModel);
        expect(showWarning).toHaveBeenCalledOnce();
        expect(navigate).toHaveBeenCalledOnce();
    });

    it("applies the prompt at once and takes the model only once the picker's list settles, if that list offers it", () => {
        picker.ids = [];
        picker.settled = false;
        const { rerender } = renderHook(() => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
        expect(useModelStore.getState().selectedModel).toBe(startModel);
        expect(showWarning).not.toHaveBeenCalled();

        // The list settles without the model (switched off, or the catalog failed): the chat keeps its model.
        picker.settled = true;
        rerender();

        expect(useModelStore.getState().selectedModel).toBe(startModel);
        expect(showWarning).toHaveBeenCalledOnce();
    });

    it("drops a link's model still waiting for the picker's list once the person picks a model themselves", () => {
        const other = MODEL_REGISTRY.find((entry) => (entry.mode ?? "text") === "text" && entry.enabled !== false && entry.id !== textModel?.id);

        picker.settled = false;
        const { rerender } = renderHook(() => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        useModelStore.getState().setSelectedModel(other!.id as never, undefined);
        picker.settled = true;
        rerender();

        expect(useModelStore.getState().selectedModel).toBe(other?.id);
        expect(showWarning).not.toHaveBeenCalled();
    });

    it("keeps a comparison or mode the person picks while the link's model waits for the picker's list", () => {
        picker.settled = false;
        const { rerender } = renderHook(() => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        useModelStore.getState().setSelectedModelsForComparison(["a", "b"]);
        useModelStore.getState().setComparisonMode(true);
        picker.settled = true;
        rerender();

        expect(useModelStore.getState().comparisonMode).toBe(true);
        expect(useModelStore.getState().selectedModelsForComparison).toStrictEqual(["a", "b"]);
        expect(useModelStore.getState().selectedModel).toBe(startModel);
    });

    it("applies the prompt but not a model from a lab the person hid from the picker", () => {
        // The picker list holds ids only here, so the lab is read from the id as the picker reads it.
        picker.blockedCreators = [getCreatorSlug({ id: textModel!.id } as never)];
        renderHook(() => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
        expect(useModelStore.getState().selectedModel).toBe(startModel);
        expect(showWarning).toHaveBeenCalledOnce();
    });

    it("applies the prompt but not the link's model when the person's preferences could not be read", () => {
        picker.preferencesFailed = true;
        renderHook(() => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
        expect(useModelStore.getState().selectedModel).toBe(startModel);
        expect(showWarning).toHaveBeenCalledOnce();
    });

    it("selects the link's model once a saved prompt in the same address settles, with the picker's list unchanged", () => {
        const { rerender } = renderHook(
            ({ ready }: { ready: boolean }) => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me", ready }),
            {
                initialProps: { ready: false },
            },
        );

        rerender({ ready: true });

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
        expect(useModelStore.getState().selectedModel).toBe(textModel?.id);
    });

    it("applies the prompt but not an external model", () => {
        renderHook(() => usePromptLinkDraft({ model: externalModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
        expect(useModelStore.getState().selectedModel).toBe(startModel);
        expect(showWarning).toHaveBeenCalledOnce();
    });

    it("applies the prompt but not a model the picker does not offer this person", () => {
        picker.ids = ["some-other-model"];
        renderHook(() => usePromptLinkDraft({ model: textModel?.id, otherDraftSource: false, prompt: "Draft me" }));

        expect(useChatUIStore.getState().composerText).toBe("Draft me");
        expect(useModelStore.getState().selectedModel).toBe(startModel);
        expect(showWarning).toHaveBeenCalledOnce();
    });
});

describe(useLinkSearchAsWritten, () => {
    it("reads the link again only when the router's parsed values change", () => {
        const read = vi.fn(() => "1.50");
        const { rerender } = renderHook(({ parsed }: { parsed: string }) => useLinkSearchAsWritten(parsed, read), { initialProps: { parsed: "1.5" } });

        rerender({ parsed: "1.5" });
        rerender({ parsed: "1.5" });

        expect(read).toHaveBeenCalledOnce();

        rerender({ parsed: "2" });

        expect(read).toHaveBeenCalledTimes(2);
    });

    it("keeps the link as written while a navigation writes it back from the router's parsed values", () => {
        const { rerender, result } = renderHook(({ parsed, written }: { parsed: string; written: string }) => useLinkSearchAsWritten(parsed, () => written), {
            initialProps: { parsed: "1.5", written: "1.50" },
        });

        // Opening Settings keeps the search: the router writes `1.5`, which it parses as before.
        rerender({ parsed: "1.5", written: "1.5" });

        expect(result.current).toBe("1.50");

        rerender({ parsed: "2", written: "2" });

        expect(result.current).toBe("2");
    });
});
