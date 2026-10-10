"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import { useNavigate } from "@tanstack/react-router";
import { FolderPlus, HelpCircle, MoreVertical, PlusIcon, Search } from "lucide-react";
import type { FC } from "react";
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";

import OrganizationSwitcher from "@/features/auth/components/organization/organization-switcher";
import TeamSwitcher from "@/features/auth/components/team/team-switcher";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import CreateGroupChatButton from "@/features/chat/group/create-group-chat-button";

import SearchBar from "./search-bar";
import { useThreadListUIStore } from "./stores/thread-list-ui-store";

interface ThreadListHeaderProps {
    isSearchLoading?: boolean;
}

const ThreadListHeader: FC<ThreadListHeaderProps> = memo(({ isSearchLoading = false }) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const { hooks } = useAuth();

    const { data: organizations } = hooks.useListOrganizations();
    const { data: activeOrganization } = hooks.useActiveOrganization();
    const hasMultipleOrganizations = organizations && organizations.length > 1;
    const hasActiveOrganization = !!activeOrganization;

    const {
        enterSelectionMode,
        openCreateProjectDialog,
        searchQuery,
        searchType,
        selectedCategory,
        setSearchQuery,
        setSearchType,
        setSelectedCategory,
        showSearch,
        toggleShowKeyboardHelp,
        toggleShowSearch,
    } = useThreadListUIStore(
        useShallow((state) => {
            return {
                enterSelectionMode: state.enterSelectionMode,
                openCreateProjectDialog: state.openCreateProjectDialog,
                searchQuery: state.searchQuery,
                searchType: state.searchType,
                selectedCategory: state.selectedCategory,
                setSearchQuery: state.setSearchQuery,
                setSearchType: state.setSearchType,
                setSelectedCategory: state.setSelectedCategory,
                showSearch: state.showSearch,
                toggleShowKeyboardHelp: state.toggleShowKeyboardHelp,
                toggleShowSearch: state.toggleShowSearch,
            };
        }),
    );

    const handleNewThread = () => {
        navigate({ search: {}, to: "/chat" });
    };

    return (
        <div className="text-brand-black dark:text-brand-white flex flex-col items-stretch gap-1.5 pl-2">
            <div className="flex w-full flex-col items-center gap-2">
                {hasMultipleOrganizations && (
                    <OrganizationSwitcher className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active]:bg-sidebar-accent data-[active]:text-sidebar-accent-foreground w-full justify-start rounded-lg" />
                )}
                {hasActiveOrganization && (
                    <TeamSwitcher
                        className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active]:bg-sidebar-accent data-[active]:text-sidebar-accent-foreground w-full justify-start rounded-lg"
                        variant="ghost"
                    />
                )}
                <Button
                    className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active]:bg-sidebar-accent data-[active]:text-sidebar-accent-foreground flex grow items-center justify-start gap-1.5 rounded-lg px-2.5 py-2 text-start"
                    onClick={handleNewThread}
                    variant="ghost"
                >
                    <PlusIcon className="size-5" />
                    {t`New Thread`}
                </Button>
                <div className="flex flex-row items-center gap-2">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button
                                        className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-9 w-9 p-0"
                                        onClick={toggleShowSearch}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        <Search className="h-5 w-5" />
                                    </Button>
                                }
                            />
                            <TooltipContent>{t`Search threads (Ctrl+F)`}</TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button
                                        className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-9 w-9 p-0"
                                        onClick={openCreateProjectDialog}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        <FolderPlus className="h-5 w-5" />
                                    </Button>
                                }
                            />
                            <TooltipContent>{t`Create project`}</TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                    <CreateGroupChatButton className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-9 w-9 p-0" />
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button
                                        className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-9 w-9 p-0"
                                        onClick={toggleShowKeyboardHelp}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        <HelpCircle className="h-5 w-5" />
                                    </Button>
                                }
                            />
                            <TooltipContent>{t`Keyboard shortcuts (?)`}</TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                    <DropdownMenu>
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <DropdownMenuTrigger
                                            render={
                                                <Button
                                                    className="text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-9 w-9 p-0"
                                                    size="sm"
                                                    variant="ghost"
                                                >
                                                    <MoreVertical className="h-5 w-5" />
                                                </Button>
                                            }
                                        />
                                    }
                                />
                                <TooltipContent>{t`Bulk actions`}</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <DropdownMenuContent>
                            <DropdownMenuItem onClick={enterSelectionMode}>{t`Select multiple threads`}</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
            {showSearch && (
                <SearchBar
                    isSearchLoading={isSearchLoading}
                    onSearchQueryChange={setSearchQuery}
                    onSearchTypeChange={setSearchType}
                    onSelectedCategoryChange={setSelectedCategory}
                    searchQuery={searchQuery}
                    searchType={searchType}
                    selectedCategory={selectedCategory}
                />
            )}
        </div>
    );
});

export default ThreadListHeader;
