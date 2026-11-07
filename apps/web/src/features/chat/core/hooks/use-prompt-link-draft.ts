import { useLingui } from "@lingui/react/macro";
import { enabledModelOf } from "@neore/ai/models";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { showWarning } from "@/lib/toast";

import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";

/** A model a link may select: an enabled text model the app can call (`MODEL_LOOKUP` leaves out external, marketing-only rows). */
const isLinkableModel = (model: string): boolean => enabledModelOf(model, { mode: "text" }) !== undefined;

/**
 * Applies a prompt link once (`core/utils/prompt-link.ts`): its prompt becomes the new chat's draft, and its model is selected when
 * the registry allows it. A draft already in the composer, or one a saved prompt or a landing message supplies, is kept with a notice,
 * and so is the chat's model. The link's parameters are then removed from the address, so a reload does not apply it again. It never
 * sends.
 */
export const usePromptLinkDraft = ({
    model,
    otherDraftSource,
    prompt,
}: {
    model: string | undefined;
    /** A saved prompt or a landing message in the same address supplies this chat's draft. */
    otherDraftSource: boolean;
    prompt: string | undefined;
}): void => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const appliedRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        if (prompt === undefined) {
            return;
        }

        const key = JSON.stringify([prompt, model]);

        if (appliedRef.current === key) {
            return;
        }

        appliedRef.current = key;

        const { attachedReferences, composerAttachments, composerText, setComposerText } = useChatUIStore.getState();
        const hasDraft = composerText.trim() !== "" || composerAttachments.length > 0 || attachedReferences.length > 0;

        if (otherDraftSource || hasDraft) {
            showWarning(t`Your draft is kept. The prompt from the link was not added.`);
        } else {
            setComposerText(prompt);

            if (model !== undefined && isLinkableModel(model)) {
                const state = useModelStore.getState();

                // A text draft on a text model: a comparison or another mode would send it elsewhere.
                state.setComparisonMode(false);
                state.setComposerMode("text", undefined, false);
                state.setSelectedModel(model as ModelId, undefined);
            } else if (model !== undefined) {
                showWarning(t`The model in the link is not available. The chat keeps its model.`);
            }
        }

        void navigate({
            hash: true,
            replace: true,
            search: (previous: { model?: string; prompt?: string }) => {
                return { ...previous, model: undefined, prompt: undefined };
            },
            to: "/chat",
        });
    }, [model, navigate, otherDraftSource, prompt, t]);
};
