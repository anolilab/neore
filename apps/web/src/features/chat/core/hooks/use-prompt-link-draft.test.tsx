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

interface LinkProps {
    isAnonymous?: boolean;
    model?: string;
    otherDraftSource?: boolean;
    prompt?: string;
    ready?: boolean;
}

const renderLink = (initial: LinkProps) => renderHook((props: LinkProps) => usePromptLinkDraft(props), { initialProps: initial });

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

    it("does not apply a link's model to an image, video or audio new chat, which would send in that mode", () => {
        useModelStore.setState({ newThreadMode: "image" });

        renderLink({ model: textModel?.id, prompt: "hi" });

        expect(selectedModel()).toBe(DEFAULT_CHAT_MODEL);
        expect(useChatUIStore.getState().composerText).toBe("hi");
        expect(harness.showWarning).toHaveBeenCalledWith(MODEL_NOTICE);
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
