"use client";

import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import type { FC } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

interface MessageModelBadgeProps {
    model?: string | null;
}

const MessageModelBadge: FC<MessageModelBadgeProps> = ({ model }) => {
    const models = useFeatureFlaggedModels();
    const modelDefinition = model ? (models.find((m) => m.id === model) ?? null) : null;
    const modelInfo = model
        ? {
              displayName: modelDefinition ? (modelDefinition.name ?? modelDefinition.id) : model,
              modelDefinition,
          }
        : null;

    if (!modelInfo?.displayName) {
        return null;
    }

    return (
        <div className="text-muted-foreground ml-1 flex items-center gap-1.5 text-xs">
            {modelInfo.modelDefinition?.displayProvider && (
                <ProviderIcon
                    className="size-3 shrink-0"
                    provider={modelInfo.modelDefinition.provider || modelInfo.modelDefinition.displayProvider}
                    providerIcon={modelInfo.modelDefinition.displayProvider}
                />
            )}
            <span>{modelInfo.displayName}</span>
        </div>
    );
};

export default MessageModelBadge;
