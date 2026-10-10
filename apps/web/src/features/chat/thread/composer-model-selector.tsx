"use client";

import { ANONYMOUS_FREE_MODEL } from "@neore/ai/constants";
import type { FC } from "react";

import { ModelPickerButton } from "@/components/model-picker";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { MIN_COMPARISON_MODELS, useModelStore } from "@/features/chat/core/stores/model-store";
import useModelCombobox from "@/features/chat/model-settings/use-model-combobox";

interface ComposerModelSelectorProps {
    className?: string;
}

const ComposerModelSelector: FC<ComposerModelSelectorProps> = ({ className }) => {
    const { model, threadId } = useChatThread();
    const { changeModel } = useModelCombobox({ threadId });
    const { isAnonymous } = useIsAnonymous();

    // Get current composer mode to show mode-appropriate model for anonymous users
    const storeNewThreadMode = useModelStore((state) => state.newThreadMode);
    const storeThreadMode = useModelStore((state) => state.threadModes.get(threadId || ""));
    const currentMode = threadId ? (storeThreadMode ?? "text") : storeNewThreadMode;

    // For anonymous users: only show the free router model in text mode.
    // In image/video/audio modes, show the actual model selected by the mode switch
    // so the picker button reflects the correct mode-appropriate model.
    const effectiveModelId = isAnonymous && currentMode === "text" ? ANONYMOUS_FREE_MODEL : model;
    const comparisonMode = useModelStore((state) => state.comparisonMode);
    const selectedModelsForComparison = useModelStore((state) => state.selectedModelsForComparison);
    const setComparisonMode = useModelStore((state) => state.setComparisonMode);
    const setSelectedModelsForComparison = useModelStore((state) => state.setSelectedModelsForComparison);

    const handleSelect = (modelId: string) => {
        // Single model selected — exit comparison mode (also clears selectedModelsForComparison)
        setComparisonMode(false);
        changeModel(modelId);
    };

    const handleSelectMultiple = (modelIds: string[]) => {
        if (modelIds.length >= MIN_COMPARISON_MODELS) {
            setSelectedModelsForComparison(modelIds);
            setComparisonMode(true);
        } else {
            setComparisonMode(false);
        }
    };

    const baseClassName =
        className ||
        "bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 hover:border-border dark:hover:border-sidebar-border/50 text-foreground h-7 w-[200px] dark:text-white";

    return (
        <ModelPickerButton
            className={baseClassName}
            includeCustomModels
            modelId={effectiveModelId}
            onSelect={handleSelect}
            onSelectMultiple={handleSelectMultiple}
            selectedModelIds={
                !isAnonymous && comparisonMode && selectedModelsForComparison.length >= MIN_COMPARISON_MODELS ? selectedModelsForComparison : undefined
            }
            size="sm"
        />
    );
};

export default ComposerModelSelector;
