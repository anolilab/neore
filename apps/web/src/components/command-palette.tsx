import { useLingui } from "@lingui/react/macro";
import {
    Command,
    CommandCollection,
    CommandDialog,
    CommandDialogPopup,
    CommandEmpty,
    CommandFooter,
    CommandGroup,
    CommandGroupLabel,
    CommandInput,
    CommandItem,
    CommandList,
    CommandPanel,
    CommandSeparator,
    CommandShortcut,
} from "@neore/ui/components/command";
import { Kbd, KbdGroup } from "@neore/ui/components/kbd";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import { formatShortcutForDisplay } from "@neore/ui/utils/keyboard-shortcuts";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
    Archive,
    ArchiveRestore,
    ArrowDownIcon,
    ArrowUpIcon,
    CornerDownLeftIcon,
    File,
    FileText,
    GitBranch,
    Hourglass,
    MessageSquare,
    Pin,
    PinOff,
    Settings,
    Trash2,
} from "lucide-react";
import type { FC } from "react";
import React from "react";
import { useHotkeys } from "react-hotkeys-hook";

import useAllThreadsData from "@/features/chat/core/hooks/use-all-threads-data";
import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import { useThreadManager } from "@/features/chat/core/hooks/use-thread-manager";
import { useCurrentThreadId, useThreadMetadata } from "@/features/chat/core/stores/thread-store-hooks";
import useThreadHandlers from "@/features/chat/thread-list/hooks/use-thread-handlers";
import convertShortcutToHotkeysHook from "@/features/keyboard/lib/shortcut-converter";
import { useKeyboardShortcuts } from "@/features/layout/hooks/use-ui-state";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

import { useCommandDialogActions, useCommandDialogState, useCommandDialogStore } from "./command-dialog-store";

("use client");

interface Item {
    icon?: React.ReactNode;
    isCurrent?: boolean;
    label: string;
    onClick?: () => void;
    shortcut?: string;
    status?: "active" | "archived";
    threadId?: string;
    value: string;
}

interface Group {
    items: Item[];
    value: string;
}

interface ThreadItem {
    id: string;
    isPinned?: boolean;
    status: "active" | "archived";
    title: string;
}

interface GlobalCommandPaletteContentProps {
    isMounted: boolean;
}

const GlobalCommandPaletteContent: FC<GlobalCommandPaletteContentProps> = ({ isMounted }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const navigate = useNavigate({ from: "/chat/$threadId" as "/chat/$threadId" | "/dashboard" });
    const { keyboardShortcuts } = useKeyboardShortcuts();
    const { isOpen } = useCommandDialogState();
    const { close, setOpen } = useCommandDialogActions();

    const currentThreadId = useCurrentThreadId();
    const threadMetadata = useThreadMetadata();
    const currentThreadModel = useCurrentModel();
    const { isAuthenticated, isLoading: isAuthLoading } = useLunoraAuth();

    const isAuthReady = isAuthenticated && !isAuthLoading;
    const shouldQuery = isOpen && isAuthReady;

    const allThreadsData = useAllThreadsData(shouldQuery);
    const { deleteBranch, switchToBranch } = useThreadManager(shouldQuery);
    const { data: pinnedThreads } = useQuery(crpc.chat.functions.getPinnedThreads.queryOptions(shouldQuery ? {} : skipToken));

    const setLoadingStates = () => {};
    const { handleCreateBranch, handlePinThread, handleUnpinThread, updateThread } = useThreadHandlers(setLoadingStates);

    const pinnedThreadIds = new Set(
        pinnedThreads
            ?.map((pin) =>
                typeof pin === "object" && pin !== null && "_id" in pin && typeof pin._id === "string" ? pin._id : (pin as { threadId?: string })?.threadId,
            )
            .filter((id): id is string => typeof id === "string") || [],
    );

    const allThreads: ThreadItem[] = ((): ThreadItem[] => {
        const threads: ThreadItem[] = [];
        const lunoraThreads = allThreadsData.lunora || [];

        for (const thread of lunoraThreads) {
            const threadId = typeof thread === "object" && thread !== null && "_id" in thread && typeof thread._id === "string" ? thread._id : undefined;

            if (!threadId) {
                continue;
            }

            if (threads.every((candidate) => candidate.id !== threadId)) {
                const metadata = threadMetadata.get(threadId);
                const threadStatus = (thread as { status?: "active" | "archived" })?.status;
                const threadTitle = (thread as { title?: string })?.title;

                threads.push({
                    id: threadId,
                    isPinned: pinnedThreadIds.has(threadId),
                    status: metadata?.status === "archived" || threadStatus === "archived" ? "archived" : "active",
                    title: metadata?.title || threadTitle || t`Untitled Thread`,
                });
            }
        }

        for (const [threadId, metadata] of threadMetadata.entries()) {
            if (threads.every((candidate) => candidate.id !== threadId)) {
                threads.push({
                    id: threadId,
                    isPinned: pinnedThreadIds.has(threadId),
                    status: metadata.status === "archived" ? "archived" : "active",
                    title: metadata.title || t`Untitled Thread`,
                });
            }
        }

        return threads;
    })();

    const handleNavigateToSettings = () => {
        navigate({
            search: (previous: Record<string, unknown>) => {
                return {
                    ...previous,
                    settings: true,
                    settingsTab: "app-customization",
                };
            },
        });
        close();
    };

    const handleNavigateToChat = () => {
        navigate({ search: {}, to: "/chat" });
        close();
    };

    const handleNavigateToPrompts = () => {
        navigate({ to: "/prompts" });
        close();
    };

    const handleNavigateToVault = () => {
        navigate({ to: "/vault" });
        close();
    };

    const handleSwitchThread = (threadId: string) => {
        if (!switchToBranch) {
            return;
        }

        switchToBranch(threadId);
        close();
    };

    const handleDeleteThread = async (threadId: string) => {
        if (threadId === "default" || !deleteBranch) {
            return;
        }

        try {
            await deleteBranch(threadId);
            close();
        } catch (error) {
            console.error("Failed to delete thread:", error);
        }
    };

    const handleNewTemporaryThread = () => {
        globalThis.dispatchEvent(new CustomEvent("newTemporaryChat"));
        close();
    };

    const handleCreateBranchAction = () => {
        if (!(currentThreadId && currentThreadId !== "default" && handleCreateBranch)) {
            return;
        }

        handleCreateBranch(currentThreadId);
        close();
    };

    const handlePinUnpinThread = () => {
        if (!currentThreadId || currentThreadId === "default") {
            return;
        }

        const currentThread = allThreads.find((candidate) => candidate.id === currentThreadId);

        if (currentThread?.isPinned && handleUnpinThread) {
            handleUnpinThread(currentThreadId);
        } else if (!currentThread?.isPinned && handlePinThread) {
            handlePinThread(currentThreadId);
        }

        close();
    };

    const handleDeleteCurrentThread = () => {
        if (!(currentThreadId && currentThreadId !== "default" && deleteBranch)) {
            return;
        }

        deleteBranch(currentThreadId);
        close();
    };

    const handleArchiveCurrentThread = () => {
        if (!currentThreadId || currentThreadId === "default") {
            return;
        }

        const currentThread = allThreads.find((candidate) => candidate.id === currentThreadId);

        if (currentThread && updateThread) {
            updateThread(currentThreadId, currentThreadModel, currentThread.status === "archived" ? "active" : "archived");
            close();
        }
    };

    const groupedItems = (() => {
        const groups: Group[] = [];

        const navigationItems: Item[] = [
            {
                icon: <MessageSquare className="size-4" />,
                label: t`Go to Chat`,
                onClick: handleNavigateToChat,
                value: "nav-chat",
            },
            {
                icon: <FileText className="size-4" />,
                label: t`Go to Prompts`,
                onClick: handleNavigateToPrompts,
                value: "nav-prompts",
            },
            {
                icon: <File className="size-4" />,
                label: t`Go to Vault`,
                onClick: handleNavigateToVault,
                value: "nav-vault",
            },
            {
                icon: <Settings className="size-4" />,
                label: t`Go to Settings`,
                onClick: handleNavigateToSettings,
                value: "nav-settings",
            },
        ];

        if (navigationItems.length > 0) {
            groups.push({ items: navigationItems, value: t`Navigation` });
        }

        const hasCurrentThread = Boolean(currentThreadId && typeof currentThreadId === "string" && currentThreadId !== "default" && currentThreadId.length > 0);
        const currentThread = hasCurrentThread ? allThreads.find((candidate) => candidate.id === currentThreadId) : undefined;

        const threadActions: Item[] = [
            {
                icon: <MessageSquare className="size-4" />,
                label: t`New thread`,
                onClick: handleNavigateToChat,
                shortcut: keyboardShortcuts.newChat || "ctrl+n",
                value: "action-new-thread",
            },
            {
                icon: <Hourglass className="size-4" />,
                label: t`New temporary thread`,
                onClick: handleNewTemporaryThread,
                shortcut: keyboardShortcuts.newTemporaryChat || "ctrl+shift+n",
                value: "action-new-temporary-thread",
            },
        ];

        if (hasCurrentThread && typeof deleteBranch === "function") {
            threadActions.push(
                {
                    icon: <GitBranch className="size-4" />,
                    label: t`Create branch`,
                    onClick: handleCreateBranchAction,
                    shortcut: keyboardShortcuts.createBranch,
                    value: "action-create-branch",
                },
                {
                    icon: currentThread?.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
                    label: currentThread?.isPinned ? t`Unpin thread` : t`Pin thread`,
                    onClick: handlePinUnpinThread,
                    shortcut: keyboardShortcuts.pinThread,
                    value: "action-pin-unpin-thread",
                },
                {
                    icon: <Archive className="size-4" />,
                    label: currentThread?.status === "archived" ? t`Unarchive thread` : t`Archive thread`,
                    onClick: handleArchiveCurrentThread,
                    shortcut: keyboardShortcuts.archiveThread,
                    value: "action-archive-thread",
                },
                {
                    icon: <Trash2 className="size-4" />,
                    label: t`Delete thread`,
                    onClick: handleDeleteCurrentThread,
                    shortcut: keyboardShortcuts.deleteThread,
                    value: "action-delete-thread",
                },
            );
        }

        groups.push({ items: threadActions, value: t`Thread Actions` });

        if (allThreads.length > 0) {
            const activeThreads = allThreads.filter((candidate) => candidate.status === "active");
            const archivedThreads = allThreads.filter((candidate) => candidate.status === "archived");

            if (activeThreads.length > 0) {
                groups.push({
                    items: activeThreads.map((thread) => {
                        return {
                            icon: <MessageSquare className="size-4" />,
                            isCurrent: currentThreadId === thread.id,
                            label: thread.title,
                            onClick: () => handleSwitchThread(thread.id),
                            status: "active" as const,
                            threadId: thread.id,
                            value: `thread-active-${thread.id}`,
                        };
                    }),
                    value: t`Active Threads`,
                });
            }

            if (archivedThreads.length > 0) {
                groups.push({
                    items: archivedThreads.map((thread) => {
                        return {
                            icon: <Archive className="size-4" />,
                            isCurrent: currentThreadId === thread.id,
                            label: thread.title,
                            onClick: () => handleSwitchThread(thread.id),
                            status: "archived" as const,
                            threadId: thread.id,
                            value: `thread-archived-${thread.id}`,
                        };
                    }),
                    value: t`Archived Threads`,
                });
            }
        }

        return groups;
    })();

    const handleCommandPaletteToggle = (event: KeyboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const store = useCommandDialogStore.getState();

        if (store.isOpen) {
            store.close();
        } else {
            store.openCommandPalette();
        }
    };

    useHotkeys(
        convertShortcutToHotkeysHook(keyboardShortcuts.commandPalette || "ctrl+k"),
        handleCommandPaletteToggle,
        {
            enabled: isMounted,
            enableOnContentEditable: true,
            enableOnFormTags: true,
            preventDefault: true,
        },
        [isMounted, keyboardShortcuts.commandPalette, handleCommandPaletteToggle],
    );

    return (
        <CommandDialog
            onOpenChange={(newOpen) => {
                setOpen(newOpen);
            }}
            open={isOpen}
        >
            <CommandDialogPopup>
                <Command items={groupedItems}>
                    <CommandInput placeholder={t`Search threads, navigate, or perform actions...`} />
                    <CommandPanel>
                        <CommandEmpty>{t`No results found.`}</CommandEmpty>
                        <CommandList>
                            {(group: Group, index: number) => (
                                <React.Fragment key={group.value}>
                                    <CommandGroup items={group.items}>
                                        <CommandGroupLabel>{group.value}</CommandGroupLabel>
                                        <CommandCollection>
                                            {(item: Item) => (
                                                <CommandItem key={item.value} onClick={item.onClick} value={item.value}>
                                                    {item.icon}
                                                    <span className="ml-2 flex-1">{item.label}</span>
                                                    {item.shortcut && <CommandShortcut>{formatShortcutForDisplay(item.shortcut)}</CommandShortcut>}
                                                    {item.isCurrent && <CommandShortcut>{t`Current`}</CommandShortcut>}
                                                    {item.threadId && (
                                                        <div className="ml-auto flex gap-1">
                                                            <button
                                                                aria-label={item.status === "archived" ? t`Unarchive thread` : t`Archive thread`}
                                                                className="hover:bg-muted rounded p-1"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();

                                                                    if (updateThread) {
                                                                        updateThread(
                                                                            item.threadId!,
                                                                            currentThreadModel,
                                                                            item.status === "archived" ? "active" : "archived",
                                                                        );
                                                                        close();
                                                                    }
                                                                }}
                                                                type="button"
                                                            >
                                                                {item.status === "archived" ? (
                                                                    <ArchiveRestore className="size-3" />
                                                                ) : (
                                                                    <Archive className="size-3" />
                                                                )}
                                                            </button>
                                                            {item.threadId !== "default" && (
                                                                <button
                                                                    aria-label={t`Delete thread`}
                                                                    className="hover:bg-muted rounded p-1"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        handleDeleteThread(item.threadId!);
                                                                    }}
                                                                    type="button"
                                                                >
                                                                    <Trash2 className="size-3" />
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                </CommandItem>
                                            )}
                                        </CommandCollection>
                                    </CommandGroup>
                                    {index < groupedItems.length - 1 && <CommandSeparator />}
                                </React.Fragment>
                            )}
                        </CommandList>
                    </CommandPanel>
                    <CommandFooter>
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2">
                                <KbdGroup>
                                    <Kbd>
                                        <ArrowUpIcon />
                                    </Kbd>
                                    <Kbd>
                                        <ArrowDownIcon />
                                    </Kbd>
                                </KbdGroup>
                                <span>{t`Navigate`}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Kbd>
                                    <CornerDownLeftIcon />
                                </Kbd>
                                <span>{t`Open`}</span>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <KbdGroup>
                                <Kbd>⌘</Kbd>
                                <Kbd>K</Kbd>
                            </KbdGroup>
                            <span>{t`Close`}</span>
                        </div>
                    </CommandFooter>
                </Command>
            </CommandDialogPopup>
        </CommandDialog>
    );
};

const GlobalCommandPalette = () => {
    const isMounted = useIsHydrated();

    if (!isMounted) {
        return null;
    }

    return <GlobalCommandPaletteContent isMounted={isMounted} />;
};

export default GlobalCommandPalette;
