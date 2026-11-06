import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { showWarning } from "@/lib/toast";

import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";
import { composerModelOf } from "../utils/composer-model";
import { promptFromLink } from "../utils/prompt-link";
import { carriableLinkModel } from "../utils/prompt-link-model";

/** The chat search without the prompt link's own parameters: a saved prompt or a message in the same URL stays. */
const withoutLinkParameters = (search: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(search).filter(([key]) => key !== "model" && key !== "prompt"));

/**
 * Applies a prompt link once: its prompt becomes the draft, and its model is chosen only when the composer would send with
 * that model (a text new chat, and not an anonymous visitor's, who sends the free model). Naming it ends Auto and any
 * comparison, as a pick in the model picker does. A draft or a saved prompt already in place is kept with a notice, and so is the model the person
 * chose. A model the composer would not send is left alone, with a notice. The link's parameters are then removed from the
 * address. It never sends. Nothing is decided until `ready`: the anonymity it reads comes from the session.
 */
export const usePromptLinkDraft = ({
    allowedModelIds,
    isAnonymous = false,
    model,
    otherDraftSource = false,
    prompt,
    ready = true,
}: {
    /**
     * The models the composer's picker offers this user (`useComposerModels`). A link selects a model only from this set, so a
     * model the person is not entitled to, or has blocked, is not selected by a link.
     */
    allowedModelIds: ReadonlySet<string>;
    /** The signed-in person is an anonymous guest: the composer sends the free model for them in a text chat. */
    isAnonymous?: boolean;
    model?: string;
    /** A saved prompt or a message in the same URL already supplies this chat's draft: the link does not replace it. */
    otherDraftSource?: boolean;
    prompt?: string;
    /** False until the session is known; the link waits, so its model is never decided on a guess about who is signed in. */
    ready?: boolean;
}): void => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const appliedRef = useRef(false);

    useEffect(() => {
        if (!ready) {
            return;
        }

        // The link's parameters are gone once it is applied, so the next link on this mounted page applies too.
        if (prompt === undefined && model === undefined) {
            appliedRef.current = false;

            return;
        }

        if (appliedRef.current) {
            return;
        }

        appliedRef.current = true;

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

        // A link's model travels only with its prompt (`readPromptLinkSearch` drops it otherwise), so a link without one leaves the model alone.
        if (applyLink && prompt !== undefined && model !== undefined) {
            const state = useModelStore.getState();
            const definition = carriableLinkModel(model);
            // The model the composer sends with is the link's only in a text chat, and only where the composer shows that model
            // (an anonymous visitor's text chat shows the free model instead). Anything else would send a different model.
            const sendsLinkModel =
                definition !== undefined &&
                allowedModelIds.has(definition.id) &&
                state.newThreadMode === "text" &&
                composerModelOf({ isAnonymous, mode: "text", threadModel: definition.id }) === definition.id;

            if (definition && sendsLinkModel) {
                // A comparison left on from before would fan the draft out to its models, not to the one the link names.
                // Ending it clears its selection too, as the picker does when a single model is chosen.
                state.setComparisonMode(false);
                state.setSelectedModel(definition.id as ModelId, undefined);

                // Naming a model is choosing it, so Auto ends with the pick, as it does in the model picker for a new chat.
                if (state.pendingSettings?.autoModel === true) {
                    state.setPendingSettings((previous) => {
                        return { ...previous, autoModel: false };
                    });
                }
            } else {
                showWarning(t`This link's model is not available in this chat. The chat keeps its model.`);
            }
        }

        void navigate({ replace: true, search: (previous: Record<string, unknown>) => withoutLinkParameters(previous), to: "/chat" });
    }, [allowedModelIds, isAnonymous, model, navigate, otherDraftSource, prompt, ready, t]);
};
