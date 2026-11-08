import { useLingui } from "@lingui/react/macro";
import { enabledModelOf } from "@neore/ai/models";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { filterModelsByBlockedCreators } from "@/components/model-picker/utilities";
import useFeatureFlaggedModels, { useFeatureFlaggedModelsSettled, useModelPreferencesFailed } from "@/hooks/use-feature-flagged-models";
import { useModelFilterRules } from "@/hooks/use-model-filter-rules";
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

/** What the person has chosen in the composer: a link's model waiting for the picker's list is dropped once any of it changes. */
const chosenOf = ({ comparisonMode, newThreadMode, selectedModel }: ReturnType<typeof useModelStore.getState>): string =>
    JSON.stringify([selectedModel, comparisonMode, newThreadMode]);

/**
 * The link's parameters as the address first wrote them (`written`), held while the router's `parsed` values (serialized) stay the
 * same. A navigation that keeps the search (opening Settings while a saved prompt loads) writes them back from the parsed values,
 * so `prompt=1.50` would become `1.5`; a new link, or the link leaving the address, changes `parsed`.
 */
export const useLinkSearchAsWritten = <T>(parsed: string, readWritten: () => T): T => {
    // `readWritten` runs only when the link changes: a prompt can be long, and the page re-renders often while it waits.
    const [held, setHeld] = useState(() => {
        return { parsed, written: readWritten() };
    });

    if (held.parsed !== parsed) {
        const written = readWritten();

        setHeld({ parsed, written });

        return written;
    }

    return held.written;
};

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
    // The labs the person hid from the picker are not offered there, so a link cannot pick their models either.
    const blockedCreators = useModelFilterRules()?.blockedCreators;
    const pickerModelIds = useMemo(
        () => new Set(filterModelsByBlockedCreators(pickerModels, blockedCreators ?? []).map((entry) => entry.id)),
        [blockedCreators, pickerModels],
    );
    const pickerSettled = useFeatureFlaggedModelsSettled();
    // Without the person's preferences the list hides nothing they hid, so a link's model is refused rather than judged by it.
    const preferencesFailed = useModelPreferencesFailed();
    const appliedRef = useRef<string | undefined>(undefined);
    // The model of a link whose prompt was applied, waiting for the picker's list: judged earlier, it could pick a model the
    // list then leaves out. The prompt itself does not wait for it. `chosen` is the chat's model, comparison and mode then: any of
    // them the person changes in the meantime is theirs, and the link's model is dropped.
    const pendingModelRef = useRef<{ chosen: string; model: string } | undefined>(undefined);

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
        // A new link replaces what an earlier one set aside, whether this one applies or not.
        pendingModelRef.current = undefined;

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
            pendingModelRef.current = model === undefined ? undefined : { chosen: chosenOf(useModelStore.getState()), model };
        }

        clearLink();
    }, [model, navigate, otherDraftSource, prompt, ready, t]);

    useEffect(() => {
        const pending = pendingModelRef.current;

        if (pending === undefined || !pickerSettled) {
            return;
        }

        pendingModelRef.current = undefined;

        const state = useModelStore.getState();

        if (chosenOf(state) !== pending.chosen) {
            return;
        }

        if (!preferencesFailed && isLinkableModel(pending.model, pickerModelIds)) {
            // A text draft on a text model: a comparison or another mode would send it elsewhere.
            state.setComparisonMode(false);
            state.setComposerMode("text", undefined, false);
            state.setSelectedModel(pending.model as ModelId, undefined);
        } else {
            showWarning(t`The model in the link is not available. The chat keeps its model.`);
        }
        // `model`, `otherDraftSource`, `prompt` and `ready` are what let the effect above set a model aside, so a change to any of
        // them runs this right after it, in the same commit.
    }, [model, otherDraftSource, pickerModelIds, pickerSettled, preferencesFailed, prompt, ready, t]);
};
