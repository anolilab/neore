import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import {
    AlertTriangle,
    AlignHorizontalDistributeCenter,
    AlignVerticalDistributeCenter,
    BoxSelect,
    Copy,
    Download,
    Eye,
    History,
    Keyboard,
    LayoutGrid,
    Loader2,
    Play,
    RotateCcw,
    Save,
    Square,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { alignSelectedNodes, applyAutoLayout, distributeSelectedNodes } from "../../hooks/use-workflow-shortcuts";
import { useWorkflowStore } from "../../stores/workflow-store";
import type { WorkflowContent } from "../../types";
import type { ValidationError } from "../../utils/validate-workflow";
import { detectCycles, validateNodes } from "../../utils/validate-workflow";
import PromptToWorkflowDialog from "../prompt-to-workflow-dialog";
import TemplatePicker from "../template-picker";
import VersionHistory from "../version-history";

/** Execution states from which the workflow may be started again. */
const RUNNABLE_STATUSES = new Set(["completed", "failed", "idle"]);

/** Status-dot colour per execution state; anything unlisted falls back to amber. */
const STATUS_DOT_CLASSES: Record<string, string> = {
    completed: "bg-green-500",
    failed: "bg-red-500",
    running: "animate-pulse bg-blue-500",
};

/** Display text for the execution status indicator. */
const STATUS_LABELS: Record<string, MessageDescriptor> = {
    cancelled: msg`Cancelled`,
    completed: msg`Completed`,
    failed: msg`Failed`,
    pending: msg`Pending`,
    running: msg`Running`,
};

/** Validation message for a node that is part of a cycle. */
const CYCLE_ERROR = msg`Part of a circular dependency`;

interface WorkflowControlsProps {
    onRun?: () => void;
    onSave?: () => void;
    onShowShortcuts?: () => void;
    onToggleHistory?: () => void;
    showHistory?: boolean;
}

const WorkflowControls = ({ onRun, onSave, onShowShortcuts, onToggleHistory, showHistory }: WorkflowControlsProps) => {
    const { i18n, t } = useLingui();
    const executionStatus = useWorkflowStore((state) => state.execution.status);
    const isDirty = useWorkflowStore((state) => state.isDirty);
    const resetExecution = useWorkflowStore((state) => state.resetExecution);
    const setExecutionStatus = useWorkflowStore((state) => state.setExecutionStatus);
    const groupNodes = useWorkflowStore((state) => state.groupNodes);
    const deleteNode = useWorkflowStore((state) => state.deleteNode);
    const duplicateNode = useWorkflowStore((state) => state.duplicateNode);
    const loadContent = useWorkflowStore((state) => state.loadContent);
    const getContent = useWorkflowStore((state) => state.getContent);
    const importFileRef = useRef<HTMLInputElement>(null);
    const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
    const selectNode = useWorkflowStore((state) => state.selectNode);

    // F8: Export workflow as JSON
    const handleExport = useCallback(() => {
        const content = getContent();
        const json = JSON.stringify(content, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");

        a.href = url;
        a.download = "workflow.json";
        a.click();
        URL.revokeObjectURL(url);
    }, [getContent]);

    // F8: Import workflow from JSON
    const handleImport = useCallback(
        async (e: React.ChangeEvent<HTMLInputElement>) => {
            const input = e.target;
            const file = input.files?.[0];

            if (!file) return;

            // Reset the input first so re-picking the same file fires onChange again.
            input.value = "";

            try {
                const content = JSON.parse(await file.text()) as WorkflowContent;

                if (content.nodes && content.edges) {
                    loadContent(content);
                }
            } catch {
                // Invalid JSON — silently ignore
            }
        },
        [loadContent],
    );

    // Use a count (primitive) so this selector never returns a new reference and
    // only triggers a re-render when the actual count changes.
    const selectedNonGroupCount = useWorkflowStore((state) => state.nodes.filter((n) => n.selected && n.type !== "group").length);
    const hasMultipleSelected = selectedNonGroupCount >= 2;
    const hasSelected = selectedNonGroupCount >= 1;

    const handleGroupSelected = () => {
        // Read fresh state at call-time to avoid stale closures
        const { nodes } = useWorkflowStore.getState();

        groupNodes(
            nodes.flatMap((n) => (n.selected && n.type !== "group" ? [n.id] : [])),
            t`Group`,
        );
    };

    const handleDeleteSelected = () => {
        const { nodes } = useWorkflowStore.getState();

        for (const n of nodes) {
            if (n.selected) {
                deleteNode(n.id);
            }
        }
    };

    const handleDuplicateSelected = () => {
        const { nodes } = useWorkflowStore.getState();
        const selected = nodes.filter((n) => n.selected && n.type !== "group");

        selected.forEach((n) => duplicateNode(n.id));
    };

    const isRunning = executionStatus === "running";
    const statusLabel: MessageDescriptor | undefined = STATUS_LABELS[executionStatus];
    const canRun = RUNNABLE_STATUSES.has(executionStatus);

    const handleRun = () => {
        const { edges, nodes } = useWorkflowStore.getState();

        // F3: Validate required fields
        const nodeErrors = validateNodes(nodes);

        // F4: Detect cycles
        const cycleNodeIds = detectCycles(nodes, edges);
        const cycleErrors: ValidationError[] = cycleNodeIds.map((nodeId) => {
            const node = nodes.find((n) => n.id === nodeId);

            return {
                message: CYCLE_ERROR,
                nodeId,
                nodeLabel: (node?.data as { label?: string })?.label ?? node?.type ?? "Unknown",
            };
        });

        const allErrors = [...nodeErrors, ...cycleErrors];

        if (allErrors.length > 0) {
            setValidationErrors(allErrors);

            return;
        }

        setValidationErrors([]);
        onRun?.();
    };

    const handleStop = () => {
        setExecutionStatus("cancelled");
    };

    const handleReset = () => {
        resetExecution();
    };

    // F9: Dry-run preview — show execution order without actually running
    const [isDryRunning, setIsDryRunning] = useState(false);
    const dryRunTimerRef = useRef<ReturnType<typeof setTimeout>[]>([]);

    const handleDryRun = useCallback(() => {
        const { edges, nodes } = useWorkflowStore.getState();
        const { setNodeExecutionStatus } = useWorkflowStore.getState();

        // Validate first
        const nodeErrors = validateNodes(nodes);
        const cycleNodeIds = detectCycles(nodes, edges);

        if (nodeErrors.length > 0 || cycleNodeIds.length > 0) {
            const cycleErrors: ValidationError[] = cycleNodeIds.map((nodeId) => {
                const node = nodes.find((n) => n.id === nodeId);

                return { message: CYCLE_ERROR, nodeId, nodeLabel: (node?.data as { label?: string })?.label ?? node?.type ?? "Unknown" };
            });

            setValidationErrors([...nodeErrors, ...cycleErrors]);

            return;
        }

        // Get topological order (Kahn's algorithm)
        const layoutNodes = nodes.filter((n) => n.type !== "group" && n.type !== "comment");
        const nodeIds = new Set(layoutNodes.map((n) => n.id));
        const inDegree = new Map<string, number>();
        const adjacency = new Map<string, string[]>();

        for (const id of nodeIds) {
            inDegree.set(id, 0);
            adjacency.set(id, []);
        }

        for (const edge of edges) {
            if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;

            adjacency.get(edge.source)!.push(edge.target);
            inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
        }

        const queue: string[] = [];

        for (const [id, deg] of inDegree) {
            if (deg === 0) queue.push(id);
        }

        const order: string[] = [];

        while (queue.length > 0) {
            const current = queue.shift()!;

            order.push(current);

            const neighbours = adjacency.get(current) ?? [];

            for (const next of neighbours) {
                const newDeg = (inDegree.get(next) ?? 1) - 1;

                inDegree.set(next, newDeg);

                if (newDeg === 0) queue.push(next);
            }
        }

        if (order.length === 0) return;

        // Clear any existing timers
        for (const timer of dryRunTimerRef.current) clearTimeout(timer);

        dryRunTimerRef.current = [];

        // Reset execution state first
        resetExecution();
        setIsDryRunning(true);

        // Set all to pending
        for (const id of order) {
            setNodeExecutionStatus(id, "pending");
        }

        // Animate through the execution order
        const stepDelay = 600;

        for (const [i, element] of order.entries()) {
            const nodeId = element!;

            // Mark as running
            const runTimer = setTimeout(() => {
                setNodeExecutionStatus(nodeId, "running");
            }, i * stepDelay);

            dryRunTimerRef.current.push(runTimer);

            // Mark as completed
            const completeTimer = setTimeout(
                () => {
                    setNodeExecutionStatus(nodeId, "completed");
                },
                i * stepDelay + stepDelay * 0.6,
            );

            dryRunTimerRef.current.push(completeTimer);
        }

        // Clean up after preview
        const cleanupTimer = setTimeout(
            () => {
                resetExecution();
                setIsDryRunning(false);
            },
            order.length * stepDelay + 1000,
        );

        dryRunTimerRef.current.push(cleanupTimer);
    }, [resetExecution, setValidationErrors]);

    // Cleanup timers on unmount
    useEffect(
        () => () => {
            for (const timer of dryRunTimerRef.current) clearTimeout(timer);
        },
        [],
    );

    return (
        <div className="absolute top-4 right-4 z-10">
            <div className="bg-background/95 flex items-center gap-2 rounded-lg border p-2 shadow-lg backdrop-blur-sm">
                {/* Template picker */}
                <TemplatePicker />

                {/* AI Generate */}
                <PromptToWorkflowDialog />

                {/* Export / Import */}
                <input accept=".json" className="hidden" onChange={handleImport} ref={importFileRef} type="file" />
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button className="size-8" onClick={() => importFileRef.current?.click()} size="icon" variant="ghost">
                                <Upload aria-hidden="true" className="size-4" />
                            </Button>
                        }
                    />
                    <TooltipContent>
                        <p>
                            <Trans>Import workflow (JSON)</Trans>
                        </p>
                    </TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button className="size-8" onClick={handleExport} size="icon" variant="ghost">
                                <Download aria-hidden="true" className="size-4" />
                            </Button>
                        }
                    />
                    <TooltipContent>
                        <p>
                            <Trans>Export workflow (JSON)</Trans>
                        </p>
                    </TooltipContent>
                </Tooltip>

                {/* Auto-layout */}
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button className="size-8" onClick={() => applyAutoLayout()} size="icon" variant="ghost">
                                <LayoutGrid aria-hidden="true" className="size-4" />
                            </Button>
                        }
                    />
                    <TooltipContent>
                        <p>
                            <Trans>Auto-layout (L)</Trans>
                        </p>
                    </TooltipContent>
                </Tooltip>

                {/* Keyboard shortcuts help */}
                {onShowShortcuts && (
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button className="size-8" onClick={onShowShortcuts} size="icon" variant="ghost">
                                    <Keyboard aria-hidden="true" className="size-4" />
                                </Button>
                            }
                        />
                        <TooltipContent>
                            <p>
                                <Trans>Keyboard shortcuts (?)</Trans>
                            </p>
                        </TooltipContent>
                    </Tooltip>
                )}

                <div className="bg-border h-6 w-px" />

                {/* Version history with undo/redo */}
                <VersionHistory />

                <div className="bg-border h-6 w-px" />

                {/* Save indicator / button */}
                {onSave && (
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button disabled={!isDirty} onClick={onSave} size="sm" variant={isDirty ? "default" : "ghost"}>
                                    <Save className="mr-1.5 size-4" />
                                    {isDirty ? <Trans>Save</Trans> : <Trans>Saved</Trans>}
                                </Button>
                            }
                        />
                        <TooltipContent>
                            <p>{isDirty ? <Trans>Save changes</Trans> : <Trans>All changes saved</Trans>}</p>
                        </TooltipContent>
                    </Tooltip>
                )}

                {/* Multi-select actions */}
                {hasSelected && (
                    <>
                        <div className="bg-border h-6 w-px" />

                        {/* Duplicate selected */}
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button className="size-8" onClick={handleDuplicateSelected} size="icon" variant="ghost">
                                        <Copy className="size-4" />
                                    </Button>
                                }
                            />
                            <TooltipContent>
                                <p>
                                    <Trans>Duplicate selected ({selectedNonGroupCount})</Trans>
                                </p>
                            </TooltipContent>
                        </Tooltip>

                        {/* Delete selected */}
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button className="size-8" onClick={handleDeleteSelected} size="icon" variant="ghost">
                                        <Trash2 className="size-4" />
                                    </Button>
                                }
                            />
                            <TooltipContent>
                                <p>
                                    <Trans>Delete selected ({selectedNonGroupCount})</Trans>
                                </p>
                            </TooltipContent>
                        </Tooltip>

                        {hasMultipleSelected && (
                            <>
                                {/* Group selected */}
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <Button className="size-8" onClick={handleGroupSelected} size="icon" variant="ghost">
                                                <BoxSelect className="size-4" />
                                            </Button>
                                        }
                                    />
                                    <TooltipContent>
                                        <p>
                                            <Trans>Group ({selectedNonGroupCount})</Trans>
                                        </p>
                                    </TooltipContent>
                                </Tooltip>

                                {/* Align horizontal */}
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <Button className="size-8" onClick={() => alignSelectedNodes("horizontal")} size="icon" variant="ghost">
                                                <AlignHorizontalDistributeCenter className="size-4" />
                                            </Button>
                                        }
                                    />
                                    <TooltipContent>
                                        <p>
                                            <Trans>Align horizontally (H)</Trans>
                                        </p>
                                    </TooltipContent>
                                </Tooltip>

                                {/* Align vertical */}
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <Button className="size-8" onClick={() => alignSelectedNodes("vertical")} size="icon" variant="ghost">
                                                <AlignVerticalDistributeCenter className="size-4" />
                                            </Button>
                                        }
                                    />
                                    <TooltipContent>
                                        <p>
                                            <Trans>Align vertically (V)</Trans>
                                        </p>
                                    </TooltipContent>
                                </Tooltip>

                                {/* Distribute */}
                                {selectedNonGroupCount >= 3 && (
                                    <Tooltip>
                                        <TooltipTrigger
                                            render={
                                                <Button className="size-8" onClick={() => distributeSelectedNodes()} size="icon" variant="ghost">
                                                    <AlignHorizontalDistributeCenter className="size-4 rotate-90" />
                                                </Button>
                                            }
                                        />
                                        <TooltipContent>
                                            <p>
                                                <Trans>Distribute evenly (D)</Trans>
                                            </p>
                                        </TooltipContent>
                                    </Tooltip>
                                )}
                            </>
                        )}
                    </>
                )}

                {/* Execution history toggle */}
                {onToggleHistory && (
                    <>
                        <div className="bg-border h-6 w-px" />
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button className="size-8" onClick={onToggleHistory} size="icon" variant={showHistory ? "default" : "ghost"}>
                                        <History className="size-4" />
                                    </Button>
                                }
                            />
                            <TooltipContent>
                                <p>{showHistory ? <Trans>Hide run history</Trans> : <Trans>Show run history</Trans>}</p>
                            </TooltipContent>
                        </Tooltip>
                    </>
                )}

                {/* Execution controls */}
                <div className="bg-border h-6 w-px" />

                {isRunning ? (
                    <>
                        <Button onClick={handleStop} size="sm" variant="destructive">
                            <Square className="mr-1.5 size-4" />
                            <Trans>Stop</Trans>
                        </Button>
                        <div className="text-muted-foreground flex items-center gap-1.5 px-2 text-sm">
                            <Loader2 className="size-4 animate-spin" />
                            <Trans>Running...</Trans>
                        </div>
                    </>
                ) : (
                    <>
                        {/* Dry-run preview */}
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button disabled={!canRun || isDryRunning} onClick={handleDryRun} size="sm" variant="outline">
                                        <Eye className="mr-1.5 size-4" />
                                        <Trans>Preview</Trans>
                                    </Button>
                                }
                            />
                            <TooltipContent>
                                <p>
                                    <Trans>Preview execution order (dry run)</Trans>
                                </p>
                            </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button disabled={!canRun || isDryRunning} onClick={handleRun} size="sm" variant="default">
                                        <Play className="mr-1.5 size-4" />
                                        <Trans>Run</Trans>
                                    </Button>
                                }
                            />
                            <TooltipContent>
                                <p>
                                    <Trans>Execute workflow</Trans>
                                </p>
                            </TooltipContent>
                        </Tooltip>

                        {(executionStatus === "completed" || executionStatus === "failed") && (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <Button className="size-8" onClick={handleReset} size="icon" variant="ghost">
                                            <RotateCcw className="size-4" />
                                        </Button>
                                    }
                                />
                                <TooltipContent>
                                    <p>
                                        <Trans>Reset execution state</Trans>
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </>
                )}

                {/* Status indicator */}
                {executionStatus !== "idle" && (
                    <>
                        <div className="bg-border h-6 w-px" />
                        <div className="flex items-center gap-1.5 px-2">
                            <div className={`size-2 rounded-full ${STATUS_DOT_CLASSES[executionStatus] ?? "bg-yellow-500"}`} />
                            <span className="text-muted-foreground text-xs capitalize">{statusLabel ? i18n._(statusLabel) : executionStatus}</span>
                        </div>
                    </>
                )}
            </div>

            {/* Validation errors panel */}
            {validationErrors.length > 0 && (
                <div className="bg-destructive/10 border-destructive/30 mt-2 max-w-sm rounded-lg border p-3" role="alert">
                    <div className="mb-2 flex items-center justify-between">
                        <div className="text-destructive flex items-center gap-1.5 text-xs font-medium">
                            <AlertTriangle aria-hidden="true" className="size-3.5" />
                            <Plural one="# issue found" other="# issues found" value={validationErrors.length} />
                        </div>
                        <button
                            aria-label={t`Dismiss errors`}
                            className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
                            onClick={() => setValidationErrors([])}
                            type="button"
                        >
                            <X className="size-3.5" />
                        </button>
                    </div>
                    <ul className="space-y-1">
                        {validationErrors.map((error) => (
                            <li key={`${error.nodeId}-${error.message.id}`}>
                                <button
                                    className="text-muted-foreground hover:text-foreground w-full text-left text-xs transition-colors"
                                    onClick={() => selectNode(error.nodeId)}
                                    type="button"
                                >
                                    <span className="text-foreground font-medium">{error.nodeLabel}</span>: {i18n._(error.message)}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};

export default WorkflowControls;
