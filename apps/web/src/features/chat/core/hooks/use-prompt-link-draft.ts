import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { showWarning } from "@/lib/toast";

import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";
import { carriableLinkModel, promptFromLink } from "../utils/prompt-link";

/** The chat search without the prompt link's own parameters: a saved prompt or a message in the same URL stays. */
const withoutLinkParameters = (search: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(search).filter(([key]) => key !== "model" && key !== "prompt"));

/**
 * Applies a prompt link once: its prompt becomes the draft, and its model is chosen when the link can name it
 * (`carriableLinkModel`). A draft or a saved prompt already in place is kept with a notice, and so is the model the person
 * chose. A model the link cannot name is left alone, with a notice. The link's parameters are then removed from the address.
 * It never sends.
 */
export const usePromptLinkDraft = ({
    model,
    otherDraftSource = false,
    prompt,
}: {
    model?: string;
    /** A saved prompt or a message in the same URL already supplies this chat's draft: the link does not replace it. */
    otherDraftSource?: boolean;
    prompt?: string;
}): void => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const appliedRef = useRef(false);

    useEffect(() => {
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

        // The composer takes text models only: a speech or image model, a custom endpoint's model or an external one a link
        // names is not applied, and the person is told so rather than left on a model the link did not name.
        if (applyLink && model !== undefined) {
            const definition = carriableLinkModel(model);

            if (definition) {
                useModelStore.getState().setSelectedModel(definition.id as ModelId, undefined);
            } else {
                showWarning(t`This link's model is not available in this chat. The chat keeps its model.`);
            }
        }

        void navigate({ replace: true, search: (previous: Record<string, unknown>) => withoutLinkParameters(previous), to: "/chat" });
    }, [model, navigate, otherDraftSource, prompt, t]);
};
