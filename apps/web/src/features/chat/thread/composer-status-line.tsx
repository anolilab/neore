"use client";

import { useLingui } from "@lingui/react/macro";
import { useUnlockProof } from "@neore/client-runtime";
import cn from "@neore/ui/utils/cn";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Bot, ShieldAlert, Target } from "lucide-react";
import type { FC, ReactNode } from "react";

import { useImpersonating } from "@/features/admin/hooks/use-is-impersonating";
import { useChatIsStreaming, useChatThread } from "@/features/chat/core/context/chat-context";
import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { ResearchDepth, SearchMode } from "@/features/chat/core/stores/model-store";
import { getValidThreadId } from "@/features/chat/core/utils/thread-id";
import { useGoalComposer, usePinOverride } from "@/features/chat/goal/goal-store";
import { useLocalModelTarget } from "@/features/local-models/hooks/use-local-model-turn";
import { useCRPC } from "@/lib/lunora/crpc";

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

/**
 * Whether the chat has a pinned goal the next send will run, read as the send reads it (`send-message.ts`): this tab's
 * pending override first, else the pin the owner's pinned-goal control keeps cached. It never fetches on its own, so a
 * chat the viewer does not own, which has no pin cached, shows none. An admin acting as the owner sends without it.
 */
const usePinnedGoalShown = (): boolean => {
    const crpc = useCRPC();
    const { threadId } = useChatThread();
    const validThreadId = getValidThreadId(threadId);
    const unlockProof = useUnlockProof(validThreadId ?? "");
    const impersonating = useImpersonating();
    const override = usePinOverride(validThreadId);
    const { data: cached } = useQuery({
        ...crpc.chat.goals.functions.getPinnedGoal.queryOptions(validThreadId ? { threadId: validThreadId as never, unlockProof } : skipToken),
        enabled: false,
    });

    if (impersonating || !validThreadId) {
        return false;
    }

    return Boolean(override === undefined ? cached : override);
};

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
    const pinned = usePinnedGoalShown();
    // A local model runs one plain turn: no gateway, so no web search, and no tools, so no permission mode; the send drops an
    // armed goal and never applies a pinned one. None of those chips shows for it.
    const isLocal = useLocalModelTarget(useCurrentModel()) !== undefined;
    const attachmentsOnly = useChatUIStore((state) => state.composerText.trim() === "" && state.composerAttachments.length > 0);
    const permission = useShownPermissionMode();
    const { isBotThread } = useBotThread();
    const searchInfo = useSearchModeInfo(searchMode);
    const depthLabels = useResearchDepthLabels();

    const replying = Boolean(sseStreamState);
    const searching = textMode && searchMode !== "chat" && !isLocal;
    // A send with attachments and no text carries no goal (`goalForMessage`), so the chip leaves then; an empty draft keeps it,
    // since the goal is what the next message will run.
    const goal = textMode && (goalOn || pinned) && !attachmentsOnly && !isLocal;
    const fullAccess = textMode && permission === "full" && !isLocal;

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
