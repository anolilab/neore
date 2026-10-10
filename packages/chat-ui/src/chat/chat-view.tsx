import { useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { ArrowLeft } from "lucide-react";
import type { FC, ReactNode } from "react";

import type { ModelPickerButtonProps } from "../model-picker/model-picker-button";
import { ModelPickerButton } from "../model-picker/model-picker-button";
import type { OrgSwitcherOrganization } from "../org-switcher/org-switcher";
import type { ChatMessage, ToolPart } from "../types/message";
import type { Thread } from "../types/thread";
import cn from "../utils/cn";
import type { AutoContinueState } from "./auto-continue-status";
import AutoContinueStatus from "./auto-continue-status";
import Composer from "./composer";
import MessageList from "./message-list";

interface ChatViewProps {
    activeOrgId?: null | string;
    autoContinueState?: AutoContinueState;
    availableModels: GatewayModel[];
    className?: string;
    components?: {
        DocumentArtifact?: FC<{ documentId: string; kind: string; title: string; version: number }>;
        McpApp?: FC<{ part: ToolPart; resourceUri: string; serverName: string; toolName: string }>;
        PresentationArtifact?: FC<{ presentationId: string; slideCount: number; styleName?: string; title: string }>;
        toolMeta?: Map<string, { resourceUri: string; serverName: string }>;
    };
    /** Loaded into the composer whenever `id` changes (see `Composer`'s `draft`). */
    composerDraft?: { id: number; text: string };
    /** Rendered directly above the composer — attachment chips, notices. */
    composerSlot?: ReactNode;
    favorites?: string[];
    hasMoreMessages?: boolean;
    /** Extra controls rendered in the header after the model picker. */
    headerActions?: ReactNode;
    isStreaming: boolean;
    messages: ChatMessage[];
    modelPickerProps?: Partial<ModelPickerButtonProps>;
    onAutoContinueChange?: (enabled: boolean) => void;
    onBack?: () => void;
    onBranchMessage?: (id: string) => void;
    onCancelAutoContinue?: () => void;
    onCopyMessage?: (id: string) => void;
    onLoadMoreMessages?: () => void;
    onPinMessage?: (id: string) => void;
    onRegenerateMessage?: (id: string) => void;
    onSelectModel: (modelId: string) => void;
    onSendMessage: (text: string, options?: { shouldAutoContinue?: boolean }) => void;
    onSwitchOrg?: (orgId: null | string) => void;
    onToggleFavorite?: (modelId: string) => void;
    organizations?: OrgSwitcherOrganization[];
    selectedModelId: string;
    shouldAutoContinue?: boolean;
    showAutoContinue?: boolean;
    thread: Thread;
}

const ChatView = ({
    autoContinueState,
    availableModels,
    className,
    components,
    composerDraft,
    composerSlot,
    favorites,
    hasMoreMessages = false,
    headerActions,
    isStreaming,
    messages,
    modelPickerProps,
    onAutoContinueChange,
    onBack,
    onBranchMessage,
    onCancelAutoContinue,
    onCopyMessage,
    onLoadMoreMessages,
    onPinMessage,
    onRegenerateMessage,
    onSelectModel,
    onSendMessage,
    onToggleFavorite,
    selectedModelId,
    shouldAutoContinue,
    showAutoContinue = false,
    thread,
}: ChatViewProps) => {
    const { t } = useLingui();
    const title = thread.title || t`New Chat`;

    return (
        <div className={cn("flex h-full flex-col bg-white dark:bg-gray-950", className)}>
            {/* ── Header ────────────────────────────────────────────────────── */}
            <header className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2.5 dark:border-gray-800">
                {onBack && (
                    <button
                        aria-label={t`Go back`}
                        className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-lg",
                            "text-gray-500 hover:bg-gray-100 hover:text-gray-700",
                            "dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200",
                            "focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none",
                            "transition-colors",
                        )}
                        onClick={onBack}
                        type="button"
                    >
                        <ArrowLeft aria-hidden="true" className="size-4" />
                    </button>
                )}

                <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800 dark:text-gray-100" title={title}>
                    {title}
                </h1>

                <div className="shrink-0">
                    <ModelPickerButton
                        className="h-7 max-w-[160px] text-xs"
                        disabled={isStreaming}
                        favorites={favorites}
                        modelId={selectedModelId}
                        models={availableModels}
                        onSelect={onSelectModel}
                        onToggleFavorite={onToggleFavorite}
                        size="sm"
                        variant="outline"
                        {...modelPickerProps}
                    />
                </div>

                {headerActions}
            </header>

            {/* ── Message list ────────────────────────────────────────────── */}
            <div className="min-h-0 flex-1">
                <MessageList
                    components={components}
                    hasMore={hasMoreMessages}
                    isStreaming={isStreaming}
                    messages={messages}
                    onBranchMessage={onBranchMessage}
                    onCopyMessage={onCopyMessage}
                    onLoadMore={onLoadMoreMessages}
                    onPinMessage={onPinMessage}
                    onRegenerateMessage={onRegenerateMessage}
                />
            </div>

            {/* ── Auto-continue status bar ─────────────────────────────── */}
            {autoContinueState?.active && <AutoContinueStatus onCancel={onCancelAutoContinue} state={autoContinueState} />}

            {/* ── Composer ────────────────────────────────────────────────── */}
            <div className="shrink-0 border-t border-gray-200 dark:border-gray-800">
                {composerSlot}
                <Composer
                    disabled={false}
                    draft={composerDraft}
                    isStreaming={isStreaming}
                    onAutoContinueChange={onAutoContinueChange}
                    onSend={onSendMessage}
                    placeholder={t`Message...`}
                    shouldAutoContinue={shouldAutoContinue}
                    showAutoContinue={showAutoContinue}
                />
            </div>
        </div>
    );
};

export default ChatView;
