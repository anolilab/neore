"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import { formatShortcutForDisplay } from "@neore/ui/utils/keyboard-shortcuts";
import { useNavigate } from "@tanstack/react-router";
import { FolderPlus, Search, SquarePen } from "lucide-react";
import type { FC } from "react";
import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import CreateGroupChatButton from "@/features/chat/group/create-group-chat-button";
import { useKeyboardShortcuts } from "@/features/layout/hooks/use-ui-state";

import SearchBar from "./search-bar";
import SectionBar from "./section-bar";
import { useThreadListUIStore } from "./stores/thread-list-ui-store";
import ThreadListFilterMenu from "./thread-list-filter-menu";

interface ThreadListDockProperties {
    isSearchLoading?: boolean;
}

/**
 * The bottom of the thread sidebar: the section bar over one raised row with the search field, the filter menu, "Add project" and
 * "New Thread". Passed to `AppSidebar` as its footer.
 */
const ThreadListDock: FC<ThreadListDockProperties> = memo(({ isSearchLoading = false }) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const { keyboardShortcuts } = useKeyboardShortcuts();
    const focusSearchShortcut = formatShortcutForDisplay(keyboardShortcuts.focusSearch);
    // Compact, and only while it fits beside the label: a long chord stays in the tooltip.
    const compactShortcut = focusSearchShortcut.replaceAll(" ", "");
    const shownShortcut = compactShortcut.length <= 8 ? compactShortcut : "";
    const [isGroupChatOpen, setIsGroupChatOpen] = useState(false);

    const { openAddProjectDialog, searchQuery, searchType, setSearchQuery, showSearch, toggleShowSearch } = useThreadListUIStore(
        useShallow((state) => {
            return {
                openAddProjectDialog: state.openAddProjectDialog,
                searchQuery: state.searchQuery,
                searchType: state.searchType,
                setSearchQuery: state.setSearchQuery,
                showSearch: state.showSearch,
                toggleShowSearch: state.toggleShowSearch,
            };
        }),
    );

    const isMessageSearch = searchType === "messages";
    const closedSearchLabel = isMessageSearch ? t`Search messages` : t`Search threads`;
    let closedSearchTooltip = closedSearchLabel;

    if (focusSearchShortcut) {
        closedSearchTooltip = isMessageSearch ? t`Search messages (${focusSearchShortcut})` : t`Search threads (${focusSearchShortcut})`;
    }

    const handleNewThread = () => {
        navigate({ search: {}, to: "/chat" });
    };

    return (
        <div className="flex w-full flex-col gap-2">
            <SectionBar />
            <TooltipProvider>
                <div className="surface-raised flex items-center gap-0.5 rounded-[14px] p-1">
                    {showSearch ? (
                        <SearchBar
                            isSearchLoading={isSearchLoading}
                            onClose={() => {
                                // A closed search filters nothing: the query goes too, or the section bar stays hidden behind it.
                                setSearchQuery("");
                                toggleShowSearch();
                            }}
                            onSearchQueryChange={setSearchQuery}
                            searchQuery={searchQuery}
                            searchType={searchType}
                        />
                    ) : (
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <button
                                        aria-expanded={false}
                                        aria-label={closedSearchLabel}
                                        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2.5 text-[13.5px] focus-visible:ring-2 focus-visible:outline-none"
                                        data-search-toggle=""
                                        onClick={toggleShowSearch}
                                        type="button"
                                    >
                                        <Search aria-hidden="true" className="size-4 shrink-0" />
                                        <span aria-hidden="true" className="truncate">
                                            {t`Search`}
                                        </span>
                                        {shownShortcut && (
                                            <kbd
                                                aria-hidden="true"
                                                className="surface-edge ml-auto shrink-0 rounded px-1.5 py-px font-mono text-[10px] font-medium whitespace-nowrap"
                                            >
                                                {shownShortcut}
                                            </kbd>
                                        )}
                                    </button>
                                }
                            />
                            <TooltipContent>{closedSearchTooltip}</TooltipContent>
                        </Tooltip>
                    )}
                    <ThreadListFilterMenu
                        onNewGroupChat={() => {
                            setIsGroupChatOpen(true);
                        }}
                    />
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    aria-label={t`Add project`}
                                    className="text-muted-foreground hover:text-foreground size-[30px] p-0"
                                    onClick={openAddProjectDialog}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <FolderPlus aria-hidden="true" className="size-4" />
                                </Button>
                            }
                        />
                        <TooltipContent>{t`Add project`}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    aria-label={t`New Thread`}
                                    className="text-foreground size-[30px] p-0"
                                    onClick={handleNewThread}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <SquarePen aria-hidden="true" className="size-4" />
                                </Button>
                            }
                        />
                        <TooltipContent>{t`New Thread`}</TooltipContent>
                    </Tooltip>
                </div>
            </TooltipProvider>
            <CreateGroupChatButton hideTrigger onOpenChange={setIsGroupChatOpen} open={isGroupChatOpen} />
        </div>
    );
});

export default ThreadListDock;
