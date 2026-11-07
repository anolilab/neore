import { useLingui } from "@lingui/react/macro";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { showWarning } from "@/lib/toast";

import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";
import { promptFromLink } from "../utils/prompt-link";
import type { LinkableModel } from "../utils/prompt-link-model";
import { linkModelAppliesOnOpen } from "../utils/prompt-link-model";

/**
 * The text model a chat opens on when it has none usable: the default, if the picker offers it as a text model, else the first text model
 * the picker offers. `undefined` when the picker offers none.
 */
const textModelFallback = (linkable: ReadonlyMap<string, LinkableModel>): string | undefined => {
    const isText = (entry: LinkableModel): boolean => (entry.mode ?? "text") === "text" && entry.provider !== "external";
    const defaultEntry = linkable.get(DEFAULT_CHAT_MODEL);

    if (defaultEntry !== undefined && isText(defaultEntry)) {
        return DEFAULT_CHAT_MODEL;
    }

    for (const entry of linkable.values()) {
        if (isText(entry)) {
            return entry.id;
        }
    }

    return undefined;
};

/** The chat search without the prompt link's own parameters: a saved prompt or a message in the same URL stays. */
const withoutLinkParameters = (search: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(search).filter(([key]) => key !== "model" && key !== "prompt"));

/**
 * Applies a prompt link once: its prompt becomes the draft, and its model is chosen only when the composer would send with
 * that model (a text new chat, and not an anonymous visitor's, who sends the free model). A link writes its draft and the model it writes,
 * and nothing else: with a model written, it also ends Auto and any comparison, as a pick in the model picker does, and a link that
 * writes no model leaves the chat's mode, comparison and Auto as they are. A draft or a saved prompt already in place is kept with a notice, and so is the model the person
 * chose. A model the composer would not send is left alone, with a notice. The link's parameters are then removed from the
 * address. It never sends. Nothing is decided until `ready`: the anonymity it reads comes from the session.
 */
export const usePromptLinkDraft = ({
    linkableModels,
    isAnonymous = false,
    model,
    onDecided,
    otherDraftSource = false,
    prompt,
    ready = true,
}: {
    /** The signed-in person is an anonymous guest: the composer sends the free model for them in a text chat. */
    isAnonymous?: boolean;

    /**
     * The entries of the composer's picker list (`useComposerModelEntries`). A link selects a model only if it is in this list, so a
     * model the person is not entitled to, or has blocked, is not selected by a link. `undefined` while the list has not loaded: the
     * link then selects no model, and says nothing about a text model, since it does not yet know whether one exists.
     */
    linkableModels: ReadonlyMap<string, LinkableModel> | undefined;
    model?: string;
    /** Called once the link can be decided (the caller's own ownership of the draft ends here, after this pass has read it). */
    onDecided?: () => void;
    /** A saved prompt or a message in the same URL already supplies this chat's draft: the link does not replace it. */
    otherDraftSource?: boolean;
    prompt?: string;
    /** False until the session is known; the link waits, so its model is never decided on a guess about who is signed in. */
    ready?: boolean;
}): void => {
    const { t } = useLingui();
    const navigate = useNavigate();
    // The link last applied on this mounted page, by its text and model: a different link is a new one, and applies on its own terms.
    const appliedKeyRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        if (!ready) {
            return;
        }

        // The first time the link can be decided, whatever else owns the draft has been read: the caller may now stop treating it as owned.
        onDecided?.();

        // No link in the address: the next link on this mounted page starts afresh.
        if (prompt === undefined && model === undefined) {
            appliedKeyRef.current = undefined;

            return;
        }

        // A link is applied once. A later link with other text or another model is a new link: it is decided on its own terms, not on the
        // refusal or the selection of the one before it.
        const linkKey = JSON.stringify([prompt, model]);

        if (appliedKeyRef.current === linkKey) {
            return;
        }

        appliedKeyRef.current = linkKey;

        // The link's model is chosen only when nothing else owns this chat's draft: a kept or refused draft keeps the model the
        // person chose, and so does a saved prompt named in the URL.
        let applyLink = !otherDraftSource;

        if (prompt !== undefined) {
            const { attachedReferences, composerAttachments, composerText, setComposerText } = useChatUIStore.getState();
            // Attachments and references are part of the draft too: a link's text would be sent with them.
            const hasDraft = composerText.trim() !== "" || composerAttachments.length > 0 || attachedReferences.length > 0;

            if (otherDraftSource) {
                applyLink = false;
                showWarning(t`This chat already has a prompt. The prompt from the link was not added.`);
            } else if (hasDraft) {
                applyLink = false;
                showWarning(t`Your draft is kept. The prompt from the link was not added.`);
            } else {
                setComposerText(promptFromLink(prompt));
            }
        }

        // The link owns its draft and, when it writes one, the model. A link that names no model leaves the chat's mode, comparison and Auto
        // as the composer has them. When it writes a model, the chat is a text chat on that model: a comparison left on would send to its
        // own models, Auto would route past the model, and a text draft cannot go to an image mode. The model is the link's, when the
        // composer offers it as a text model; otherwise a text model the chat already has, or the default text model.
        if (applyLink && prompt !== undefined) {
            const state = useModelStore.getState();

            // Until the list has loaded, it offers nothing: a link's model is refused (a blocked model must never be selected), and the
            // chat is not told it has no text model, because that is not yet known.
            const offered: ReadonlyMap<string, LinkableModel> = linkableModels ?? new Map();

            // A link's model travels only with its prompt (`readPromptLinkSearch` drops it otherwise).
            const sendsLinkModel = model !== undefined && linkModelAppliesOnOpen({ isAnonymous, linkable: offered, model });
            let writtenModel: string | undefined;

            if (model !== undefined && sendsLinkModel) {
                writtenModel = model;
            } else {
                if (model !== undefined) {
                    showWarning(t`This link's model is not available in this chat. The chat keeps its model.`);
                }

                // An image chat leaves an image model selected; a text chat must not send with one. The free model is the anonymous
                // visitor's, whatever is stored.
                const selected = offered.get(state.selectedModel);
                const selectedIsText = selected !== undefined && (selected.mode ?? "text") === "text" && selected.provider !== "external";
                // A custom endpoint's model is a text model the picker does not list here: the chat keeps it (its id is `custom:…`, as in
                // `custom-model-id.ts`, which is not imported here so the registry stays out of this module).
                const selectedIsCustom = state.selectedModel.startsWith("custom:");

                // With no list there is no fallback to pick, so the chat keeps the model it has until the list loads.
                if (linkableModels !== undefined && !isAnonymous && !selectedIsText && !selectedIsCustom) {
                    // The default is taken only if the picker offers it: a default the owner has switched off is not a model the chat may open on.
                    const fallback = textModelFallback(linkableModels);

                    if (fallback === undefined) {
                        showWarning(t`This chat has no text model available, so the link's draft has no model. Choose one in the model picker.`);
                    } else {
                        writtenModel = fallback;
                    }
                }
            }

            if (writtenModel !== undefined) {
                state.setComparisonMode(false);
                state.setComposerMode("text", undefined, false);
                state.setSelectedModel(writtenModel as ModelId, undefined);

                // The model the link writes is the one a send runs on: Auto ends, as it does when the person picks a model.
                if (state.pendingSettings?.autoModel === true) {
                    state.setPendingSettings((previous) => {
                        return { ...previous, autoModel: false };
                    });
                }
            }
        }

        // `hash: true` keeps the address's fragment: removing the link's parameters must not remove a `#section` the address also has.
        void navigate({ hash: true, replace: true, search: (previous: Record<string, unknown>) => withoutLinkParameters(previous), to: "/chat" });
    }, [isAnonymous, linkableModels, model, navigate, onDecided, otherDraftSource, prompt, ready, t]);
};
