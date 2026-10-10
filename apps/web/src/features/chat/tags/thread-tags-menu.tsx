import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { Settings2, Tag } from "lucide-react";
import type { FC } from "react";

import { showError } from "@/lib/toast";

import { THREAD_TAG_DOT_CLASSES } from "./thread-tag-colors";
import { useSetThreadTagAssigned, useThreadTags } from "./use-thread-tags";

interface ThreadTagsMenuProperties {
    onManageTags: () => void;
    tagIds: string[] | undefined;
    threadId: string;
    threadTitle: string;
}

/**
 * Menu body, mounted only while the menu is open — so the hundred-odd rows of
 * a long thread list do not each hold a query observer and a mutation.
 */
const ThreadTagsMenuItems: FC<Omit<ThreadTagsMenuProperties, "threadTitle">> = ({ onManageTags, tagIds, threadId }) => {
    const { t } = useLingui();
    const tags = useThreadTags() ?? [];
    const setThreadTagAssigned = useSetThreadTagAssigned();
    const assigned = new Set(tagIds);

    return (
        <>
            {tags.length === 0 ? (
                <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t`No tags yet`}</DropdownMenuLabel>
            ) : (
                tags.map((tag) => {
                    const isAssigned = assigned.has(tag._id);

                    return (
                        <DropdownMenuCheckboxItem
                            checked={isAssigned}
                            key={tag._id}
                            onClick={() => {
                                setThreadTagAssigned(threadId, tag._id, !isAssigned, tagIds).catch((error: unknown) => {
                                    showError(error instanceof Error ? error : t`Failed to update tags`);
                                });
                            }}
                        >
                            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", THREAD_TAG_DOT_CLASSES[tag.color])} />
                            <span className="truncate">{tag.name}</span>
                        </DropdownMenuCheckboxItem>
                    );
                })
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onManageTags}>
                <Settings2 aria-hidden="true" className="h-3 w-3" />
                {tags.length === 0 ? t`Create a tag…` : t`Manage tags…`}
            </DropdownMenuItem>
        </>
    );
};

/** Per-thread menu: assign or unassign the user's tags. */
const ThreadTagsMenu: FC<ThreadTagsMenuProperties> = ({ onManageTags, tagIds, threadId, threadTitle }) => {
    const { t } = useLingui();

    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <DropdownMenuTrigger
                            render={
                                <Button
                                    aria-label={t`Tags for ${threadTitle}`}
                                    className="hover:text-primary h-6 w-6 p-0"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                    }}
                                    size="icon-sm"
                                    variant="ghost"
                                >
                                    <Tag aria-hidden="true" className="h-3 w-3" />
                                </Button>
                            }
                        />
                    }
                />
                <TooltipContent>{t`Tags`}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
                className="w-52"
                onClick={(e) => {
                    e.stopPropagation();
                }}
            >
                <ThreadTagsMenuItems onManageTags={onManageTags} tagIds={tagIds} threadId={threadId} />
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default ThreadTagsMenu;
