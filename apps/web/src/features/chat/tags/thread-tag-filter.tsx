import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
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
import cn from "@neore/ui/utils/cn";
import { ChevronDown, Settings2, Tag, X } from "lucide-react";
import type { FC } from "react";

import { THREAD_TAG_DOT_CLASSES } from "./thread-tag-colors";
import { pruneSelectedTagIds, toggleSelectedTagId } from "./thread-tag-logic";
import { useThreadTags } from "./use-thread-tags";

interface ThreadTagFilterProperties {
    onManageTags: () => void;
    onSelectedTagIdsChange: (tagIds: ReadonlyArray<string>) => void;
    selectedTagIds: ReadonlyArray<string>;
}

/** Multi-select tag filter for the thread list; combines with the category filter. */
const ThreadTagFilter: FC<ThreadTagFilterProperties> = ({ onManageTags, onSelectedTagIdsChange, selectedTagIds }) => {
    const { t } = useLingui();
    const tags = useThreadTags() ?? [];
    const activeIds = pruneSelectedTagIds(selectedTagIds, tags);
    const activeCount = activeIds.length;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        aria-label={activeCount > 0 ? t`Filter by tag (${activeCount} selected)` : t`Filter by tag`}
                        className="flex items-center gap-1 border-white/20 text-xs text-white hover:bg-white/10 data-[active]:bg-white/20"
                        size="sm"
                        variant="outline"
                    >
                        <Tag aria-hidden="true" className="h-3 w-3" />
                        {activeCount > 0 ? (
                            <Badge className="text-xs" variant="secondary">
                                {activeCount}
                            </Badge>
                        ) : (
                            t`Tags`
                        )}
                        <ChevronDown aria-hidden="true" className="h-3 w-3" />
                    </Button>
                }
            />
            <DropdownMenuContent className="w-52">
                {tags.length === 0 ? (
                    <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t`No tags yet`}</DropdownMenuLabel>
                ) : (
                    tags.map((tag) => (
                        <DropdownMenuCheckboxItem
                            checked={activeIds.includes(tag._id)}
                            key={tag._id}
                            onClick={() => {
                                onSelectedTagIdsChange(toggleSelectedTagId(activeIds, tag._id));
                            }}
                        >
                            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", THREAD_TAG_DOT_CLASSES[tag.color])} />
                            <span className="truncate">{tag.name}</span>
                        </DropdownMenuCheckboxItem>
                    ))
                )}
                <DropdownMenuSeparator />
                {activeCount > 0 && (
                    <DropdownMenuItem
                        onClick={() => {
                            onSelectedTagIdsChange([]);
                        }}
                    >
                        <X aria-hidden="true" className="h-3 w-3" />
                        {t`Clear tag filter`}
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onManageTags}>
                    <Settings2 aria-hidden="true" className="h-3 w-3" />
                    {t`Manage tags…`}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default ThreadTagFilter;
