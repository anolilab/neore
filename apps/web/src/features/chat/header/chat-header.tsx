"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { InlineEdit } from "@neore/ui/components/inline-edit";
import { SidebarTrigger } from "@neore/ui/components/sidebar";
import ModeToggle from "@neore/ui/components/theme-toggle";
import { PanelRightIcon, RefreshCw } from "lucide-react";
import type { FC } from "react";

import AnonymousUserBanner from "@/features/auth/components/anonymous/anonymous-user-banner";
import { useUpdateThread } from "@/features/chat/core/hooks/use-threads";
import { useValidatedThread } from "@/features/chat/core/hooks/use-validated-thread";
import { beginTitleSave, queueTitleWrite, settleTitleSave, titleOnScreen, useTitleSaveRevision } from "@/features/chat/core/lib/thread-title-saves";
import { useThreadActions } from "@/features/chat/core/stores/thread-store-hooks";
import GroupParticipantBar from "@/features/chat/group/group-participant-bar";
import ThreadImagesButton from "@/features/chat/image-gallery/thread-images-button";
import ThreadShareButton from "@/features/chat/sharing/thread-share-button";
import ThreadPullRequests from "@/features/develop/components/thread-pull-requests";
import SiteHeader from "@/features/layout/components/site-header";

import KBAttachmentButton from "./kb-attachment-button";
import TemporaryChatDropdown from "./temporary-chat-dropdown";
import ThemeRow from "./theme-row";
import ThreadDownloadButton from "./thread-download-button";

/**
 * The page header of a chat that is locked and not unlocked yet: the sidebar toggles stay, but the title (content) and every
 * action on the chat's data are left out, and it reads nothing about the chat.
 */
export const LockedChatSiteHeader: FC = () => {
    const { t } = useLingui();

    return (
        <SiteHeader
            menu={<SidebarTrigger className="text-muted-foreground hover:text-foreground" icon={<PanelRightIcon />} name="right" />}
            themeToggle={<ModeToggle className="text-muted-foreground hover:text-foreground" />}
            trigger={<SidebarTrigger className="ml-2" name="left" />}
            workspaceSwitch
        >
            <h1 className="text-sm font-medium">{t`Locked chat`}</h1>
        </SiteHeader>
    );
};

const ChatSiteHeader: FC<{ threadId?: string }> = ({ threadId }) => {
    const { t } = useLingui();
    const { actualThreadId, isValid, threadData, validThreadId } = useValidatedThread(threadId);

    // Use database query as source of truth
    const title = threadData?.title ?? t`New Chat`;
    const statelessMode = (threadData as { statelessMode?: boolean } | undefined)?.statelessMode;

    // For thread title editing
    const updateThread = useUpdateThread();

    // Re-rendered on every save that begins or settles, with or without a metadata entry; the title is read from the coordinator below.
    useTitleSaveRevision();
    const { setThreadMetadata } = useThreadActions();
    const model = threadData?.model;
    // Shown as it is: no copy of its own, so a rename from the list is what the header renders next time.
    const currentTitle = (isValid ? titleOnScreen(actualThreadId ?? "", threadData?.title) : threadData?.title) || title;

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

        const metadataKey = actualThreadId ?? "";
        // Numbered with the list's rename saves, so a later save of either writer decides what the header and the list show.
        const order = beginTitleSave(metadataKey, trimmedTitle, currentTitle, true);

        // Shows a settled save's title in the metadata, when the thread has one; the header creates no entry of its own here.
        const showTitle = (shown: string | undefined) => {
            if (shown === undefined) {
                return;
            }

            setThreadMetadata((previous) => {
                const current = previous.get(metadataKey);

                if (!current) {
                    return previous;
                }

                return new Map(previous).set(metadataKey, { ...current, lastActivity: new Date(), title: shown });
            });
        };

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

        try {
            await queueTitleWrite(metadataKey, () =>
                updateThread({
                    model,
                    threadId: validThreadId,
                    title: trimmedTitle,
                }),
            );
            // A newer save of either writer may be the one to show: the module says which title stands.
            showTitle(settleTitleSave(metadataKey, order, "saved"));
        } catch (error) {
            console.error("Failed to update thread title:", error);
            // Rolls back only this save: a newer one that already succeeded (a list rename, say) keeps its title.
            const shown = settleTitleSave(metadataKey, order, "failed");

            showTitle(shown);
        }
    };

    return (
        <SiteHeader
            anonymousUserBanner={<AnonymousUserBanner />}
            menu={
                <>
                    {/* In the header, never the overflow menu: its hourglass is the warning that a chat is auto-deleted, and one place
                        for it means changing the mode never moves the control the user is working. */}
                    <TemporaryChatDropdown threadId={actualThreadId} />
                    <ThreadShareButton threadId={actualThreadId} />
                    <SidebarTrigger className="text-muted-foreground hover:text-foreground" icon={<PanelRightIcon />} name="right" />
                </>
            }
            overflow={
                <>
                    <ThreadImagesButton label={t`Images in this chat`} threadId={actualThreadId} />
                    <KBAttachmentButton label={t`Knowledge base`} threadId={actualThreadId} />
                    <ThreadDownloadButton label={t`Chat actions`} model={model} threadId={actualThreadId} />
                    <ThemeRow />
                </>
            }
            trigger={<SidebarTrigger className="ml-2" name="left" />}
            workspaceSwitch
        >
            <div className="flex items-center gap-2">
                <InlineEdit
                    className="border-none px-0 py-0 text-sm font-medium hover:bg-transparent"
                    defaultValue={isValid ? undefined : title}
                    disabled={isValid ? !model : false}
                    onSave={isValid && model ? handleSave : undefined}
                    renderInput={(props) => (
                        <input
                            {...props}
                            className="focus-visible:ring-ring/50 h-7 min-w-[200px] border-none bg-transparent py-0 text-sm leading-tight font-medium shadow-none focus:outline-none focus-visible:ring-1"
                        />
                    )}
                    // The title is prose: the desktop shell turns spellcheck off page-wide.
                    spellCheck
                    value={isValid ? currentTitle : undefined}
                />
                {statelessMode && (
                    <Badge className="gap-1" variant="secondary">
                        <RefreshCw className="size-3" />
                        <Trans>Stateless</Trans>
                    </Badge>
                )}
                <GroupParticipantBar isRunning={threadData?.status === "running"} threadId={validThreadId} />
                {/* A chat that runs code on a computer (`runner: "host"`) can link a pull request; any other chat only shows the ones already linked. */}
                <ThreadPullRequests compact key={validThreadId} showLinkButton={threadData?.runner === "host"} threadId={validThreadId} />
            </div>
        </SiteHeader>
    );
};

export default ChatSiteHeader;
