"use client";

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";
import useModelInfo from "@/features/chat/core/hooks/use-model-info";
import useThreadUsage from "@/features/chat/core/hooks/use-thread-usage";

import ContextUsageMeter from "./context-usage-meter";

interface ComposerContextCountProps {
    className?: string;
}

/**
 * Displays context usage as a visual indicator in the composer.
 * Shows used tokens vs model's context window.
 */
const ComposerContextCount: FC<ComposerContextCountProps> = ({ className }) => {
    const { t } = useLingui();
    const { threadId } = useChatThread();
    const usage = useThreadUsage(threadId);
    const { contextWindow, modelDefinition } = useModelInfo(threadId);

    // Don't render if no context window info available
    if (!contextWindow) {
        return null;
    }

    return (
        <ContextUsageMeter
            className={className}
            contextWindow={contextWindow}
            detail={modelDefinition?.name ? t`Model: ${modelDefinition.name}` : undefined}
            usedTokens={usage?.totalTokens ?? 0}
        />
    );
};

export default ComposerContextCount;
