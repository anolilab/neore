/**
 * Workflow validation utilities.
 *
 * Validates node inputs before execution and detects circular dependencies.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { AINodeData, BranchNodeData, CodeNodeData, ImageNodeData, InpaintNodeData, WorkflowEdge, WorkflowNode, WorkflowNodeType } from "../types";

export interface ValidationError {
    /** Translatable — resolve with `i18n._(error.message)` where it is shown. */
    message: MessageDescriptor;
    nodeId: string;
    nodeLabel: string;
}

/**
 * Validate all nodes have their required fields filled in before execution.
 */
export function validateNodes(nodes: WorkflowNode[]): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const node of nodes) {
        if (node.type === "group" || node.type === "comment") continue;

        const label = (node.data as { label?: string }).label ?? node.type ?? "Unknown";

        switch (node.type as WorkflowNodeType) {
            case "ai": {
                const data = node.data as AINodeData;

                if (!data.model) {
                    errors.push({ message: msg`AI model must be selected`, nodeId: node.id, nodeLabel: label });
                }

                break;
            }
            case "branch": {
                const data = node.data as BranchNodeData;

                if (!data.condition?.trim()) {
                    errors.push({ message: msg`Branch condition is required`, nodeId: node.id, nodeLabel: label });
                }

                break;
            }
            case "code": {
                const data = node.data as CodeNodeData;

                if (!data.code?.trim()) {
                    errors.push({ message: msg`Code is required`, nodeId: node.id, nodeLabel: label });
                }

                break;
            }
            case "image": {
                const data = node.data as ImageNodeData;

                if (data.mode === "generate" && !data.prompt?.trim()) {
                    errors.push({ message: msg`Prompt is required for image generation`, nodeId: node.id, nodeLabel: label });
                }

                if (data.mode === "input" && !data.imageUrl) {
                    errors.push({ message: msg`Image URL or uploaded image required`, nodeId: node.id, nodeLabel: label });
                }

                break;
            }
            case "inpaint": {
                const data = node.data as InpaintNodeData;

                if (!data.prompt?.trim()) {
                    errors.push({ message: msg`Prompt is required for inpainting`, nodeId: node.id, nodeLabel: label });
                }

                break;
            }
            default: {
                break;
            }
        }
    }

    return errors;
}

/**
 * Detect circular dependencies in the workflow graph.
 * Returns the node IDs involved in cycles, or an empty array if none.
 */
export function detectCycles(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const adjacency = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    // Initialize
    for (const id of nodeIds) {
        adjacency.set(id, []);
        inDegree.set(id, 0);
    }

    // Build graph
    for (const edge of edges) {
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;

        adjacency.get(edge.source)!.push(edge.target);
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }

    // Kahn's algorithm — find all nodes with no dependencies
    const queue: string[] = [];

    for (const [id, degree] of inDegree) {
        if (degree === 0) queue.push(id);
    }

    const visited = new Set<string>();

    while (queue.length > 0) {
        const current = queue.shift()!;

        visited.add(current);

        const neighbours = adjacency.get(current) ?? [];

        for (const neighbor of neighbours) {
            const newDegree = (inDegree.get(neighbor) ?? 1) - 1;

            inDegree.set(neighbor, newDegree);

            if (newDegree === 0) queue.push(neighbor);
        }
    }

    // Nodes not visited are part of a cycle
    return [...nodeIds].filter((id) => !visited.has(id));
}
