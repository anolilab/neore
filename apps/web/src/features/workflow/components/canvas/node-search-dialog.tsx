/**
 * Node Search / Command Palette
 *
 * Fuzzy search over all workflow node types. Triggered by Cmd+K.
 * Selecting a node type creates it at the center of the viewport.
 */
import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { useReactFlow } from "@xyflow/react";
import {
    BoxSelect,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useWorkflowStore } from "../../stores/workflow-store";
import type { WorkflowNodeType } from "../../types";
import NODE_CONFIGS from "../../types";

interface NodeSearchDialogProps {
    onClose: () => void;
    open: boolean;
}

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
    group: BoxSelect,
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

const ALL_TYPES = Object.keys(NODE_CONFIGS) as WorkflowNodeType[];

const NodeSearchDialogContent = ({ onClose }: Omit<NodeSearchDialogProps, "open">) => {
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const addNode = useWorkflowStore((state) => state.addNode);
    const selectNode = useWorkflowStore((state) => state.selectNode);
    const { getViewport } = useReactFlow();
    const { i18n, t } = useLingui();

    // Filter and sort results
    const results = useMemo(() => {
        if (!query.trim()) return ALL_TYPES;

        const q = query.toLowerCase();

        return ALL_TYPES.filter((type) => {
            const config = NODE_CONFIGS[type];

            return type.toLowerCase().includes(q) || i18n._(config.label).toLowerCase().includes(q) || i18n._(config.description).toLowerCase().includes(q);
        });
    }, [query, i18n]);

    // Reset the highlighted row when the result set changes. Adjusting during render keeps the
    // selection consistent with what is painted instead of correcting it a frame later.
    const [trackedResults, setTrackedResults] = useState(results);

    if (trackedResults !== results) {
        setTrackedResults(results);
        setSelectedIndex(0);
    }

    // Focus input on mount (the dialog is only mounted while open).
    useEffect(() => {
        const focusFrame = requestAnimationFrame(() => inputRef.current?.focus());

        return () => cancelAnimationFrame(focusFrame);
    }, []);

    // Scroll selected into view
    useEffect(() => {
        const list = listRef.current;

        if (!list) return;

        const item = list.children[selectedIndex] as HTMLElement | undefined;

        item?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    const handleSelect = useCallback(
        (type: WorkflowNodeType) => {
            const vp = getViewport();
            // Place at visible center
            const x = -vp.x / vp.zoom + 400;
            const y = -vp.y / vp.zoom + 300;
            const nodeId = addNode(type, { x, y }, { label: i18n._(NODE_CONFIGS[type].defaultLabel) });

            selectNode(nodeId);
            onClose();
        },
        [addNode, selectNode, getViewport, onClose, i18n],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            switch (e.key) {
                case "ArrowDown": {
                    e.preventDefault();
                    setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
                    break;
                }
                case "ArrowUp": {
                    e.preventDefault();
                    setSelectedIndex((i) => Math.max(i - 1, 0));
                    break;
                }
                case "Enter": {
                    e.preventDefault();
                    const selected = results[selectedIndex];

                    if (selected) handleSelect(selected);

                    break;
                }
                case "Escape": {
                    e.preventDefault();
                    onClose();
                    break;
                }
                default: {
                    break;
                }
            }
        },
        [results, selectedIndex, handleSelect, onClose],
    );

    return (
        <>
            {/* Backdrop */}
            <button aria-label={t`Close node search`} className="fixed inset-0 z-50 cursor-default bg-black/20" onClick={onClose} tabIndex={-1} type="button" />

            {/* Dialog */}
            <div className="bg-popover fixed top-[20%] left-1/2 z-50 w-[380px] -translate-x-1/2 overflow-hidden rounded-xl border shadow-2xl">
                {/* Search input */}
                <div className="border-b px-3 py-2">
                    <label className="block" htmlFor="workflow-node-search">
                        <span className="sr-only">
                            <Trans>Search nodes</Trans>
                        </span>
                        <input
                            className="text-foreground placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
                            id="workflow-node-search"
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={t`Search nodes...`}
                            ref={inputRef}
                            type="text"
                            value={query}
                        />
                    </label>
                </div>

                {/* Results */}
                <div className="max-h-[320px] overflow-y-auto p-1" ref={listRef}>
                    {results.length === 0 ? (
                        <p className="text-muted-foreground px-3 py-4 text-center text-sm">
                            <Trans>No matching nodes</Trans>
                        </p>
                    ) : (
                        results.map((type, index) => {
                            const config = NODE_CONFIGS[type];
                            const Icon = NODE_ICONS[type];

                            return (
                                <button
                                    className={cn(
                                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                                        index === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
                                    )}
                                    key={type}
                                    onClick={() => handleSelect(type)}
                                    onMouseEnter={() => setSelectedIndex(index)}
                                    type="button"
                                >
                                    <div
                                        className="flex size-7 shrink-0 items-center justify-center rounded-md"
                                        style={{ backgroundColor: `${config.color}18`, color: config.color }}
                                    >
                                        <Icon className="size-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium">{i18n._(config.label)}</div>
                                        <div className="text-muted-foreground truncate text-xs">{i18n._(config.description)}</div>
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>

                {/* Footer hint */}
                <div className="text-muted-foreground flex items-center gap-3 border-t px-3 py-1.5 text-[10px]">
                    <span>
                        <Trans>
                            <kbd className="rounded border px-1">↑↓</kbd> Navigate
                        </Trans>
                    </span>
                    <span>
                        <Trans>
                            <kbd className="rounded border px-1">Enter</kbd> Create
                        </Trans>
                    </span>
                    <span>
                        <Trans>
                            <kbd className="rounded border px-1">Esc</kbd> Close
                        </Trans>
                    </span>
                </div>
            </div>
        </>
    );
};

const NodeSearchDialog = ({ onClose, open }: NodeSearchDialogProps) => (open ? <NodeSearchDialogContent onClose={onClose} /> : null);

export default NodeSearchDialog;
