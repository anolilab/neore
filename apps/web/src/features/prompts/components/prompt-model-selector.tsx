"use client";

import { useLingui } from "@lingui/react/macro";
import clsx from "clsx";
import type { FC } from "react";

import { ModelPickerButton } from "@/components/model-picker";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

interface PromptModelSelectorProps {
    errorMessage?: string;
    onChange: (modelId: string | undefined) => void;
    showError?: boolean;
    value: string | undefined;
}

const PromptModelSelector: FC<PromptModelSelectorProps> = ({ errorMessage, onChange, showError, value }) => {
    const { t } = useLingui();
    const models = useFeatureFlaggedModels();
    const selectedModel = value ? models.find((m) => m.id === value) : undefined;

    const handleSelect = (modelId: string) => {
        onChange(modelId);
    };

    return (
        <div className="space-y-2">
            <ModelPickerButton
                className={clsx(
                    "h-9 w-full",
                    "bg-background/60 dark:bg-sidebar/80",
                    "border-border dark:border-sidebar-border/15",
                    "hover:bg-accent/50 dark:hover:bg-sidebar-accent/30",
                    "hover:border-border dark:hover:border-sidebar-border/50",
                    "text-foreground dark:text-white",
                    "transition-colors",
                    showError && "border-destructive",
                )}
                model={selectedModel}
                modelId={value}
                onSelect={handleSelect}
                placeholder={t`Select model (optional)`}
            />
            {showError && errorMessage && <p className="text-destructive text-xs">{errorMessage}</p>}
        </div>
    );
};

export default PromptModelSelector;
