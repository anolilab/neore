import type { WorkflowContent, WorkflowNode, WorkflowNodeData } from "../types";

/**
 * A file-backed image is saved as its reference only: the display URL it resolves to
 * expires, so it must not be written into the workflow content.
 */
export const stripResolvedImageUrl = (node: WorkflowNode): WorkflowNode => {
    const { imageFileId, imageUrl } = node.data as { imageFileId?: string; imageUrl?: string };

    if (!imageFileId || imageUrl === undefined) {
        return node;
    }

    return { ...node, data: { ...node.data, imageUrl: undefined } as WorkflowNodeData };
};

/** The content as it is saved: no resolved image URL in any node. */
export const withoutResolvedImageUrls = (content: WorkflowContent): WorkflowContent => {
    return { ...content, nodes: content.nodes.map((node) => stripResolvedImageUrl(node)) };
};
