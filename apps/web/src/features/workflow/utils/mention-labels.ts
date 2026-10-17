import type { MentionKind } from "@neore/backend/workflow/mentions";
import { mentionableSources } from "@neore/backend/workflow/mentions";

import type { WorkflowEdge, WorkflowNode } from "../types";

/**
 * The labels a prompt may mention with `@`: the direct upstream nodes that resolve to the given
 * kinds. The rules are the backend's (`mentionableSources`), so the editor offers exactly what a run
 * resolves. This adapter only narrows each node to the fields those rules read.
 */
export const mentionableLabels = (
    nodes: ReadonlyArray<WorkflowNode>,
    edges: ReadonlyArray<WorkflowEdge>,
    nodeId: string,
    kinds: ReadonlyArray<MentionKind> = ["text"],
): string[] =>
    mentionableSources(
        nodes.map((node) => {
            return { data: { label: node.data.label }, id: node.id, type: node.type ?? "" };
        }),
        edges,
        nodeId,
        kinds,
    ).map((candidate) => candidate.label);
