import { useLingui } from "@lingui/react/macro";
import { MODEL_LOOKUP } from "@neore/ai/models";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { showWarning } from "@/lib/toast";

import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";
import { promptFromLink } from "../utils/prompt-link";

/**
 * Applies a prompt link once: its prompt becomes the draft (a draft the composer already holds is kept, with a notice),
 * and its model is chosen when the model is enabled and not external. The link's parameters are then removed from the
 * address. It never sends.
 */
export const usePromptLinkDraft = ({ model, prompt }: { model?: string; prompt?: string }): void => {
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

        if (prompt !== undefined) {
            const draft = promptFromLink(prompt);
            const { attachedReferences, composerAttachments, composerText, setComposerText } = useChatUIStore.getState();
            // Attachments and references are part of the draft too: a link's text would be sent with them.
            const hasDraft = composerText.trim() !== "" || composerAttachments.length > 0 || attachedReferences.length > 0;

            if (hasDraft) {
                showWarning(t`Your draft is kept. The prompt from the link was not added.`);
            } else {
                setComposerText(draft);
            }
        }

        const definition = model === undefined ? undefined : MODEL_LOOKUP.get(model);

        if (definition && definition.enabled !== false && definition.provider !== "external") {
            useModelStore.getState().setSelectedModel(definition.id as ModelId, undefined);
        }

        void navigate({ replace: true, search: {}, to: "/chat" });
    }, [model, navigate, prompt, t]);
};
