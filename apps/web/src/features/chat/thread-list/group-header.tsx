import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import {
    AlarmClock,
    Archive,
    Calendar,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    Folder,
    GripVertical,
    Hammer,
    Hourglass,
    Loader2,
    MoreVertical,
    Pin,
} from "lucide-react";
import type { FC } from "react";

import ProjectIcon from "./project-icon";
import type { GroupType, ThreadGroup } from "./types";
import { getGroupType, isGroupFullySelected } from "./utilities";

interface GroupHeaderProperties {
    dragListeners?: any;
    group: ThreadGroup;
    groupThreadIds: string[];
    isCollapsed: boolean;
    isReordering?: boolean;
    isSelectionMode: boolean;
    onDeleteProject?: (projectId: string) => void;
    onEditProject?: (projectId: string) => void;
    onPinProject?: (projectId: string, isPinned: boolean) => void;
    onToggleCollapse: () => void;
    onToggleSelection: (e: React.MouseEvent) => void;
    projectPinnedAt?: number | null;
    selectedThreadIds: Set<string>;
}

/** The small icon in front of a derived or dated group's label. Project groups show their own tile instead. */
const GROUP_ICONS: Partial<Record<GroupType, FC<{ "aria-hidden"?: boolean; className?: string }>>> = {
    archived: Archive,
    last7days: Calendar,
    lastMonth: Calendar,
    needsYou: CircleAlert,
    older: Calendar,
    pinned: Pin,
    snoozed: AlarmClock,
    temporary: Hourglass,
    today: Calendar,
    working: Hammer,
};

const GroupHeader: FC<GroupHeaderProperties> = ({
    dragListeners,
    group,
    groupThreadIds,
    isCollapsed,
    isReordering,
    isSelectionMode,
    onDeleteProject,
    onEditProject,
    onPinProject,
    onToggleCollapse,
    onToggleSelection,
    projectPinnedAt,
    selectedThreadIds,
}) => {
    const { t } = useLingui();
    const groupType = getGroupType(group);
    const isAllSelected = isGroupFullySelected(groupThreadIds, selectedThreadIds);
    const isProjectGroup = groupType === "project" && group.projectId;
    const isPinned = !!projectPinnedAt;

    const needsAttention = groupType === "needsYou";
    const GroupIcon = GROUP_ICONS[groupType];

    const renderLeading = () => {
        if (group.projectId) {
            // An 18 px tile holds the project's icon, in the project's colour.
            return (
                <span aria-hidden="true" className="bg-surface-well flex size-[18px] shrink-0 items-center justify-center rounded-[5px]">
                    {group.projectIcon ? <ProjectIcon color={group.projectColor || "#6b7280"} name={group.projectIcon} /> : <Folder className="size-3" />}
                </span>
            );
        }

        return GroupIcon ? <GroupIcon aria-hidden className="size-3.5 shrink-0" /> : null;
    };

    return (
        <div
            className={cn(
                "group/action-item hover:text-foreground flex items-center gap-2 px-2 pt-3 pb-1 font-mono text-xs font-medium",
                needsAttention ? "text-attention hover:text-attention" : "text-muted-foreground",
            )}
        >
            {isSelectionMode && (
                <Checkbox
                    checked={isAllSelected}
                    className="border-sidebar-border data-checked:border-sidebar-foreground data-checked:bg-sidebar-foreground"
                    onClick={onToggleSelection}
                />
            )}
            {/* Drag handle for project groups - always visible for easier dragging */}
            {isProjectGroup && dragListeners && !isSelectionMode && !isReordering && (
                <div
                    className="drag-handle flex items-center"
                    {...dragListeners}
                    onClick={(e) => {
                        // Prevent click from bubbling to parent (collapse toggle)
                        e.stopPropagation();
                    }}
                    // Pointer-only affordance: it is not focusable, so it carries no
                    // keyboard path and should not appear in the accessibility tree.
                    role="presentation"
                    style={{ cursor: "grab", touchAction: "none" }}
                >
                    <GripVertical className="text-muted-foreground h-3 w-3 cursor-grab active:cursor-grabbing" />
                </div>
            )}
            {/* Loading indicator for reordering */}
            {isReordering && <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />}
            <button
                aria-expanded={!isCollapsed}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                onClick={onToggleCollapse}
                type="button"
            >
                {isCollapsed ? <ChevronRight aria-hidden className="size-3 shrink-0" /> : <ChevronDown aria-hidden className="size-3 shrink-0" />}
                {renderLeading()}
                <span className="truncate">{group.title}</span>
                {isPinned && isProjectGroup && (
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger render={<Pin className="size-3 shrink-0 fill-current" />} />
                            <TooltipContent>{t`Pinned project`}</TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )}
                {/* The hidden comma and the space (a flex row draws no gap for it) keep the name "Pinned, 1", not "Pinned1". */}
                <span className="sr-only">,</span> <span className="ml-auto tabular-nums">{group.threads.length}</span>
            </button>
            {isProjectGroup && group.projectId && (
                <div className="ml-auto">
                    <DropdownMenu>
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <DropdownMenuTrigger
                                            render={
                                                <Button
                                                    aria-label={t`Actions for project ${group.title}`}
                                                    className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0 p-0"
                                                    variant="ghost"
                                                >
                                                    <MoreVertical aria-hidden="true" className="size-3" />
                                                </Button>
                                            }
                                        />
                                    }
                                />
                                <TooltipContent>{t`Project actions`}</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <DropdownMenuContent align="end">
                            {onPinProject && (
                                <DropdownMenuItem onClick={() => group.projectId && onPinProject(group.projectId, isPinned)}>
                                    {isPinned ? t`Unpin` : t`Pin`}
                                </DropdownMenuItem>
                            )}
                            {onEditProject && <DropdownMenuItem onClick={() => group.projectId && onEditProject(group.projectId)}>{t`Edit`}</DropdownMenuItem>}
                            {onDeleteProject && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="text-destructive" onClick={() => group.projectId && onDeleteProject(group.projectId)}>
                                        {t`Delete`}
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
        </div>
    );
};

export default GroupHeader;
