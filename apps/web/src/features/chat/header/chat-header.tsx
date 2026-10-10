"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { InlineEdit } from "@neore/ui/components/inline-edit";
import { SidebarTrigger } from "@neore/ui/components/sidebar";
import ModeToggle from "@neore/ui/components/theme-toggle";
import { PanelRightIcon, RefreshCw } from "lucide-react";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";

import AnonymousUserBanner from "@/features/auth/components/anonymous/anonymous-user-banner";
import { useUpdateThread } from "@/features/chat/core/hooks/use-threads";
import { useValidatedThread } from "@/features/chat/core/hooks/use-validated-thread";
import { useThreadActions, useThreadMetadata } from "@/features/chat/core/stores/thread-store-hooks";
import GroupParticipantBar from "@/features/chat/group/group-participant-bar";
import ThreadShareButton from "@/features/chat/sharing/thread-share-button";
import SiteHeader from "@/features/layout/components/site-header";

import KBAttachmentButton from "./kb-attachment-button";
import TemporaryChatDropdown from "./temporary-chat-dropdown";
import ThreadDownloadButton from "./thread-download-button";

const ChatSiteHeader: FC<{ threadId?: string }> = ({ threadId }) => {
    const { t } = useLingui();
    const { actualThreadId, isValid, threadData, validThreadId } = useValidatedThread(threadId);

    // Use database query as source of truth
    const title = threadData?.title ?? t`New Chat`;
    const statelessMode = (threadData as { statelessMode?: boolean } | undefined)?.statelessMode;

    // For thread title editing
    const updateThread = useUpdateThread();
    const threadMetadata = useThreadMetadata();
    const { setThreadMetadata } = useThreadActions();
    const model = threadData?.model;
    const metadataTitle = isValid ? threadMetadata.get(actualThreadId ?? "")?.title : undefined;
    const currentTitle = metadataTitle || threadData?.title || title;
    const lastSavedTitleRef = useRef<string | null>(null);
    const [localTitle, setLocalTitle] = useState(currentTitle);

    // Sync with database changes
    useEffect(() => {
        if (!isValid) {
            return;
        }

        if (lastSavedTitleRef.current && currentTitle === lastSavedTitleRef.current) {
            lastSavedTitleRef.current = null;
        }

        if (currentTitle !== localTitle && lastSavedTitleRef.current !== localTitle) {
            setLocalTitle(currentTitle);
        }
    }, [currentTitle, localTitle, isValid]);

    const handleSave = async (newTitle: string) => {
        if (!validThreadId || !model) {
            return;
        }

        const trimmedTitle = newTitle.trim();

        if (!trimmedTitle) {
            return;
        }

        if (trimmedTitle === currentTitle) {
            return;
        }

        // Update threadMetadata optimistically
        setThreadMetadata((previous) => {
            const current = previous.get(actualThreadId ?? "") || {
                createdAt: new Date(),
                lastActivity: new Date(),
                status: "active" as const,
                title: currentTitle,
            };

            return new Map(previous).set(actualThreadId ?? "", {
                ...current,
                lastActivity: new Date(),
                title: trimmedTitle,
            });
        });

        setLocalTitle(trimmedTitle);

        try {
            await updateThread({
                model,
                threadId: validThreadId,
                title: trimmedTitle,
            });
            lastSavedTitleRef.current = trimmedTitle;
        } catch (error) {
            console.error("Failed to update thread title:", error);
            // Revert optimistic update on error
            setThreadMetadata((previous) => {
                const current = previous.get(actualThreadId ?? "");

                if (!current) {
                    return previous;
                }

                return new Map(previous).set(actualThreadId ?? "", {
                    ...current,
                    title: currentTitle,
                });
            });
            setLocalTitle(currentTitle);
            lastSavedTitleRef.current = null;
        }
    };

    return (
        <SiteHeader
            anonymousUserBanner={<AnonymousUserBanner />}
            menu={
                <>
                    <KBAttachmentButton threadId={actualThreadId} />
                    <ThreadDownloadButton model={model} threadId={actualThreadId} />
                    <ThreadShareButton threadId={actualThreadId} />
                    <SidebarTrigger className="text-foreground dark:text-white" icon={<PanelRightIcon />} name="right" />
                </>
            }
            themeToggle={
                <>
                    <TemporaryChatDropdown className="text-foreground" threadId={actualThreadId} />
                    <ModeToggle className="text-foreground" />
                </>
            }
            trigger={<SidebarTrigger className="ml-2" name="left" />}
        >
            <div className="flex items-center gap-2">
                <InlineEdit
                    className="border-none px-0 py-0 text-lg font-bold hover:bg-transparent"
                    defaultValue={isValid ? undefined : title}
                    disabled={isValid ? !model : false}
                    onSave={isValid && model ? handleSave : undefined}
                    renderInput={(props) => (
                        <input
                            {...props}
                            className="focus-visible:ring-ring/50 h-7 min-w-[200px] border-none bg-transparent py-0 text-lg leading-tight font-bold shadow-none focus:outline-none focus-visible:ring-1"
                        />
                    )}
                    value={isValid ? localTitle : undefined}
                />
                {statelessMode && (
                    <Badge className="gap-1" variant="secondary">
                        <RefreshCw className="size-3" />
                        <Trans>Stateless</Trans>
                    </Badge>
                )}
                <GroupParticipantBar isRunning={threadData?.status === "running"} threadId={validThreadId} />
            </div>
        </SiteHeader>
    );
};

export default ChatSiteHeader;
