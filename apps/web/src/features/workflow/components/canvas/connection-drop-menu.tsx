/**
 * Context menu that appears when a user drops a connection handle onto empty
 * canvas space. Lists compatible node types so the user can quickly create and
 * auto-connect a new node.
 *
 * U3: Context-aware — shows relevant nodes first based on the source node type.
 */
import { Trans, useLingui } from "@lingui/react/macro";
import {
    Brain,
    Code,
    Columns,
    Eraser,
    Expand,
    File,
    GitBranch,
    Image,
    Maximize2,
    MessageSquare,
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
import { useEffect, useRef } from "react";

import type { WorkflowNodeType } from "../../types";
import NODE_CONFIGS from "../../types";

const NODE_ICONS: Record<WorkflowNodeType, React.ComponentType<{ className?: string }>> = {
    "advanced-controls": SlidersHorizontal,
    ai: Brain,
    audio: Volume2,
    "background-removal": Scissors,
    branch: GitBranch,
    "character-ref": User,
    code: Code,
    comment: MessageSquare,
    controlnet: Target,
    file: File,
    group: Type, // Not normally shown
    image: Image,
    "image-to-video": VideoIcon,
    img2img: Wand2,
    inpaint: Eraser,
    "object-editor": PenTool,
    outpaint: Expand,
    output: Monitor,
    "parallel-compare": Columns,
    "style-ref": Palette,
    text: Type,
    transcription: Mic,
    upscale: Maximize2,
    video: Video,
};

/** Suggested node types based on the source node's output type */
const CONTEXT_SUGGESTIONS: Partial<Record<WorkflowNodeType, WorkflowNodeType[]>> = {
    ai: ["text", "image", "code", "output"],
    audio: ["output", "transcription"],
    "background-removal": ["output", "upscale", "img2img"],
    "character-ref": ["upscale", "output", "background-removal"],
    code: ["text", "ai", "output"],
    controlnet: ["upscale", "output"],
    file: ["ai", "image", "text", "output"],
    image: ["upscale", "img2img", "inpaint", "outpaint", "background-removal", "object-editor", "image-to-video", "output"],
    "image-to-video": ["output"],
    img2img: ["upscale", "inpaint", "outpaint", "background-removal", "output"],
    inpaint: ["upscale", "output", "background-removal"],
    "object-editor": ["upscale", "output", "background-removal"],
    outpaint: ["upscale", "output", "background-removal"],
    "parallel-compare": ["output"],
    "style-ref": ["upscale", "output", "background-removal"],
    text: ["ai", "image", "code", "output"],
    transcription: ["ai", "text", "output"],
    upscale: ["output", "background-removal", "img2img"],
    video: ["output"],
};

/** All available nodes (excluding group) */
const ALL_NODES: WorkflowNodeType[] = Object.keys(NODE_CONFIGS).filter((t) => t !== "group") as WorkflowNodeType[];

export interface ConnectionDropMenuProps {
    onClose: () => void;
    onSelect: (type: WorkflowNodeType) => void;
    position: { x: number; y: number };
    /** The type of the source node the connection is coming from */
    sourceNodeType?: WorkflowNodeType;
}

const ConnectionDropMenu = ({ onClose, onSelect, position, sourceNodeType }: ConnectionDropMenuProps) => {
    const { i18n } = useLingui();
    const menuRef = useRef<HTMLDivElement>(null);

    // Context-aware: show relevant nodes first, then the rest
    const suggestedNodes = sourceNodeType ? (CONTEXT_SUGGESTIONS[sourceNodeType] ?? []) : [];
    const suggestedNodeSet = new Set(suggestedNodes);
    const nodeList = { rest: ALL_NODES.filter((t) => !suggestedNodeSet.has(t)), suggested: suggestedNodes };

    // Close on click outside or Escape
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleEscape);

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [onClose]);

    const renderNode = (type: WorkflowNodeType) => {
        const config = NODE_CONFIGS[type];
        const Icon = NODE_ICONS[type];
        const label = i18n._(config.label);

        return (
            <button
                className="hover:bg-muted/70 flex min-w-[52px] flex-col items-center gap-1.5 rounded-lg p-2 text-center transition-colors"
                key={type}
                onClick={() => onSelect(type)}
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
    };

    return (
        <div
            className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 fixed z-50 w-[280px] rounded-lg border p-2 shadow-lg"
            ref={menuRef}
            role="menu"
            style={{ left: position.x, top: position.y }}
        >
            {/* Suggested nodes */}
            {nodeList.suggested.length > 0 && (
                <>
                    <p className="text-muted-foreground mb-1.5 px-1 text-[10px] font-medium tracking-wide uppercase">
                        <Trans>Suggested</Trans>
                    </p>
                    <div className="mb-2 grid grid-cols-4 gap-1">{nodeList.suggested.map((type) => renderNode(type))}</div>
                    <div className="border-border/60 mb-2 border-t" />
                </>
            )}

            {/* All other nodes */}
            <p className="text-muted-foreground mb-1.5 px-1 text-[10px] font-medium tracking-wide uppercase">
                {nodeList.suggested.length > 0 ? <Trans>All nodes</Trans> : <Trans>Create & connect node</Trans>}
            </p>
            <div className="grid grid-cols-4 gap-1">{nodeList.rest.map((type) => renderNode(type))}</div>
        </div>
    );
};

export default ConnectionDropMenu;
