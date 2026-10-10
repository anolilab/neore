import { Trans, useLingui } from "@lingui/react/macro";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/responsive-popover";
import cn from "@ui/utils/cn";
import { NodeToolbar, Position } from "@xyflow/react";
import { Brain, Code, File, GitBranch, Image, Maximize2, Mic, Monitor, Plus, Scissors, Type, Video, Volume2, Wand2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { WorkflowNodeType } from "../../types";
import NODE_CONFIGS from "../../types";

// ─── Icon map ──────────────────────────────────────────────────────────────────

const NODE_ICONS: Partial<Record<WorkflowNodeType, React.ComponentType<{ className?: string }>>> = {
    ai: Brain,
    audio: Volume2,
    "background-removal": Scissors,
    branch: GitBranch,
    code: Code,
    file: File,
    image: Image,
    "image-to-video": Video,
    img2img: Wand2,
    output: Monitor,
    text: Type,
    transcription: Mic,
    upscale: Maximize2,
    video: Video,
};

// ─── Quick-add sets ────────────────────────────────────────────────────────────

const QUICK_ADD_OUTPUT: WorkflowNodeType[] = ["image", "ai", "upscale", "video", "output", "text", "code"];
const QUICK_ADD_INPUT: WorkflowNodeType[] = ["text", "image", "file", "ai", "code", "branch", "video"];

// ─── Animation variants ────────────────────────────────────────────────────────

const buttonVariants = {
    left: {
        exit: {
            opacity: 0,
            transition: { duration: 0.1, ease: [0.4, 0, 1, 1] as const },
            x: 6,
        },
        hidden: { opacity: 0, x: 6 },
        visible: {
            opacity: 1,
            transition: { damping: 35, mass: 0.5, stiffness: 500, type: "spring" as const },
            x: 0,
        },
    },
    right: {
        exit: {
            opacity: 0,
            transition: { duration: 0.1, ease: [0.4, 0, 1, 1] as const },
            x: -6,
        },
        hidden: { opacity: 0, x: -6 },
        visible: {
            opacity: 1,
            transition: { damping: 35, mass: 0.5, stiffness: 500, type: "spring" as const },
            x: 0,
        },
    },
};

// ─── Component ─────────────────────────────────────────────────────────────────

interface NodeConnectButtonProps {
    /** Hide this button if the node has no handles on this side */
    disabled?: boolean;
    nodeId: string;
    /** Show the button only when the parent node is selected */
    selected?: boolean;
    /** "left" = add an input node; "right" = add an output node */
    side: "left" | "right";
}

const NodeConnectButton = ({ disabled, nodeId, selected = false, side }: NodeConnectButtonProps) => {
    const { i18n, t } = useLingui();
    const [open, setOpen] = useState(false);
    const addNode = useWorkflowStore((state) => state.addNode);
    const nodes = useWorkflowStore((state) => state.nodes);
    const setEdges = useWorkflowStore((state) => state.setEdges);
    const edges = useWorkflowStore((state) => state.edges);

    const handleAddNode = useCallback(
        (type: WorkflowNodeType) => {
            const currentNode = nodes.find((n) => n.id === nodeId);

            if (!currentNode) {
                return;
            }

            const offset = side === "right" ? 360 : -360;
            const newPosition = {
                x: currentNode.position.x + offset,
                y: currentNode.position.y,
            };

            const newNodeId = addNode(type, newPosition, { label: i18n._(NODE_CONFIGS[type].defaultLabel) });

            const newEdge = {
                id: `edge-${nodeId}-${newNodeId}`,
                source: side === "right" ? nodeId : newNodeId,
                sourceHandle: "output-0",
                target: side === "right" ? newNodeId : nodeId,
                targetHandle: "input-0",
                type: "animated",
            };

            setEdges([...edges, newEdge]);
            setOpen(false);
        },
        [nodeId, nodes, side, addNode, edges, setEdges, i18n],
    );

    if (disabled) {
        return null;
    }

    const quickNodes = side === "right" ? QUICK_ADD_OUTPUT : QUICK_ADD_INPUT;
    const toolbarPosition = side === "right" ? Position.Right : Position.Left;
    const variants = buttonVariants[side];

    return (
        <NodeToolbar align="center" className="nodrag nopan nowheel" isVisible nodeId={nodeId} offset={0} position={toolbarPosition}>
            <AnimatePresence>
                {selected && (
                    <motion.div animate="visible" exit="exit" initial="hidden" key={`connect-${side}`} variants={variants}>
                        <Popover onOpenChange={setOpen} open={open}>
                            <PopoverTrigger
                                render={
                                    <button
                                        aria-label={side === "right" ? t`Add output node` : t`Add input node`}
                                        className={cn(
                                            "flex size-6 items-center justify-center rounded-full",
                                            "border-border/70 bg-background border shadow-sm",
                                            "text-muted-foreground hover:text-foreground hover:border-primary/60 hover:bg-muted/60",
                                            "transition-colors duration-150",
                                        )}
                                        onMouseDown={(e) => e.stopPropagation()}
                                        type="button"
                                    >
                                        <Plus className="size-3.5" />
                                    </button>
                                }
                            />
                            <PopoverContent align="center" className="w-auto p-2" side={side === "right" ? "right" : "left"} sideOffset={8}>
                                <p className="text-muted-foreground mb-2 px-1 text-[10px] font-medium tracking-wide uppercase">
                                    {side === "right" ? <Trans>Add output node</Trans> : <Trans>Add input node</Trans>}
                                </p>
                                <div className="grid grid-cols-4 gap-1">
                                    {quickNodes.map((type) => {
                                        const config = NODE_CONFIGS[type];
                                        const Icon = NODE_ICONS[type];
                                        const label = i18n._(config.label);

                                        return (
                                            <button
                                                className="hover:bg-muted/70 flex min-w-[52px] flex-col items-center gap-1.5 rounded-lg p-2 text-center transition-colors"
                                                key={type}
                                                onClick={() => handleAddNode(type)}
                                                type="button"
                                            >
                                                <div
                                                    className="flex size-8 items-center justify-center rounded-lg"
                                                    style={{
                                                        backgroundColor: `${config.color}18`,
                                                        color: config.color,
                                                    }}
                                                >
                                                    {Icon ? <Icon className="size-4" /> : <span className="text-xs font-bold">{label[0]}</span>}
                                                </div>
                                                <span className="text-muted-foreground text-[10px] leading-tight">{label}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </PopoverContent>
                        </Popover>
                    </motion.div>
                )}
            </AnimatePresence>
        </NodeToolbar>
    );
};

export default NodeConnectButton;
