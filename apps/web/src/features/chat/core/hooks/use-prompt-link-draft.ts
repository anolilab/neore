import { useLingui } from "@lingui/react/macro";
import { enabledModelOf } from "@neore/ai/models";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import useFeatureFlaggedModels, { useFeatureFlaggedModelsSettled } from "@/hooks/use-feature-flagged-models";
import { showWarning } from "@/lib/toast";

import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";

/**
 * A model a link may select: an enabled text model the app can call (`MODEL_LOOKUP` leaves out external, marketing-only rows)
 * that the picker offers this person (`pickerModelIds`: flags, their own switched-off models and filter rules), read once that
 * list has settled. A catalog that failed to load offers nothing, so the link's model is then not taken.
 */
const isLinkableModel = (model: string, pickerModelIds: ReadonlySet<string>): boolean =>
    enabledModelOf(model, { mode: "text" }) !== undefined && pickerModelIds.has(model);

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
    ready = true,
}: {
    model: string | undefined;
    /** A landing message in the same address supplies this chat's draft. */
    otherDraftSource: boolean;
    prompt: string | undefined;
    /** False while another source of the draft has not settled yet (a saved prompt still loading): the link waits in the address. */
    ready?: boolean;
}): void => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const pickerModels = useFeatureFlaggedModels({ applyUserOverrides: true });
    const pickerModelIds = useMemo(() => new Set(pickerModels.map((entry) => entry.id)), [pickerModels]);
    const pickerSettled = useFeatureFlaggedModelsSettled();
    const appliedRef = useRef<string | undefined>(undefined);
    // The model of a link whose prompt was applied, waiting for the picker's list: judged earlier, it could pick a model the
    // list then leaves out. The prompt itself does not wait for it.
    const pendingModelRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        // No link in the address: the next one, even the same link again, is a new visit.
        if (prompt === undefined) {
            appliedRef.current = undefined;

            return;
        }

        if (!ready) {
            return;
        }

        const key = JSON.stringify([prompt, model]);

        if (appliedRef.current === key) {
            return;
        }

        appliedRef.current = key;

        const clearLink = () => {
            void navigate({
                hash: true,
                replace: true,
                search: (previous: { model?: string; prompt?: string }) => {
                    return { ...previous, model: undefined, prompt: undefined };
                },
                to: "/chat",
            });
        };

        // A link with nothing usable in it is only cleared from the address.
        if (prompt === "") {
            clearLink();

            return;
        }

        const { attachedReferences, composerAttachments, composerText, setComposerText } = useChatUIStore.getState();
        const hasDraft = composerText.trim() !== "" || composerAttachments.length > 0 || attachedReferences.length > 0;

        if (otherDraftSource || hasDraft) {
            showWarning(t`Your draft is kept. The prompt from the link was not added.`);
        } else {
            setComposerText(prompt);
            pendingModelRef.current = model;
        }

        clearLink();
    }, [model, navigate, otherDraftSource, prompt, ready, t]);

    useEffect(() => {
        const pendingModel = pendingModelRef.current;

        if (pendingModel === undefined || !pickerSettled) {
            return;
        }

        pendingModelRef.current = undefined;

        if (isLinkableModel(pendingModel, pickerModelIds)) {
            const state = useModelStore.getState();

            // A text draft on a text model: a comparison or another mode would send it elsewhere.
            state.setComparisonMode(false);
            state.setComposerMode("text", undefined, false);
            state.setSelectedModel(pendingModel as ModelId, undefined);
        } else {
            showWarning(t`The model in the link is not available. The chat keeps its model.`);
        }
        // `prompt` is read so this runs right after the effect above has set a model aside, in the same commit.
    }, [pickerModelIds, pickerSettled, prompt, t]);
};
