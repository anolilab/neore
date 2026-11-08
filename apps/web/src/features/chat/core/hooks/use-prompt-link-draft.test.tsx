import { MODEL_REGISTRY } from "@neore/ai/models";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "../stores/chat-ui-store";
import { useModelStore } from "../stores/model-store";
import { usePromptLinkDraft } from "./use-prompt-link-draft";

const navigate = vi.fn();
const showWarning = vi.fn();

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => navigate };
});

vi.mock("@/lib/toast", () => {
    return { showWarning: (message: string) => showWarning(message) };
});

/** The models the picker offers this person; empty is the picker's list still loading. */
const picker = vi.hoisted(() => {
    return { ids: [] as string[] };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return {
        default: () =>
            picker.ids.map((id) => {
                return { id };
            }),
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
    picker.ids = [];
    navigate.mockClear();
    showWarning.mockClear();
    useChatUIStore.getState().clearComposer();
    useModelStore.getState().setSelectedModel(startModel, undefined);
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
