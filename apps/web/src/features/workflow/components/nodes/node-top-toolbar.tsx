import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import cn from "@ui/utils/cn";
import { NodeToolbar, Position } from "@xyflow/react";
import { ArrowUpToLine, Bookmark, ChevronDown, Download, Eraser, Expand, ImageUp, Lock, LockOpen, Maximize2, Scissors, Unlink2, Wand2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { nanoid } from "nanoid";
import type { ChangeEvent } from "react";
import { useRef, useState } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { ImageNodeData, WorkflowNodeData, WorkflowNodeType } from "../../types";
import NODE_CONFIGS from "../../types";
import type { BaseModelOption } from "../../utils/model-options";
import { getModelLabel, toBaseOption } from "../../utils/model-options";
import NodeExpandModal from "./node-expand-modal";

// ─── Model Options (derived from gateway + country-filtered models) ─────────

const getModelsForNodeType = (nodeType: WorkflowNodeType, models: GatewayModel[]): BaseModelOption[] => {
    switch (nodeType) {
        case "ai": {
            return models.flatMap((m) => (m.enabled && m.filterCapabilities?.includes("text") ? [toBaseOption(m)] : []));
        }
        case "audio": {
            return models.flatMap((m) => (m.enabled && m.mode === "text-to-speech" ? [toBaseOption(m)] : []));
        }
        case "image": {
            return models.flatMap((m) => (m.enabled && m.filterCapabilities?.includes("image_generation") ? [toBaseOption(m)] : []));
        }
        case "image-to-video": {
            return models.flatMap((m) => (m.enabled && m.supportsImageToVideo ? [toBaseOption(m)] : []));
        }
        case "img2img": {
            return models.flatMap((m) => (m.enabled && m.supportsImg2Img ? [toBaseOption(m)] : []));
        }
        case "transcription": {
            return models.flatMap((m) => (m.enabled && m.mode === "speech-to-text" ? [toBaseOption(m)] : []));
        }
        case "upscale": {
            return models.flatMap((m) => (m.enabled && m.supportsUpscale ? [toBaseOption(m)] : []));
        }
        case "video": {
            return models.flatMap((m) => (m.enabled && m.supportsTextToVideo ? [toBaseOption(m)] : []));
        }
        default: {
            return [];
        }
    }
};

// ─── Aspect Ratios ─────────────────────────────────────────────────────────────

const ASPECT_RATIOS = [
    { label: "1:1", value: "1:1" },
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
    { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" },
    { label: "3:2", value: "3:2" },
    { label: "2:3", value: "2:3" },
];

// ─── Tools Config ──────────────────────────────────────────────────────────────

interface ToolOption {
    description: MessageDescriptor;
    icon: React.ComponentType<{ className?: string }>;
    label: MessageDescriptor;
}

const IMAGE_TOOLS: (ToolOption & { nodeType: WorkflowNodeType })[] = [
    { description: msg`Enhance resolution`, icon: ArrowUpToLine, label: msg`Upscale`, nodeType: "upscale" },
    { description: msg`Edit specific regions`, icon: Eraser, label: msg`Inpaint`, nodeType: "inpaint" },
    { description: msg`Expand canvas`, icon: Expand, label: msg`Outpaint`, nodeType: "outpaint" },
    { description: msg`Extract subject`, icon: Scissors, label: msg`Remove BG`, nodeType: "background-removal" },
    { description: msg`Transform with AI`, icon: Wand2, label: msg`Img2Img`, nodeType: "img2img" },
];

const NODE_TOOLS: Partial<Record<WorkflowNodeType, (ToolOption & { nodeType: WorkflowNodeType })[]>> = {
    image: IMAGE_TOOLS,
    "image-to-video": [IMAGE_TOOLS[0]!],
    img2img: IMAGE_TOOLS.slice(0, 3),
};

// ─── Type helpers ──────────────────────────────────────────────────────────────

/** Node types whose toolbar offers an aspect-ratio picker. */
const ASPECT_RATIO_NODE_TYPES = new Set<WorkflowNodeType>(["image", "image-to-video", "video"]);

/** Media URL keys a node's execution output may expose. */
interface NodeMediaOutput {
    image?: unknown;
    imageUrl?: unknown;
    src?: unknown;
    url?: unknown;
}

/** Pull a downloadable image URL out of a node's execution output, if it has one. */
const resolveOutputImageUrl = (output: unknown): string | undefined => {
    if (typeof output === "string") {
        return output.startsWith("http") || output.startsWith("data:image") ? output : undefined;
    }

    if (typeof output === "object" && output !== null) {
        const media = output as NodeMediaOutput;
        const candidate = media.url ?? media.imageUrl ?? media.image ?? media.src;

        return typeof candidate === "string" ? candidate : undefined;
    }

    return undefined;
};

const hasModel = (data: WorkflowNodeData): data is WorkflowNodeData & { model?: string } => "model" in data;
const hasAspectRatio = (data: WorkflowNodeData): data is WorkflowNodeData & { aspectRatio?: string } => "aspectRatio" in data;
const hasNumberImages = (data: WorkflowNodeData): data is ImageNodeData => "numImages" in data;

// ─── Sub-components ────────────────────────────────────────────────────────────

const ToolbarSeparator = () => <div className="bg-border/60 mx-0.5 h-4 w-px shrink-0" />;

interface IconButtonProps {
    active?: boolean;
    disabled?: boolean;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    onClick?: (e: React.MouseEvent) => void;
}

const IconButton = ({ active, disabled, icon: Icon, label, onClick }: IconButtonProps) => (
    <Tooltip>
        <TooltipTrigger
            render={
                <button
                    aria-label={label}
                    className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl",
                        "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                        "transition-colors disabled:pointer-events-none disabled:opacity-50",
                        active && "text-foreground bg-muted/80",
                    )}
                    disabled={disabled}
                    onClick={onClick}
                    type="button"
                >
                    <Icon className="size-3.5" />
                </button>
            }
        />
        <TooltipContent side="top">
            <span className="text-xs">{label}</span>
        </TooltipContent>
    </Tooltip>
);

// ─── Animation variants ────────────────────────────────────────────────────────

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

// ─── Main Component ─────────────────────────────────────────────────────────────

export interface NodeTopToolbarProps {
    data: WorkflowNodeData;
    nodeId: string;
    nodeType: WorkflowNodeType;
    selected?: boolean;
}

const NodeTopToolbar = ({ data, nodeId, nodeType, selected = false }: NodeTopToolbarProps) => {
    const updateNode = useWorkflowStore((state) => state.updateNode);
    const detachFromGroup = useWorkflowStore((state) => state.detachFromGroup);
    const nodeParentId = useWorkflowStore((state) => state.nodes.find((n) => n.id === nodeId)?.parentId);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [expandOpen, setExpandOpen] = useState(false);
    const models = useFeatureFlaggedModels();
    const { i18n, t } = useLingui();

    const modelOptions = getModelsForNodeType(nodeType, models);
    const isShowModelPicker = modelOptions.length > 0 && hasModel(data);
    const isShowAspectRatio = hasAspectRatio(data) && ASPECT_RATIO_NODE_TYPES.has(nodeType);
    const isShowNumberImages = hasNumberImages(data) && nodeType === "image";
    const tools = NODE_TOOLS[nodeType] ?? [];
    const isMediaNode = ["image", "image-to-video", "img2img", "inpaint", "video"].includes(nodeType);
    const isLocked = (data as WorkflowNodeData & { locked?: boolean }).locked ?? false;

    const currentModel = hasModel(data) ? data.model : undefined;
    const currentModelLabel = getModelLabel(currentModel, models, t`Model`);
    const currentAspectRatio = hasAspectRatio(data) ? data.aspectRatio : undefined;
    const currentNumberImages = hasNumberImages(data) ? ((data as ImageNodeData).numImages ?? 1) : 1;

    const handleModelChange = (model: string) => {
        updateNode(nodeId, { model } as Partial<WorkflowNodeData>);
    };

    const handleAspectRatioChange = (aspectRatio: string) => {
        updateNode(nodeId, { aspectRatio } as Partial<WorkflowNodeData>);
    };

    const handleNumberImages = (e: React.MouseEvent, delta: number) => {
        e.stopPropagation();
        const next = Math.max(1, Math.min(4, currentNumberImages + delta));

        updateNode(nodeId, { numImages: next } as Partial<WorkflowNodeData>);
    };

    const handleToggleLock = (e: React.MouseEvent) => {
        e.stopPropagation();
        updateNode(nodeId, { locked: !isLocked } as Partial<WorkflowNodeData>);
    };

    const handleDownload = (e: React.MouseEvent) => {
        e.stopPropagation();

        const nodeState = useWorkflowStore.getState().execution.nodeStates[nodeId];
        const output = nodeState?.output;

        if (!output) return;

        // Image URL — download the image
        const imageUrl = resolveOutputImageUrl(output);

        if (imageUrl !== undefined) {
            const a = document.createElement("a");

            a.href = imageUrl;
            a.download = `${nodeId}-output.png`;
            a.click();

            return;
        }

        // Text/JSON — download as file
        const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");

        a.href = url;
        a.download = `${nodeId}-output.${typeof output === "string" ? "txt" : "json"}`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleExpand = (e: React.MouseEvent) => {
        e.stopPropagation();
        setExpandOpen(true);
    };

    const handleUploadClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];

        if (!file) {
            return;
        }

        // Read file as data URL and set as node image input
        const reader = new FileReader();

        reader.addEventListener("load", () => {
            const dataUrl = reader.result as string;

            if (nodeType === "image") {
                updateNode(nodeId, { imageUrl: dataUrl, mode: "input" } as Partial<WorkflowNodeData>);
            } else {
                // For other media nodes, pass the URL as an upstream image
                updateNode(nodeId, { imageUrl: dataUrl } as Partial<WorkflowNodeData>);
            }
        });
        reader.readAsDataURL(file);

        e.target.value = "";
    };

    const hasAnySeparatorLeft = isShowModelPicker || isShowAspectRatio || isShowNumberImages;
    const hasToolsSection = tools.length > 0 || isMediaNode;

    return (
        <>
            {/* Expand modal rendered at page root level */}
            <NodeExpandModal data={data} nodeId={nodeId} nodeType={nodeType} onClose={() => setExpandOpen(false)} open={expandOpen} />

            {/* Toolbar – always mounted (isVisible) so AnimatePresence exit works */}
            <NodeToolbar align="center" className="nodrag nopan nowheel" isVisible nodeId={nodeId} offset={8} position={Position.Top}>
                <AnimatePresence>
                    {selected && (
                        <motion.div
                            animate="visible"
                            className="bg-background/90 border-border/50 flex items-center gap-px rounded-2xl border p-1 shadow-md backdrop-blur-md"
                            exit="exit"
                            initial="hidden"
                            key="toolbar"
                            variants={toolbarVariants}
                        >
                            {/* Model picker */}
                            {isShowModelPicker && (
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        render={
                                            <button
                                                className="text-foreground hover:bg-muted/60 flex h-8 items-center gap-1 rounded-xl px-2 text-xs font-medium whitespace-nowrap transition-colors"
                                                type="button"
                                            >
                                                {currentModelLabel}
                                                <ChevronDown className="text-muted-foreground size-3" />
                                            </button>
                                        }
                                    />
                                    <DropdownMenuContent align="start" side="bottom" sideOffset={6}>
                                        {modelOptions.map((opt) => (
                                            <DropdownMenuItem
                                                className={cn("cursor-pointer text-xs", currentModel === opt.value && "text-primary font-medium")}
                                                key={opt.value}
                                                onClick={() => handleModelChange(opt.value)}
                                            >
                                                {opt.label}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}

                            {/* Aspect ratio */}
                            {isShowAspectRatio && (
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        render={
                                            <button
                                                className="text-foreground hover:bg-muted/60 flex h-8 items-center gap-1 rounded-xl px-2 text-xs font-medium whitespace-nowrap transition-colors"
                                                type="button"
                                            >
                                                {currentAspectRatio ?? "1:1"}
                                                <ChevronDown className="text-muted-foreground size-3" />
                                            </button>
                                        }
                                    />
                                    <DropdownMenuContent align="start" side="bottom" sideOffset={6}>
                                        {ASPECT_RATIOS.map((ar) => (
                                            <DropdownMenuItem
                                                className={cn("cursor-pointer text-xs", currentAspectRatio === ar.value && "text-primary font-medium")}
                                                key={ar.value}
                                                onClick={() => handleAspectRatioChange(ar.value)}
                                            >
                                                {ar.label}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}

                            {/* Num images stepper (image generation nodes) */}
                            {isShowNumberImages && (
                                <div className="flex h-8 items-center gap-0.5 px-1.5">
                                    <button
                                        aria-label={t`Decrease number of images`}
                                        className="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex size-5 items-center justify-center rounded-md text-xs font-bold transition-colors"
                                        onClick={(e) => handleNumberImages(e, -1)}
                                        type="button"
                                    >
                                        −
                                    </button>
                                    <span className="text-foreground min-w-[1.25rem] text-center text-xs font-medium select-none">{currentNumberImages}</span>
                                    <button
                                        aria-label={t`Increase number of images`}
                                        className="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex size-5 items-center justify-center rounded-md text-xs font-bold transition-colors"
                                        onClick={(e) => handleNumberImages(e, 1)}
                                        type="button"
                                    >
                                        +
                                    </button>
                                </div>
                            )}

                            {/* Separator before tools/actions */}
                            {hasAnySeparatorLeft && hasToolsSection && <ToolbarSeparator />}

                            {/* Tools dropdown */}
                            {tools.length > 0 && (
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        render={
                                            <button
                                                className="text-foreground hover:bg-muted/60 flex h-8 items-center gap-1.5 rounded-xl px-2 text-xs font-medium transition-colors"
                                                type="button"
                                            >
                                                <Wand2 className="text-muted-foreground size-3.5" />
                                                <Trans>Tools</Trans>
                                                <ChevronDown className="text-muted-foreground size-3" />
                                            </button>
                                        }
                                    />
                                    <DropdownMenuContent align="start" side="bottom" sideOffset={6}>
                                        {tools.map((tool) => {
                                            const ToolIcon = tool.icon;

                                            return (
                                                <DropdownMenuItem
                                                    className="cursor-pointer gap-2 text-xs"
                                                    key={tool.nodeType}
                                                    onClick={() => {
                                                        // Create the tool node downstream and connect it
                                                        const state = useWorkflowStore.getState();
                                                        const currentNode = state.nodes.find((n) => n.id === nodeId);

                                                        if (!currentNode) return;

                                                        const newNodeId = state.addNode(
                                                            tool.nodeType,
                                                            {
                                                                x: currentNode.position.x + 340,
                                                                y: currentNode.position.y,
                                                            },
                                                            { label: i18n._(NODE_CONFIGS[tool.nodeType].defaultLabel) },
                                                        );

                                                        const newEdge = {
                                                            id: `edge-${nanoid(8)}`,
                                                            source: nodeId,
                                                            sourceHandle: "output-0",
                                                            target: newNodeId,
                                                            targetHandle: "input-0",
                                                            type: "animated" as const,
                                                        };

                                                        state.setEdges([...state.edges, newEdge]);
                                                        state.selectNode(newNodeId);
                                                    }}
                                                >
                                                    <ToolIcon className="text-muted-foreground size-3.5" />
                                                    <div>
                                                        <div className="font-medium">{i18n._(tool.label)}</div>
                                                        <div className="text-muted-foreground">{i18n._(tool.description)}</div>
                                                    </div>
                                                </DropdownMenuItem>
                                            );
                                        })}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}

                            {/* Upload (media nodes) */}
                            {isMediaNode && (
                                <>
                                    <input accept="image/*,video/*" className="hidden" onChange={handleFileChange} ref={fileInputRef} type="file" />
                                    <IconButton icon={ImageUp} label={t`Upload image / video`} onClick={handleUploadClick} />
                                </>
                            )}

                            {/* Separator before node controls */}
                            {hasToolsSection && <ToolbarSeparator />}

                            {/* Detach from group */}
                            {nodeParentId && (
                                <>
                                    <IconButton
                                        icon={Unlink2}
                                        label={t`Detach from group`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            detachFromGroup(nodeId);
                                        }}
                                    />
                                    <ToolbarSeparator />
                                </>
                            )}

                            {/* Lock */}
                            <IconButton
                                active={isLocked}
                                icon={isLocked ? Lock : LockOpen}
                                label={isLocked ? t`Unlock node` : t`Lock node`}
                                onClick={handleToggleLock}
                            />

                            {/* Bookmark */}
                            <IconButton
                                active={Boolean((data as WorkflowNodeData & { bookmarked?: boolean }).bookmarked)}
                                icon={Bookmark}
                                label={(data as WorkflowNodeData & { bookmarked?: boolean }).bookmarked ? t`Remove bookmark` : t`Bookmark node`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const current = (data as WorkflowNodeData & { bookmarked?: boolean }).bookmarked ?? false;

                                    updateNode(nodeId, { bookmarked: !current } as Partial<WorkflowNodeData>);
                                }}
                            />

                            <ToolbarSeparator />

                            {/* Download */}
                            <IconButton icon={Download} label={t`Download content`} onClick={handleDownload} />

                            <ToolbarSeparator />

                            {/* Expand */}
                            <IconButton icon={Maximize2} label={t`Expand to fullscreen`} onClick={handleExpand} />
                        </motion.div>
                    )}
                </AnimatePresence>
            </NodeToolbar>
        </>
    );
};

export default NodeTopToolbar;
