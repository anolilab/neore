import { useWorkflowStore } from "../stores/workflow-store";

/** Media URL keys an upstream node's execution output may expose. */
interface UpstreamMediaOutput {
    image?: unknown;
    imageUrl?: unknown;
    url?: unknown;
}

/**
 * Extract the image URL from an upstream node's execution output.
 * Returns `undefined` if no upstream image is available.
 */
export function useUpstreamImageUrl(nodeId: string): string | undefined {
    // Narrow selectors: only the upstream edge's source and that node's output
    const sourceNodeId = useWorkflowStore((state) => {
        const edge = state.edges.find((e) => e.target === nodeId);

        return edge?.source;
    });

    const upstreamOutput = useWorkflowStore((state) => (sourceNodeId ? state.execution.nodeStates[sourceNodeId]?.output : undefined));

    if (typeof upstreamOutput === "string" && (upstreamOutput.startsWith("http") || upstreamOutput.startsWith("data:"))) {
        return upstreamOutput;
    }

    if (typeof upstreamOutput === "object" && upstreamOutput !== null) {
        const object = upstreamOutput as UpstreamMediaOutput;
        const url = (object.url ?? object.imageUrl ?? object.image) as string | undefined;

        if (typeof url === "string" && (url.startsWith("http") || url.startsWith("data:"))) {
            return url;
        }
    }

    return undefined;
}
