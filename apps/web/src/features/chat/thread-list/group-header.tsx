import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import { ChevronDown, ChevronRight, Folder, GripVertical, Loader2, MoreVertical, Pin } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense } from "react";

import IconPlaceholder from "./icon-placeholder";
import type { ThreadGroup } from "./types";
import { getGroupType, isGroupFullySelected } from "./utilities";

const ProjectIcon = lazy(() => import("./project-icon"));

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

    const renderProjectIcon = () => {
        if (!group.projectId) {
            return null;
        }

        if (!group.projectIcon) {
            return <Folder className="size-3" />;
        }

        return (
            <Suspense fallback={<IconPlaceholder />}>
                <ProjectIcon color={group.projectColor || "#6b7280"} name={group.projectIcon} />
            </Suspense>
        );
    };

    return (
        <div className="group/action-item text-brand-black/70 dark:text-brand-white/70 hover:text-brand-black hover:dark:text-brand-white flex items-center gap-2 px-2 py-1 text-xs font-medium">
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
                    <GripVertical className="text-brand-black/70 dark:text-brand-white/70 h-3 w-3 cursor-grab active:cursor-grabbing" />
                </div>
            )}
            {/* Loading indicator for reordering */}
            {isReordering && <Loader2 className="text-brand-black/70 dark:text-brand-white/70 h-3 w-3 animate-spin" />}
            <button
                aria-expanded={!isCollapsed}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                onClick={onToggleCollapse}
                type="button"
            >
                {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                {renderProjectIcon()}
                <span>{group.title}</span>
                {isPinned && isProjectGroup && (
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger render={<Pin className="size-3 shrink-0 fill-current" />} />
                            <TooltipContent>{t`Pinned project`}</TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )}
                <span className="text-brand-black/50 dark:text-brand-white/50">({group.threads.length})</span>
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
                                                    className="text-brand-black/70 dark:text-brand-white/70 hover:text-brand-black hover:dark:text-brand-white h-6 w-6 shrink-0 p-0"
                                                    variant="ghost"
                                                >
                                                    <MoreVertical className="size-3" />
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
