import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import cn from "@ui/utils/cn";
import type { NodeProps } from "@xyflow/react";
import { NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import { BoxSelect, ChevronDown, ChevronRight, Lock, LockOpen, Trash2, Ungroup } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { GroupNodeData } from "../../types";

const toolbarVariants = {
    exit: {
        opacity: 0,
        scale: 0.97,
        transition: { duration: 0.12, ease: [0.4, 0, 1, 1] as const },
        y: 6,
    },
    hidden: { opacity: 0, scale: 0.97, y: 6 },
    visible: {
        opacity: 1,
        scale: 1,
        transition: { damping: 35, mass: 0.6, stiffness: 500, type: "spring" as const },
        y: 0,
    },
};

const PADDING = 40;

const ToolbarSeparator = () => <div className="bg-border/60 mx-0.5 h-4 w-px shrink-0" />;

const GroupNode = ({ data, id, selected }: NodeProps) => {
    const ungroupNode = useWorkflowStore((state) => state.ungroupNode);
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const deleteNode = useWorkflowStore((state) => state.deleteNode);
    const updateNodeStyle = useWorkflowStore((state) => state.updateNodeStyle);
    const draggingOverGroupId = useWorkflowStore((state) => state.draggingOverGroupId);

    // Stable string key derived from child positions/sizes.
    // Only changes when a child actually moves or its measured size updates,
    // preventing unnecessary effect re-runs.
    const childrenKey = useWorkflowStore((state) =>
        state.nodes
            .flatMap((n) => (n.parentId === id ? [`${n.id}:${n.position.x},${n.position.y},${n.measured?.width ?? 0},${n.measured?.height ?? 0}`] : []))
            .join("|"),
    );

    const { t } = useLingui();
    const groupData = data as unknown as GroupNodeData;
    const nodeId = id as string;
    const isSelected = selected as boolean | undefined;
    const isDraggingOver = draggingOverGroupId === nodeId;
    const isLocked = groupData.locked ?? false;

    const [isEditingLabel, setIsEditingLabel] = useState(false);
    const [labelValue, setLabelValue] = useState(groupData.label ?? t`Group`);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const labelInputRef = useRef<HTMLInputElement>(null);

    // Focus the rename field as soon as it appears (replaces `autoFocus`, which
    // jsx-a11y forbids because it steals focus on first paint).
    useEffect(() => {
        if (isEditingLabel) {
            labelInputRef.current?.focus();
        }
    }, [isEditingLabel]);

    // Count children for collapsed badge
    const childCount = useWorkflowStore((state) => state.nodes.filter((n) => n.parentId === id).length);

    // Auto-resize group to always fit its children + padding.
    useEffect(() => {
        // Skip auto-resize when collapsed
        if (isCollapsed) return;

        // No children → nothing to compute
        if (!childrenKey) {
            return;
        }

        const { nodes } = useWorkflowStore.getState();
        const children = nodes.filter((n) => n.parentId === nodeId);

        if (children.length === 0) {
            return;
        }

        // Wait until React Flow has measured every child so we use real dimensions.
        if (children.some((n) => !n.measured)) {
            return;
        }

        const maxX = Math.max(...children.map((n) => n.position.x + (n.measured!.width ?? 280)));
        const maxY = Math.max(...children.map((n) => n.position.y + (n.measured!.height ?? 100)));

        const requiredWidth = Math.max(200, maxX + PADDING);
        const requiredHeight = Math.max(120, maxY + PADDING);

        const groupNode = nodes.find((n) => n.id === nodeId);
        const currentWidth = (groupNode?.style?.width as number) ?? 0;
        const currentHeight = (groupNode?.style?.height as number) ?? 0;

        // Threshold avoids micro-updates and infinite loops
        if (Math.abs(currentWidth - requiredWidth) > 1 || Math.abs(currentHeight - requiredHeight) > 1) {
            updateNodeStyle(nodeId, { height: requiredHeight, width: requiredWidth });
        }
    }, [nodeId, childrenKey, updateNodeStyle, isCollapsed]);

    const handleUngroup = (e: React.MouseEvent) => {
        e.stopPropagation();
        ungroupNode(nodeId);
    };

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        deleteNode(nodeId);
    };

    const handleToggleLock = (e: React.MouseEvent) => {
        e.stopPropagation();
        updateNode(nodeId, { locked: !isLocked } as Partial<GroupNodeData>);
    };

    const handleLabelDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsEditingLabel(true);
    };

    const commitLabel = () => {
        setIsEditingLabel(false);
        updateNode(nodeId, { label: labelValue } as Partial<GroupNodeData>);
    };

    let containerTone = "border-muted-foreground/25 bg-muted/[0.04] border-dashed";

    if (isSelected) {
        containerTone = "border-primary/70 bg-primary/[0.06] border-solid";
    } else if (isDraggingOver) {
        containerTone = "border-primary/60 bg-primary/[0.08] border-solid shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]";
    }

    let labelIcon = <BoxSelect className="size-3" />;

    if (isCollapsed) {
        labelIcon = <ChevronRight className="size-3" />;
    } else if (isLocked) {
        labelIcon = <Lock className="size-3" />;
    }

    return (
        <>
            {/* Resize handles – shown only when selected */}
            <NodeResizer
                handleClassName="!bg-background !border-primary/60 !w-2.5 !h-2.5 !rounded-sm"
                isVisible={isSelected}
                lineClassName="!border-primary/60"
                minHeight={120}
                minWidth={200}
            />

            {/* Toolbar – animates in when selected */}
            <NodeToolbar align="center" className="nodrag nopan nowheel" isVisible nodeId={nodeId} offset={8} position={Position.Top}>
                <AnimatePresence>
                    {isSelected && (
                        <motion.div
                            animate="visible"
                            className="bg-background/90 border-border/50 flex items-center gap-px rounded-2xl border p-1 shadow-md backdrop-blur-md"
                            exit="exit"
                            initial="hidden"
                            key="group-toolbar"
                            variants={toolbarVariants}
                        >
                            {/* Ungroup */}
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            className="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-colors"
                                            onClick={handleUngroup}
                                            type="button"
                                        >
                                            <Ungroup className="size-3.5" />
                                            <Trans>Ungroup</Trans>
                                        </button>
                                    }
                                />
                                <TooltipContent side="top">
                                    <span className="text-xs">
                                        <Trans>Dissolve group and release all children</Trans>
                                    </span>
                                </TooltipContent>
                            </Tooltip>

                            <ToolbarSeparator />

                            {/* Collapse / Expand */}
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            aria-label={isCollapsed ? t`Expand group` : t`Collapse group`}
                                            className="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-colors"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setIsCollapsed((v) => !v);

                                                // When collapsing, set minimum size; when expanding, auto-resize will take over
                                                if (!isCollapsed) {
                                                    updateNodeStyle(nodeId, { height: 60, width: 200 });
                                                }
                                            }}
                                            type="button"
                                        >
                                            {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                                            {isCollapsed ? <Trans>Expand</Trans> : <Trans>Collapse</Trans>}
                                        </button>
                                    }
                                />
                                <TooltipContent side="top">
                                    <span className="text-xs">
                                        {isCollapsed ? <Trans>Expand group to show children</Trans> : <Trans>Collapse group to hide children</Trans>}
                                    </span>
                                </TooltipContent>
                            </Tooltip>

                            <ToolbarSeparator />

                            {/* Lock / Unlock */}
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            aria-label={isLocked ? t`Unlock group` : t`Lock group`}
                                            className={cn(
                                                "flex h-8 w-8 items-center justify-center rounded-xl transition-colors",
                                                isLocked ? "text-foreground bg-muted/80" : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                                            )}
                                            onClick={handleToggleLock}
                                            type="button"
                                        >
                                            {isLocked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                                        </button>
                                    }
                                />
                                <TooltipContent side="top">
                                    <span className="text-xs">{isLocked ? <Trans>Unlock group</Trans> : <Trans>Lock group</Trans>}</span>
                                </TooltipContent>
                            </Tooltip>

                            <ToolbarSeparator />

                            {/* Delete */}
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <button
                                            aria-label={t`Delete group and children`}
                                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 flex h-8 w-8 items-center justify-center rounded-xl transition-colors"
                                            onClick={handleDelete}
                                            type="button"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </button>
                                    }
                                />
                                <TooltipContent side="top">
                                    <span className="text-xs">
                                        <Trans>Delete group and children</Trans>
                                    </span>
                                </TooltipContent>
                            </Tooltip>
                        </motion.div>
                    )}
                </AnimatePresence>
            </NodeToolbar>

            {/* Group container */}
            <div className={cn("relative h-full w-full rounded-xl border-2 transition-all duration-200", isCollapsed && "overflow-hidden", containerTone)}>
                {/* Editable label in top-left */}
                <div className="absolute top-2 left-2 z-10">
                    {isEditingLabel ? (
                        <input
                            aria-label={t`Group label`}
                            className="bg-background border-border focus:ring-primary min-w-[80px] rounded-md border px-2 py-0.5 text-xs font-medium outline-none focus:ring-1"
                            onBlur={commitLabel}
                            onChange={(e) => setLabelValue(e.target.value)}
                            onKeyDown={(e) => {
                                e.stopPropagation();

                                if (e.nativeEvent.isComposing) {
                                    return;
                                }

                                if (e.key === "Enter") {
                                    commitLabel();
                                } else if (e.key === "Escape") {
                                    setIsEditingLabel(false);
                                    setLabelValue(groupData.label ?? t`Group`);
                                }
                            }}
                            ref={labelInputRef}
                            value={labelValue}
                        />
                    ) : (
                        <div
                            className={cn(
                                "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium backdrop-blur-sm transition-colors select-none",
                                isLocked
                                    ? "bg-background/90 border-primary/30 text-primary/70"
                                    : "bg-background/70 border-border/40 text-muted-foreground hover:bg-background/90",
                            )}
                            onDoubleClick={handleLabelDoubleClick}
                            title={t`Double-click to rename`}
                        >
                            {labelIcon}
                            {groupData.label ?? t`Group`}
                            {isCollapsed && childCount > 0 && (
                                <span className="bg-muted text-muted-foreground ml-1 rounded-full px-1.5 py-0 text-[10px] font-normal">
                                    <Plural one="# node" other="# nodes" value={childCount} />
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* When collapsed, hide children with CSS (they still exist in the graph) */}
                {isCollapsed && (
                    <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-0">
                        {/* Children are rendered by React Flow inside this node's DOM area;
                            they're hidden via the parent's overflow-hidden + reduced size */}
                    </div>
                )}
            </div>
        </>
    );
};

export default GroupNode;
