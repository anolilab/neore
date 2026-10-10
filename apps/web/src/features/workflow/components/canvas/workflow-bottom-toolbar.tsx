import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/responsive-popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import cn from "@ui/utils/cn";
import { useReactFlow, useViewport } from "@xyflow/react";
import {
    BoxSelect,
    Brain,
    Code,
    Columns,
    Eraser,
    Expand,
    File,
    GitBranch,
    Hand,
    Image,
    Maximize2,
    MessageSquare,
    Mic,
    Minus,
    Monitor,
    MousePointer2,
    Palette,
    PenTool,
    Plus,
    Scissors,
    Search,
    SlidersHorizontal,
    Target,
    Type,
    User,
    Video,
    VideoIcon,
    Volume2,
    Wand2,
} from "lucide-react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { WorkflowNodeType } from "../../types";
import NODE_CONFIGS from "../../types";

interface QuickAddEntry {
    icon: React.ComponentType<{ className?: string }>;
    type: WorkflowNodeType;
}

interface QuickAddGroup {
    items: QuickAddEntry[];
    label: MessageDescriptor;
}

const QUICK_ADD_GROUPS: QuickAddGroup[] = [
    {
        items: [
            { icon: Image, type: "image" },
            { icon: Wand2, type: "img2img" },
            { icon: Maximize2, type: "upscale" },
            { icon: Eraser, type: "inpaint" },
            { icon: Expand, type: "outpaint" },
            { icon: Scissors, type: "background-removal" },
            { icon: PenTool, type: "object-editor" },
            { icon: User, type: "character-ref" },
            { icon: Palette, type: "style-ref" },
            { icon: Target, type: "controlnet" },
            { icon: Columns, type: "parallel-compare" },
            { icon: SlidersHorizontal, type: "advanced-controls" },
        ],
        label: msg`Image`,
    },
    {
        items: [
            { icon: Video, type: "video" },
            { icon: VideoIcon, type: "image-to-video" },
        ],
        label: msg`Video`,
    },
    {
        items: [
            { icon: Volume2, type: "audio" },
            { icon: Mic, type: "transcription" },
        ],
        label: msg`Audio`,
    },
    {
        items: [
            { icon: Type, type: "text" },
            { icon: Brain, type: "ai" },
            { icon: Code, type: "code" },
            { icon: File, type: "file" },
            { icon: Monitor, type: "output" },
            { icon: GitBranch, type: "branch" },
            { icon: BoxSelect, type: "group" },
            { icon: MessageSquare, type: "comment" },
        ],
        label: msg`Utility`,
    },
];

const WorkflowBottomToolbar = () => {
    const { getViewport, setViewport, zoomIn, zoomOut } = useReactFlow();
    const { zoom } = useViewport();
    const canvasMode = useWorkflowStore((state) => state.canvasMode);
    const setCanvasMode = useWorkflowStore((state) => state.setCanvasMode);
    const addNode = useWorkflowStore((state) => state.addNode);
    const selectNode = useWorkflowStore((state) => state.selectNode);
    const { i18n, t } = useLingui();

    const handleZoomReset = () => {
        const vp = getViewport();

        setViewport({ x: vp.x, y: vp.y, zoom: 1 }, { duration: 200 });
    };

    const handleAddNode = (type: WorkflowNodeType) => {
        const vp = getViewport();
        // Place new node near the visible center of the viewport
        const x = -vp.x / vp.zoom + 200;
        const y = -vp.y / vp.zoom + 200;
        const nodeId = addNode(type, { x, y }, { label: i18n._(NODE_CONFIGS[type].defaultLabel) });

        selectNode(nodeId);
    };

    const zoomPercent = Math.round(zoom * 100);

    const iconButton = (active = false) =>
        cn(
            buttonVariants({ size: "icon", variant: "ghost" }),
            "size-8 rounded-lg transition-colors",
            active && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
        );

    return (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
            <div className="bg-background/95 border-border/60 flex items-center gap-0.5 rounded-2xl border px-1.5 py-1.5 shadow-lg backdrop-blur-md">
                {/* Add node */}
                <Popover>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <PopoverTrigger
                                    render={
                                        <button aria-label={t`Add node`} className={iconButton()} type="button">
                                            <Plus className="size-4" />
                                        </button>
                                    }
                                />
                            }
                        />
                        <TooltipContent side="top">
                            <Trans>Add node</Trans>
                        </TooltipContent>
                    </Tooltip>

                    <PopoverContent align="center" className="w-auto max-w-[320px] p-2" side="top" sideOffset={8}>
                        <div className="space-y-2">
                            {QUICK_ADD_GROUPS.map((group) => (
                                <div key={group.label.id}>
                                    <p className="text-muted-foreground mb-1 px-1 text-[10px] font-medium tracking-wide uppercase">{i18n._(group.label)}</p>
                                    <div className="grid grid-cols-6 gap-0.5">
                                        {group.items.map(({ icon: Icon, type }) => {
                                            const config = NODE_CONFIGS[type];

                                            return (
                                                <Tooltip key={type}>
                                                    <TooltipTrigger
                                                        render={
                                                            <button
                                                                className={cn(buttonVariants({ size: "icon", variant: "ghost" }), "size-9 rounded-lg")}
                                                                onClick={() => handleAddNode(type)}
                                                                type="button"
                                                            >
                                                                <div
                                                                    className="flex size-5 items-center justify-center rounded"
                                                                    style={{
                                                                        backgroundColor: `${config.color}20`,
                                                                        color: config.color,
                                                                    }}
                                                                >
                                                                    <Icon aria-hidden="true" className="size-3.5" />
                                                                </div>
                                                            </button>
                                                        }
                                                    />
                                                    <TooltipContent side="top">
                                                        <p className="text-xs font-medium">{i18n._(config.label)}</p>
                                                    </TooltipContent>
                                                </Tooltip>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </PopoverContent>
                </Popover>

                <div className="bg-border/60 mx-0.5 h-5 w-px" />

                {/* Select mode */}
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button
                                aria-label={t`Select mode`}
                                aria-pressed={canvasMode === "select"}
                                className={iconButton(canvasMode === "select")}
                                onClick={() => setCanvasMode("select")}
                                type="button"
                            >
                                <MousePointer2 aria-hidden="true" className="size-4" />
                            </button>
                        }
                    />
                    <TooltipContent side="top">
                        <Trans>Select</Trans>
                    </TooltipContent>
                </Tooltip>

                {/* Pan mode */}
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button
                                aria-label={t`Pan mode`}
                                aria-pressed={canvasMode === "pan"}
                                className={iconButton(canvasMode === "pan")}
                                onClick={() => setCanvasMode("pan")}
                                type="button"
                            >
                                <Hand aria-hidden="true" className="size-4" />
                            </button>
                        }
                    />
                    <TooltipContent side="top">
                        <Trans>Hand (pan)</Trans>
                    </TooltipContent>
                </Tooltip>

                <div className="bg-border/60 mx-0.5 h-5 w-px" />

                {/* Zoom out */}
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button aria-label={t`Zoom out`} className={iconButton()} onClick={() => zoomOut({ duration: 200 })} type="button">
                                <Minus aria-hidden="true" className="size-4" />
                            </button>
                        }
                    />
                    <TooltipContent side="top">
                        <Trans>Zoom out</Trans>
                    </TooltipContent>
                </Tooltip>

                {/* Zoom display + reset */}
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button
                                aria-label={t`Reset zoom (currently ${zoomPercent}%)`}
                                className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-8 min-w-[3.75rem] items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium tabular-nums transition-colors"
                                onClick={handleZoomReset}
                                type="button"
                            >
                                <Search aria-hidden="true" className="size-3.5 shrink-0" />
                                {zoomPercent}%
                            </button>
                        }
                    />
                    <TooltipContent side="top">
                        <Trans>Reset zoom (100%)</Trans>
                    </TooltipContent>
                </Tooltip>

                {/* Zoom in */}
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button aria-label={t`Zoom in`} className={iconButton()} onClick={() => zoomIn({ duration: 200 })} type="button">
                                <Plus aria-hidden="true" className="size-4" />
                            </button>
                        }
                    />
                    <TooltipContent side="top">
                        <Trans>Zoom in</Trans>
                    </TooltipContent>
                </Tooltip>
            </div>
        </div>
    );
};

export default WorkflowBottomToolbar;
