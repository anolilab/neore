"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { Bot, ShieldAlert, Target } from "lucide-react";
import type { FC, ReactNode } from "react";

import { useChatIsStreaming } from "@/features/chat/core/context/chat-context";
import type { ResearchDepth, SearchMode } from "@/features/chat/core/stores/model-store";
import { useGoalComposer } from "@/features/chat/goal/goal-store";

import { useBotThread } from "./composer-model-selector";
import { useShownPermissionMode } from "./composer-permission-mode";
import { useResearchDepthLabels } from "./composer-research-depth";
import { useSearchModeInfo } from "./composer-search-mode";

/** One quiet chip. Information, not a control: no button, no hover. */
const StatusChip: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
    <span className={cn("bg-surface-row-active text-muted-foreground inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs", className)}>
        {children}
    </span>
);

interface ComposerStatusLineProps {
    researchDepth: ResearchDepth;
    searchMode: SearchMode;
    /** The text mode: search, a goal and the permission mode apply to text messages only. */
    textMode: boolean;
}

/**
 * What the composer is doing or has armed for the next message, as a row of small chips above the input. It renders nothing
 * when no chip applies, so an idle composer looks as it always did. It states what the controls below already show; it is a
 * plain labelled group, not a live region, so it does not read out again every change the controls announce.
 */
const ComposerStatusLine: FC<ComposerStatusLineProps> = ({ researchDepth, searchMode, textMode }) => {
    const { t } = useLingui();
    const { sseStreamState } = useChatIsStreaming();
    const goalOn = useGoalComposer((state) => state.enabled);
    const permission = useShownPermissionMode();
    const { isBotThread } = useBotThread();
    const searchInfo = useSearchModeInfo(searchMode);
    const depthLabels = useResearchDepthLabels();

    const replying = Boolean(sseStreamState);
    const searching = textMode && searchMode !== "chat";
    const goal = textMode && goalOn;
    const fullAccess = textMode && permission === "full";

    if (!replying && !searching && !goal && !fullAccess && !isBotThread) {
        return null;
    }

    const SearchIcon = searchInfo.icon;

    return (
        <div aria-label={t`Composer status`} className="flex flex-wrap items-center gap-1.5" role="group">
            {replying && (
                <StatusChip className="text-primary-text">
                    <span aria-hidden="true" className="bg-primary-text size-1.5 shrink-0 rounded-full" />
                    {t`Replying`}
                </StatusChip>
            )}
            {searching && (
                <StatusChip>
                    <SearchIcon aria-hidden="true" className="size-3 shrink-0" />
                    {`${searchInfo.label} · ${depthLabels[researchDepth]}`}
                </StatusChip>
            )}
            {goal && (
                <StatusChip>
                    <Target aria-hidden="true" className="size-3 shrink-0" />
                    {t`Goal: run until done`}
                </StatusChip>
            )}
            {fullAccess && (
                <StatusChip className="text-attention bg-attention/10">
                    <ShieldAlert aria-hidden="true" className="size-3 shrink-0" />
                    {t`Tools run without asking`}
                </StatusChip>
            )}
            {isBotThread && (
                <StatusChip>
                    <Bot aria-hidden="true" className="size-3 shrink-0" />
                    {t`The bot sets the model for this chat.`}
                </StatusChip>
            )}
        </div>
    );
};

export default ComposerStatusLine;
