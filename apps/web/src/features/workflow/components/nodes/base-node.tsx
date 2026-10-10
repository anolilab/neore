import { Trans, useLingui } from "@lingui/react/macro";
import { Node, NodeAction, NodeContent, NodeDescription, NodeFooter, NodeHeader, NodeTitle } from "@ui/components/ai-elements/node";
import cn from "@ui/utils/cn";
import type { Node as ReactFlowNode, NodeProps as ReactFlowNodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { CheckCircle2, Copy, GripVertical, Loader2, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { useWorkflowCollab } from "../../contexts";
import { useWorkflowStore } from "../../stores/workflow-store";
import type { NodeExecutionStatus, WorkflowNodeData, WorkflowNodeType } from "../../types";
import { NodeLockIndicator, NodeSelectionRing } from "../collab/node-lock-indicator";
import NodeConnectButton from "./node-connect-button";
import NodeTopToolbar from "./node-top-toolbar";

export interface BaseNodeProps extends ReactFlowNodeProps<ReactFlowNode<WorkflowNodeData>> {
    children?: ReactNode;
    color: string;
    footer?: ReactNode;
    icon: ReactNode;
    inputs?: number;
    /** The semantic node type – used to drive the toolbar's contextual controls */
    nodeType?: WorkflowNodeType;
    outputs?: number;
}

const statusColors: Record<NodeExecutionStatus, string> = {
    completed: "border-green-500",
    failed: "border-red-500",
    idle: "border-border",
    pending: "border-yellow-500/50",
    running: "border-blue-500 animate-pulse",
    skipped: "border-gray-400",
};

/**
 * Shape a node's execution output is probed for. Node outputs are provider-defined,
 * so every key is optional and narrowed at the point of use.
 */
interface NodeOutputObject {
    content?: unknown;
    image?: unknown;
    imageUrl?: unknown;
    output?: unknown;
    result?: unknown;
    src?: unknown;
    text?: unknown;
    url?: unknown;
}

/** Inline preview of a node's execution output. */
const NodeOutputPreview = ({ output }: { output: unknown }) => {
    const { t } = useLingui();

    if (output === null || output === undefined) return null;

    // Image URL output — render inline preview
    if (typeof output === "string" && (output.startsWith("http") || output.startsWith("data:image"))) {
        return (
            <div className="mt-1 overflow-hidden rounded">
                <img alt={t`Node output`} className="max-h-[160px] w-full object-contain" src={output} />
            </div>
        );
    }

    // String output — show truncated text
    if (typeof output === "string") {
        return (
            <div className="bg-muted mt-1 max-h-[80px] overflow-y-auto rounded p-1.5 text-[11px] leading-tight break-words">
                {output.length > 300 ? `${output.slice(0, 300)}…` : output}
            </div>
        );
    }

    // Object output with image URL property
    if (typeof output === "object" && output !== null) {
        const object = output as NodeOutputObject;

        // Check for common image URL patterns
        const imageUrl = object.url ?? object.imageUrl ?? object.image ?? object.src;

        if (typeof imageUrl === "string" && (imageUrl.startsWith("http") || imageUrl.startsWith("data:image"))) {
            return (
                <div className="mt-1 overflow-hidden rounded">
                    <img alt={t`Node output`} className="max-h-[160px] w-full object-contain" src={imageUrl} />
                </div>
            );
        }

        // Check for text content
        const text = object.text ?? object.content ?? object.result ?? object.output;

        if (typeof text === "string") {
            return (
                <div className="bg-muted mt-1 max-h-[80px] overflow-y-auto rounded p-1.5 text-[11px] leading-tight break-words">
                    {text.length > 300 ? `${text.slice(0, 300)}…` : text}
                </div>
            );
        }
    }

    // Fallback: JSON
    const jsonString = JSON.stringify(output, null, 2);

    return (
        <div className="bg-muted mt-1 max-h-[80px] overflow-y-auto rounded p-1.5 font-mono text-[10px] leading-tight break-words">
            {jsonString.length > 300 ? `${jsonString.slice(0, 300)}…` : jsonString}
        </div>
    );
};

const BaseNode = ({ children, color, data, footer, icon, id, inputs = 1, nodeType, outputs = 1, selected, type }: BaseNodeProps) => {
    const deleteNode = useWorkflowStore((state) => state.deleteNode);
    const duplicateNode = useWorkflowStore((state) => state.duplicateNode);
    const selectNode = useWorkflowStore((state) => state.selectNode);
    const { t } = useLingui();
    // Collaboration context (null if not in collab mode)
    const collab = useWorkflowCollab();
    // Pre-existing React Flow v12 generic issue: id/data come through as `unknown`
    // from the ReactFlowNodeProps constraint mismatch; cast to known types.
    const nodeId = id as string;
    const nodeData = data as WorkflowNodeData;
    const isSelected = selected as boolean | undefined;

    const nodeEditor = collab?.getNodeEditor(nodeId) ?? null;
    const nodeSelector = collab?.getNodeSelector(nodeId) ?? null;
    const isLockedByOther = nodeEditor !== null;

    // Narrow selector: only re-render when THIS node's execution state changes
    const nodeState = useWorkflowStore((state) => state.execution.nodeStates[nodeId]);
    const nodeStatus = (nodeState?.status ?? "idle") as NodeExecutionStatus;
    const nodeError = nodeState?.error;
    const nodeOutput = nodeState?.output;
    const [showOutput, setShowOutput] = useState(false);
    const isUserLocked = (nodeData as WorkflowNodeData & { locked?: boolean }).locked ?? false;
    const isLocked = isLockedByOther || isUserLocked;

    // Resolve the semantic node type (prefer explicit prop, fall back to ReactFlow's `type`)
    const resolvedNodeType = nodeType ?? (type as WorkflowNodeType | undefined);

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();

        if (isLocked) {
            return;
        }

        deleteNode(nodeId);
    };

    const handleDuplicate = (e: React.MouseEvent) => {
        e.stopPropagation();
        duplicateNode(nodeId);
    };

    return (
        <>
            {/* Floating toolbar – animates in/out when the node is selected */}
            {resolvedNodeType && <NodeTopToolbar data={nodeData} nodeId={nodeId} nodeType={resolvedNodeType} selected={isSelected} />}

            {/* Side connect buttons – animate in/out with selection */}
            {resolvedNodeType && (
                <>
                    <NodeConnectButton disabled={inputs === 0} nodeId={nodeId} selected={isSelected} side="left" />
                    <NodeConnectButton disabled={outputs === 0} nodeId={nodeId} selected={isSelected} side="right" />
                </>
            )}

            <Node
                className={cn(
                    "relative min-w-[280px] transition-all duration-200",
                    statusColors[nodeStatus],
                    isSelected && "ring-primary ring-2 ring-offset-2",
                    isLockedByOther && "opacity-75",
                )}
                handles={{ source: false, target: false }}
                onClick={() => selectNode(nodeId)}
            >
                {/* Collaboration indicators */}
                {nodeEditor && <NodeLockIndicator lockedBy={nodeEditor} />}
                {nodeSelector && !nodeEditor && <NodeSelectionRing selectedBy={nodeSelector} />}

                {/* Input handles */}
                {inputs > 0 &&
                    Array.from({ length: inputs }, (_, i) => (
                        <Handle
                            className="!bg-muted-foreground !border-background !h-3 !w-3"
                            id={`input-${i}`}
                            key={`input-${i}`}
                            position={Position.Left}
                            style={{
                                top: inputs === 1 ? "50%" : `${((i + 1) / (inputs + 1)) * 100}%`,
                            }}
                            type="target"
                        />
                    ))}

                {/* Output handles */}
                {outputs > 0 &&
                    Array.from({ length: outputs }, (_, i) => (
                        <Handle
                            className="!bg-muted-foreground !border-background !h-3 !w-3"
                            id={`output-${i}`}
                            key={`output-${i}`}
                            position={Position.Right}
                            style={{
                                top: outputs === 1 ? "50%" : `${((i + 1) / (outputs + 1)) * 100}%`,
                            }}
                            type="source"
                        />
                    ))}

                <NodeHeader className="cursor-grab active:cursor-grabbing">
                    <div className="flex items-center gap-2">
                        <div className="flex size-6 items-center justify-center rounded" style={{ backgroundColor: `${color}20`, color }}>
                            {icon}
                        </div>
                        <div className="flex-1">
                            <NodeTitle className="text-sm font-medium">{nodeData.label}</NodeTitle>
                            {nodeData.description && <NodeDescription className="text-xs">{nodeData.description}</NodeDescription>}
                        </div>
                        <GripVertical className="text-muted-foreground size-4" />
                    </div>
                    <NodeAction className="flex gap-1">
                        <button
                            aria-label={t`Duplicate node`}
                            className="hover:bg-muted text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
                            onClick={handleDuplicate}
                            title={t`Duplicate node`}
                            type="button"
                        >
                            <Copy className="size-3.5" />
                        </button>
                        <button
                            aria-label={isLocked ? t`Node is locked` : t`Delete node`}
                            className="hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded p-1 transition-colors disabled:pointer-events-none disabled:opacity-40"
                            disabled={isLocked}
                            onClick={handleDelete}
                            title={isLocked ? t`Node is locked` : t`Delete node`}
                            type="button"
                        >
                            <Trash2 className="size-3.5" />
                        </button>
                    </NodeAction>
                </NodeHeader>

                {children && (
                    // Stop keyboard events (Backspace/Delete) from bubbling to the React Flow
                    // canvas, which would otherwise delete the selected node while typing.
                    <NodeContent className="p-3" onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}>
                        {children}
                    </NodeContent>
                )}

                {(footer || nodeError || nodeOutput !== undefined || nodeStatus === "running") && (
                    <NodeFooter className="p-2">
                        {/* Execution status indicator */}
                        {nodeStatus === "running" && (
                            <div className="flex items-center gap-1.5 text-xs text-blue-500">
                                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                                <span>
                                    <Trans>Running...</Trans>
                                </span>
                            </div>
                        )}
                        {nodeStatus === "completed" && nodeOutput !== undefined && (
                            <div className="space-y-1">
                                <button
                                    className="flex w-full items-center gap-1.5 text-xs text-green-600 dark:text-green-400"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        setShowOutput((v) => !v);
                                    }}
                                    type="button"
                                >
                                    <CheckCircle2 aria-hidden="true" className="size-3 shrink-0" />
                                    <span className="flex-1 text-left">{showOutput ? <Trans>Hide output</Trans> : <Trans>Show output</Trans>}</span>
                                </button>
                                {showOutput && <NodeOutputPreview output={nodeOutput} />}
                            </div>
                        )}
                        {nodeError && <div className="text-destructive truncate text-xs">{nodeError}</div>}
                        {footer}
                    </NodeFooter>
                )}
            </Node>
        </>
    );
};

export default BaseNode;
