/**
 * A prompt link applies once, as an unsent draft, and its own parameters leave the address. A draft or a saved prompt
 * already in place keeps its text and model.
 */
import { ANONYMOUS_FREE_MODEL, DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";
import { PROMPT_LINK_MAX_CHARS } from "../utils/prompt-link";
import type { LinkableModel } from "../utils/prompt-link-model";
import { usePromptLinkDraft } from "./use-prompt-link-draft";

const harness = vi.hoisted(() => {
    return {
        navigate: vi.fn(),
        showWarning: vi.fn(),
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
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return {
        showWarning: (message: unknown) => harness.showWarning(message),
    };
});

const textModel = MODEL_REGISTRY.find((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");
const otherTextModel = MODEL_REGISTRY.filter((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external")[1];
const imageModel = MODEL_REGISTRY.find((model) => model.mode === "image" && model.enabled !== false);
const disabledModel = "fal-ai/flux-schnell";
const externalModel = "ext/mimo-v2-flash";
const MODEL_NOTICE = "This link's model is not available in this chat. The chat keeps its model.";

/** Every text model the composer's picker offers, by default: the link may select any of them, as a user with no gate would. */
const OFFERED_TEXT_MODELS: ReadonlyMap<string, LinkableModel> = new Map(
    MODEL_REGISTRY.filter((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external").map((model) => [
        model.id,
        { id: model.id, mode: model.mode, provider: model.provider },
    ]),
);

/** A text model other than the default: a model a link can name, which the picker does not offer in the test that gates it. */
const gatedTextModel = MODEL_REGISTRY.find(
    (model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external" && model.id !== DEFAULT_CHAT_MODEL,
);

interface LinkProps {
    isAnonymous?: boolean;
    linkableModels?: ReadonlyMap<string, LinkableModel>;
    model?: string;
    otherDraftSource?: boolean;
    prompt?: string;
    ready?: boolean;
}

const renderLink = (initial: LinkProps) =>
    renderHook((props: LinkProps) => usePromptLinkDraft({ linkableModels: OFFERED_TEXT_MODELS, ...props }), { initialProps: initial });

const selectedModel = (): string => useModelStore.getState().selectedModel;

describe("usePromptLinkDraft", () => {
    beforeEach(() => {
        harness.navigate.mockReset();
        harness.showWarning.mockReset();
        useChatUIStore.getState().setComposerText("");
        useChatUIStore.setState({ attachedReferences: [], composerAttachments: [] });
        useModelStore.setState({
            comparisonMode: false,
            newThreadMode: "text",
            pendingSettings: undefined,
            selectedModel: DEFAULT_CHAT_MODEL as ModelId,
            selectedModelsForComparison: [],
        });
    });

    afterEach(() => {
        useChatUIStore.getState().setComposerText("");
        useChatUIStore.setState({ attachedReferences: [], composerAttachments: [] });
    });

    it("puts the link's prompt in an empty composer, once, and never sends it", () => {
        const { rerender } = renderLink({ prompt: "Summarise this" });

        expect(useChatUIStore.getState().composerText).toBe("Summarise this");
        expect(harness.navigate).toHaveBeenCalledTimes(1);

        // The person edits the draft; a re-render while the link is still in the address does not apply it again.
        useChatUIStore.getState().setComposerText("edited by the person");
        rerender({ prompt: "Summarise this" });

        expect(useChatUIStore.getState().composerText).toBe("edited by the person");
        expect(harness.navigate).toHaveBeenCalledTimes(1);
    });

    it("applies a link's model when it names an enabled text model", () => {
        expect(textModel).toBeDefined();

        renderLink({ model: textModel?.id, prompt: "hi" });

        expect(selectedModel()).toBe(textModel?.id);
    });

    it("keeps an existing draft with a notice, and keeps the model the person chose", () => {
        useChatUIStore.getState().setComposerText("my own text");

        renderLink({ model: textModel?.id, prompt: "from the link" });

        expect(useChatUIStore.getState().composerText).toBe("my own text");
        expect(harness.showWarning).toHaveBeenCalledWith("Your draft is kept. The prompt from the link was not added.");
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(harness.navigate).toHaveBeenCalledTimes(1);
    });

    it("treats attachments as part of an existing draft", () => {
        useChatUIStore.setState({ composerAttachments: [{ id: "file-1", status: "complete" }] as never });

        renderLink({ prompt: "from the link" });

        expect(useChatUIStore.getState().composerText).toBe("");
        expect(harness.showWarning).toHaveBeenCalledWith("Your draft is kept. The prompt from the link was not added.");
    });

    it("yields to a saved prompt or a message named in the same URL, and keeps the model", () => {
        renderLink({ model: textModel?.id, otherDraftSource: true, prompt: "from the link" });

        expect(useChatUIStore.getState().composerText).toBe("");
        expect(harness.showWarning).toHaveBeenCalledWith("This chat already has a prompt. The prompt from the link was not added.");
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(harness.navigate).toHaveBeenCalledTimes(1);
    });

    it("a second link naming an available model, after a first link refused one, applies on its own terms", () => {
        let available: LinkableModel | undefined;

        for (const entry of OFFERED_TEXT_MODELS.values()) {
            if (entry.id !== DEFAULT_CHAT_MODEL) {
                available = entry;
                break;
            }
        }

        expect(available).toBeDefined();

        // The first link names a model the picker does not offer: it is refused, with its notice, and the draft is the first link's.
        const { rerender } = renderLink({ model: "not-a-real-model", prompt: "first" });

        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);

        // The person clears the draft; the second link, with no link in the address in between, names an available model.
        useChatUIStore.getState().setComposerText("");
        harness.showWarning.mockReset();
        rerender({ model: available?.id, prompt: "second" });

        expect(useChatUIStore.getState().composerText).toBe("second");
        expect(selectedModel()).toBe(available?.id);
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("applies a second link on the mounted page once the first link's parameters are gone", () => {
        const { rerender } = renderLink({ prompt: "first" });

        expect(useChatUIStore.getState().composerText).toBe("first");

        // The address no longer carries the link, so the page's state resets.
        useChatUIStore.getState().setComposerText("");
        rerender({});
        rerender({ prompt: "second" });

        expect(useChatUIStore.getState().composerText).toBe("second");
        expect(harness.navigate).toHaveBeenCalledTimes(2);
    });

    it("strips hidden characters from the link's prompt, as the composer does", () => {
        renderLink({ prompt: "ok\u{E0041}\u{E0042} done\u{202E}" });

        expect(useChatUIStore.getState().composerText).toBe("ok done");
    });

    it("caps a linked prompt at the link limit", () => {
        renderLink({ prompt: "a".repeat(PROMPT_LINK_MAX_CHARS + 50) });

        expect(useChatUIStore.getState().composerText).toHaveLength(PROMPT_LINK_MAX_CHARS);
    });

    it("keeps the address's fragment when it removes the link's parameters", () => {
        renderLink({ model: textModel?.id, prompt: "hi" });

        expect(harness.navigate).toHaveBeenCalledWith(expect.objectContaining({ hash: true, replace: true, to: "/chat" }));
    });

    it("removes only the link's own parameters from the address", () => {
        renderLink({ model: textModel?.id, prompt: "hi" });

        expect(harness.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true, to: "/chat" }));

        const { search } = harness.navigate.mock.calls[0]?.[0] as {
            search: (previous: { model?: string; prompt?: string; promptId?: string; redirectReason?: string }) => unknown;
        };

        expect(search({ model: "x", prompt: "y", promptId: "saved", redirectReason: "thread-deleted" })).toStrictEqual({
            promptId: "saved",
            redirectReason: "thread-deleted",
        });
    });

    it("ignores a model that is not in the registry, says so, and still applies the prompt", () => {
        renderLink({ model: "not-a-real-model", prompt: "hi" });

        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
    });

    it("ignores an image model, a disabled model and an external model, says so, and still applies the prompt", () => {
        expect(imageModel).toBeDefined();

        for (const model of [imageModel?.id, disabledModel, externalModel]) {
            useModelStore.setState({ selectedModel: DEFAULT_CHAT_MODEL as ModelId });
            useChatUIStore.getState().setComposerText("");
            harness.showWarning.mockReset();

            const { unmount } = renderLink({ model, prompt: "hi" });

            expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
            expect(useChatUIStore.getState().composerText).toBe("hi");
            expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);

            unmount();
        }
    });

    it("does not apply a custom endpoint's model id, which a link can never carry, and says so", () => {
        renderLink({ model: "custom:ollama/llama3.1:8b", prompt: "hi" });

        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
    });

    it("ends a comparison left on from before, so the draft sends on the named model and not on the comparison's models", () => {
        expect(textModel).toBeDefined();
        expect(otherTextModel).toBeDefined();
        useModelStore.setState({ comparisonMode: true, selectedModelsForComparison: [otherTextModel?.id ?? "", textModel?.id ?? ""] as ModelId[] });

        renderLink({ model: textModel?.id, prompt: "hi" });

        expect(useModelStore.getState().comparisonMode).toBe(false);
        expect(useModelStore.getState().selectedModelsForComparison).toEqual([]);
        expect(selectedModel()).toBe(textModel?.id);
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("does not select a model the composer's picker does not offer, keeps the chat's model, and still drafts the prompt", () => {
        expect(gatedTextModel).toBeDefined();

        renderLink({ linkableModels: new Map([[DEFAULT_CHAT_MODEL, { id: DEFAULT_CHAT_MODEL }]]), model: gatedTextModel?.id, prompt: "hi" });

        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
    });

    it("does not change the chat's model for a link with no prompt, even when it names a model", () => {
        renderLink({ model: textModel?.id });

        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("");
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("a model-only link leaves an existing draft, its model, Auto and comparison as they were", () => {
        useChatUIStore.getState().setComposerText("my own text");
        useModelStore.setState({
            comparisonMode: true,
            pendingSettings: { autoModel: true },
            selectedModelsForComparison: [textModel?.id ?? "", otherTextModel?.id ?? ""] as ModelId[],
        });

        renderLink({ model: textModel?.id });

        expect(useChatUIStore.getState().composerText).toBe("my own text");
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useModelStore.getState().pendingSettings?.autoModel).toBe(true);
        expect(useModelStore.getState().comparisonMode).toBe(true);
    });

    it("ends Auto as a pick does, so the link's model is the one a send runs on", () => {
        useModelStore.setState({ pendingSettings: { autoModel: true } });

        renderLink({ model: textModel?.id, prompt: "hi" });

        expect(selectedModel()).toBe(textModel?.id);
        expect(useModelStore.getState().pendingSettings?.autoModel).toBe(false);
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("a prompt-only link keeps the chat's custom endpoint model, which the picker lists as no entry", () => {
        const custom = "custom:ollama/llama3.1:8b";

        useModelStore.setState({ selectedModel: custom as ModelId });

        renderLink({ prompt: "hi" });

        expect(selectedModel()).toBe(custom);
        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("a link whose default is disabled opens on another text model the picker offers, not the disabled default", () => {
        let enabledText: LinkableModel | undefined;

        for (const entry of OFFERED_TEXT_MODELS.values()) {
            if (entry.id !== DEFAULT_CHAT_MODEL) {
                enabledText = entry;
                break;
            }
        }

        expect(enabledText).toBeDefined();
        // The owner has switched the default off: the picker does not offer it, only other text models.
        const withoutDefault = new Map([...OFFERED_TEXT_MODELS].filter(([id]) => id !== DEFAULT_CHAT_MODEL));

        useModelStore.setState({ newThreadMode: "image", selectedModel: (imageModel?.id ?? "") as ModelId });

        renderLink({ linkableModels: withoutDefault, prompt: "hi" });

        expect(selectedModel()).toBe(enabledText?.id);
        expect(selectedModel()).not.toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("a link with no usable text model in the picker says so, and leaves the model alone rather than selecting a disabled one", () => {
        useModelStore.setState({ newThreadMode: "image", selectedModel: (imageModel?.id ?? "") as ModelId });

        renderLink({ linkableModels: new Map(), prompt: "hi" });

        expect(selectedModel()).toBe(imageModel?.id);
        expect(harness.showWarning).toHaveBeenCalledWith(
            "This chat has no text model available, so the link's draft has no model. Choose one in the model picker.",
        );
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("a model list still loading shows no notice: the link waits, and the notice appears only once the list has loaded with no text model", () => {
        useModelStore.setState({ newThreadMode: "image", selectedModel: (imageModel?.id ?? "") as ModelId });

        const { rerender } = renderLink({ linkableModels: undefined, prompt: "hi", ready: false });

        expect(harness.showWarning).not.toHaveBeenCalled();
        expect(useChatUIStore.getState().composerText).toBe("");

        rerender({ linkableModels: new Map(), prompt: "hi", ready: true });

        expect(harness.showWarning).toHaveBeenCalledTimes(1);
        expect(harness.showWarning).toHaveBeenCalledWith(
            "This chat has no text model available, so the link's draft has no model. Choose one in the model picker.",
        );
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("a model list that loads after the link waits applies the link with its model and no notice", () => {
        useModelStore.setState({ newThreadMode: "image", selectedModel: (imageModel?.id ?? "") as ModelId });

        const { rerender } = renderLink({ linkableModels: undefined, model: gatedTextModel?.id, prompt: "hi", ready: false });

        expect(harness.showWarning).not.toHaveBeenCalled();

        rerender({ linkableModels: OFFERED_TEXT_MODELS, model: gatedTextModel?.id, prompt: "hi", ready: true });

        expect(harness.showWarning).not.toHaveBeenCalled();
        expect(selectedModel()).toBe(gatedTextModel?.id);
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("a model list that never loads applies the draft after the bounded wait: the link's model is refused, and no 'no text model' notice shows", () => {
        useModelStore.setState({ newThreadMode: "image", selectedModel: (imageModel?.id ?? "") as ModelId });

        renderLink({ linkableModels: undefined, model: gatedTextModel?.id, prompt: "hi", ready: true });

        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(harness.showWarning).toHaveBeenCalledTimes(1);
        expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
        expect(harness.showWarning).not.toHaveBeenCalledWith(expect.stringContaining("no text model"));
    });

    it("a link with no model opens a text chat after an image chat, on a text model, never on the image model left selected", () => {
        useModelStore.setState({ newThreadMode: "image", selectedModel: (imageModel?.id ?? "") as ModelId });

        renderLink({ prompt: "hi" });

        expect(useModelStore.getState().newThreadMode).toBe("text");
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("a link naming a non-text model opens a text chat, says the model is unavailable, and keeps a text model", () => {
        useModelStore.setState({ newThreadMode: "image" });

        renderLink({ model: imageModel?.id, prompt: "hi" });

        expect(useModelStore.getState().newThreadMode).toBe("text");
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
    });

    it("opens a text chat on the link's model even when the composer was last in image mode, and sets the new chat to text", () => {
        useModelStore.setState({ newThreadMode: "image" });

        renderLink({ model: textModel?.id, prompt: "hi" });

        expect(selectedModel()).toBe(textModel?.id);
        expect(useModelStore.getState().newThreadMode).toBe("text");
        expect(useChatUIStore.getState().composerText).toBe("hi");
    });

    it("does not apply a text model to an anonymous visitor, whose text chat sends the free model, and says so", () => {
        renderLink({ isAnonymous: true, model: textModel?.id, prompt: "hi" });

        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
    });

    it("applies the free model to an anonymous visitor, since that is the model the composer sends", () => {
        renderLink({ isAnonymous: true, model: ANONYMOUS_FREE_MODEL, prompt: "hi" });

        expect(selectedModel()).toBe(ANONYMOUS_FREE_MODEL);
        expect(harness.showWarning).not.toHaveBeenCalled();
    });

    it("waits for the session before it decides, then applies the link once", () => {
        const { rerender } = renderLink({ model: textModel?.id, prompt: "hi", ready: false });

        expect(harness.navigate).not.toHaveBeenCalled();
        expect(useChatUIStore.getState().composerText).toBe("");
        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);

        rerender({ model: textModel?.id, prompt: "hi", ready: true });

        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(selectedModel()).toBe(textModel?.id);
        expect(harness.navigate).toHaveBeenCalledTimes(1);
    });

    it("gives no model notice when the link's model is not applied because a draft is kept", () => {
        useChatUIStore.getState().setComposerText("my own text");

        renderLink({ model: "not-a-real-model", prompt: "from the link" });

        expect(harness.showWarning).toHaveBeenCalledTimes(1);
        expect(harness.showWarning).toHaveBeenCalledWith("Your draft is kept. The prompt from the link was not added.");
    });
});
