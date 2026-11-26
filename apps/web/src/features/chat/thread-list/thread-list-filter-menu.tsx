import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { Keyboard, ListChecks, ListFilter, Settings2, Tag, Users, X } from "lucide-react";
import type { FC } from "react";
import { useShallow } from "zustand/react/shallow";

import { THREAD_CATEGORY_LABELS } from "@/features/chat/tags/thread-categories";
import { THREAD_TAG_DOT_CLASSES } from "@/features/chat/tags/thread-tag-colors";
import { pruneSelectedTagIds, toggleSelectedTagId } from "@/features/chat/tags/thread-tag-logic";
import { useThreadTags } from "@/features/chat/tags/use-thread-tags";

import { useThreadListUIStore } from "./stores/thread-list-ui-store";

const ALL_CATEGORIES = "all";
const CATEGORY_IDS = Object.keys(THREAD_CATEGORY_LABELS);

const isSearchType = (value: unknown): value is "threads" | "messages" => value === "threads" || value === "messages";

interface ThreadListFilterMenuProperties {
    /** Opens the "New group chat" dialog. The dialog lives outside this menu, which unmounts its content on close. */
    onNewGroupChat: () => void;
}

/** The dock's filter menu: what to search in, the category and tag filters, and the list-wide actions. */
const ThreadListFilterMenu: FC<ThreadListFilterMenuProperties> = ({ onNewGroupChat }) => {
    const { i18n, t } = useLingui();
    const tags = useThreadTags() ?? [];
    const {
        enterSelectionMode,
        searchType,
        selectedCategory,
        selectedTagIds: rawSelectedTagIds,
        setSearchType,
        setSelectedCategory,
        setSelectedTagIds,
        setShowManageTagsDialog,
        toggleShowKeyboardHelp,
    } = useThreadListUIStore(
        useShallow((state) => {
            return {
                enterSelectionMode: state.enterSelectionMode,
                searchType: state.searchType,
                selectedCategory: state.selectedCategory,
                selectedTagIds: state.selectedTagIds,
                setSearchType: state.setSearchType,
                setSelectedCategory: state.setSelectedCategory,
                setSelectedTagIds: state.setSelectedTagIds,
                setShowManageTagsDialog: state.setShowManageTagsDialog,
                toggleShowKeyboardHelp: state.toggleShowKeyboardHelp,
            };
        }),
    );
    const activeTagIds = pruneSelectedTagIds(rawSelectedTagIds, tags);
    const isFiltered = selectedCategory !== undefined || activeTagIds.length > 0;

    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <DropdownMenuTrigger
                            render={
                                <Button
                                    aria-label={t`Search filters`}
                                    className="text-muted-foreground hover:text-foreground relative size-[30px] p-0"
                                    size="sm"
                                    variant="ghost"
                                >
                                    <ListFilter aria-hidden="true" className="size-4" />
                                    {isFiltered && <span aria-hidden="true" className="bg-primary absolute top-1 right-1 size-1.5 rounded-full" />}
                                </Button>
                            }
                        />
                    }
                />
                <TooltipContent>{t`Search filters`}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-64" side="top" sideOffset={8}>
                <DropdownMenuGroup>
                    <DropdownMenuLabel>{t`Search in`}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                        onValueChange={(value) => {
                            if (isSearchType(value)) {
                                setSearchType(value);
                            }
                        }}
                        value={searchType}
                    >
                        <DropdownMenuRadioItem value="threads">{t`Threads`}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="messages">{t`Messages`}</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{t`Category`}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-48">
                        <DropdownMenuRadioGroup
                            onValueChange={(value) => {
                                setSelectedCategory(value === ALL_CATEGORIES ? undefined : value);
                            }}
                            value={selectedCategory ?? ALL_CATEGORIES}
                        >
                            <DropdownMenuRadioItem value={ALL_CATEGORIES}>{t`All`}</DropdownMenuRadioItem>
                            {CATEGORY_IDS.map((id) => {
                                const label = THREAD_CATEGORY_LABELS[id];

                                return (
                                    <DropdownMenuRadioItem key={id} value={id}>
                                        {label ? i18n._(label) : id}
                                    </DropdownMenuRadioItem>
                                );
                            })}
                        </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                    {/* Named by its visible text (WCAG 2.5.3); the count of chosen tags follows it. */}
                    <DropdownMenuSubTrigger>
                        <Tag aria-hidden="true" />
                        {t`Tags`}
                        {activeTagIds.length > 0 && <span className="text-muted-foreground ms-auto tabular-nums">{activeTagIds.length}</span>}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-52">
                        {tags.length === 0 ? (
                            <DropdownMenuGroup>
                                <DropdownMenuLabel className="font-normal">{t`No tags yet`}</DropdownMenuLabel>
                            </DropdownMenuGroup>
                        ) : (
                            tags.map((tag) => (
                                <DropdownMenuCheckboxItem
                                    checked={activeTagIds.includes(tag._id)}
                                    key={tag._id}
                                    onClick={() => {
                                        setSelectedTagIds(toggleSelectedTagId(activeTagIds, tag._id));
                                    }}
                                >
                                    <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", THREAD_TAG_DOT_CLASSES[tag.color])} />
                                    <span className="truncate">{tag.name}</span>
                                </DropdownMenuCheckboxItem>
                            ))
                        )}
                        <DropdownMenuSeparator />
                        {activeTagIds.length > 0 && (
                            <DropdownMenuItem
                                onClick={() => {
                                    setSelectedTagIds([]);
                                }}
                            >
                                <X aria-hidden="true" />
                                {t`Clear tag filter`}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                            onClick={() => {
                                setShowManageTagsDialog(true);
                            }}
                        >
                            <Settings2 aria-hidden="true" />
                            {t`Manage tags…`}
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onNewGroupChat}>
                    <Users aria-hidden="true" />
                    {t`New group chat`}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={enterSelectionMode}>
                    <ListChecks aria-hidden="true" />
                    {t`Select multiple threads`}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleShowKeyboardHelp}>
                    <Keyboard aria-hidden="true" />
                    {t`Keyboard shortcuts`}
                    <DropdownMenuShortcut>?</DropdownMenuShortcut>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default ThreadListFilterMenu;
