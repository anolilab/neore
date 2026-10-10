import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import cn from "@ui/utils/cn";
import {
    BoxSelect,
    Brain,
    ChevronDown,
    ChevronRight,
    Code,
    Columns,
    Eraser,
    Expand,
    File,
    GitBranch,
    Image,
    Maximize2,
    Mic,
    Monitor,
    Palette,
    PenTool,
    Scissors,
    SlidersHorizontal,
    Target,
    Type,
    User,
    Video,
    VideoIcon,
    Volume2,
    Wand2,
} from "lucide-react";
import { useState } from "react";

import type { WorkflowNodeType } from "../../types";
import NODE_CONFIGS from "../../types";

interface ToolbarNodeItem {
    icon: React.ComponentType<{ className?: string }>;
    type: WorkflowNodeType;
}

interface ToolbarGroup {
    children: ToolbarNodeItem[];
    icon: React.ComponentType<{ className?: string }>;
    type: WorkflowNodeType;
}

type ToolbarEntry = ToolbarGroup | ToolbarNodeItem;

const isGroup = (entry: ToolbarEntry): entry is ToolbarGroup => "children" in entry && (entry as ToolbarGroup).children.length > 0;

const TOOLBAR_ENTRIES: ToolbarEntry[] = [
    // Grouped base nodes with their compatible operations
    {
        children: [
            { icon: Wand2, type: "img2img" },
            { icon: Maximize2, type: "upscale" },
            { icon: Eraser, type: "inpaint" },
            { icon: Expand, type: "outpaint" },
            { icon: Scissors, type: "background-removal" },
            { icon: PenTool, type: "object-editor" },
            { icon: User, type: "character-ref" },
            { icon: Palette, type: "style-ref" },
            { icon: Columns, type: "parallel-compare" },
            { icon: Target, type: "controlnet" },
            { icon: SlidersHorizontal, type: "advanced-controls" },
        ],
        icon: Image,
        type: "image",
    },
    {
        children: [{ icon: VideoIcon, type: "image-to-video" }],
        icon: Video,
        type: "video",
    },
    {
        children: [{ icon: Mic, type: "transcription" }],
        icon: Volume2,
        type: "audio",
    },
    // Standalone utility nodes
    { icon: Type, type: "text" },
    { icon: Brain, type: "ai" },
    { icon: Code, type: "code" },
    { icon: File, type: "file" },
    { icon: Monitor, type: "output" },
    { icon: GitBranch, type: "branch" },
    // Layout / organization
    { icon: BoxSelect, type: "group" },
];

const NodeButton = ({
    icon: Icon,
    indented = false,
    onDragStart,
    type,
}: ToolbarNodeItem & { indented?: boolean; onDragStart: (e: React.DragEvent, type: WorkflowNodeType) => void }) => {
    const { i18n } = useLingui();
    const config = NODE_CONFIGS[type];

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <button
                        className={cn(buttonVariants({ size: "icon", variant: "ghost" }), "size-9 cursor-grab active:cursor-grabbing", indented && "ml-2")}
                        draggable
                        onDragStart={(e) => onDragStart(e, type)}
                        type="button"
                    >
                        <div
                            className="flex size-5 items-center justify-center rounded"
                            style={{
                                backgroundColor: `${config.color}20`,
                                color: config.color,
                            }}
                        >
                            <Icon className="size-3.5" />
                        </div>
                    </button>
                }
            />
            <TooltipContent side="right">
                <p className="font-medium">{i18n._(config.label)}</p>
                <p className="text-muted-foreground text-xs">{i18n._(config.description)}</p>
            </TooltipContent>
        </Tooltip>
    );
};

const WorkflowToolbar = () => {
    const { i18n } = useLingui();
    const [expandedGroups, setExpandedGroups] = useState<Set<WorkflowNodeType>>(new Set());

    const onDragStart = (event: React.DragEvent, nodeType: WorkflowNodeType) => {
        const { dataTransfer } = event;

        dataTransfer.setData("application/workflow-node", nodeType);
        dataTransfer.effectAllowed = "move";
    };

    const toggleGroup = (type: WorkflowNodeType) => {
        setExpandedGroups((previous) => {
            const next = new Set(previous);

            if (next.has(type)) {
                next.delete(type);
            } else {
                next.add(type);
            }

            return next;
        });
    };

    // Separate grouped from standalone for the divider
    const grouped = TOOLBAR_ENTRIES.filter(isGroup);
    const standalone = TOOLBAR_ENTRIES.filter((e) => !isGroup(e)) as ToolbarNodeItem[];

    return (
        <div className="absolute top-1/2 left-4 z-10 -translate-y-1/2">
            <div className="bg-background/95 flex flex-col gap-0.5 rounded-lg border p-1.5 shadow-lg backdrop-blur-sm">
                {/* Grouped base nodes */}
                {grouped.map((group) => {
                    const config = NODE_CONFIGS[group.type];
                    const isExpanded = expandedGroups.has(group.type);
                    const GroupIcon = group.icon;
                    const Chevron = isExpanded ? ChevronDown : ChevronRight;
                    const groupLabel = i18n._(config.label);

                    return (
                        <div key={group.type}>
                            {/* Group header row */}
                            <div className="flex items-center gap-0.5">
                                <NodeButton icon={GroupIcon} onDragStart={onDragStart} type={group.type} />
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <button
                                                className={cn(
                                                    buttonVariants({ variant: "ghost" }),
                                                    "h-5 w-5 rounded p-0",
                                                    isExpanded && "text-foreground",
                                                    !isExpanded && "text-muted-foreground",
                                                )}
                                                onClick={() => toggleGroup(group.type)}
                                                type="button"
                                            >
                                                <Chevron className="size-3" />
                                            </button>
                                        }
                                    />
                                    <TooltipContent side="right">
                                        <p className="text-xs">{isExpanded ? <Trans>Collapse</Trans> : <Trans>Expand {groupLabel} operations</Trans>}</p>
                                    </TooltipContent>
                                </Tooltip>
                            </div>

                            {/* Expanded children */}
                            {isExpanded && (
                                <div className="mt-0.5 mb-1 ml-4 flex flex-col gap-0.5 border-l-2 pl-0.5" style={{ borderColor: `${config.color}40` }}>
                                    {group.children.map(({ icon, type }) => (
                                        <NodeButton icon={icon} indented key={type} onDragStart={onDragStart} type={type} />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Divider */}
                <div className="border-border/60 my-1 border-t" />

                {/* Standalone utility nodes */}
                {standalone.map(({ icon, type }) => (
                    <NodeButton icon={icon} key={type} onDragStart={onDragStart} type={type} />
                ))}
            </div>
        </div>
    );
};

export default WorkflowToolbar;
