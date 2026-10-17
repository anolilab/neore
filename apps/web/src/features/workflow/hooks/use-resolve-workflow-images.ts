import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useEffect, useRef } from "react";

import { useLunora } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../stores/workflow-store";
import type { WorkflowNode, WorkflowNodeData } from "../types";

/** Writes the resolved URL onto every node that keeps this file reference. */
const withResolvedUrl = (nodes: WorkflowNode[], imageFileId: string, url: string): WorkflowNode[] =>
    nodes.map((node) => {
        if ((node.data as { imageFileId?: string }).imageFileId !== imageFileId) {
            return node;
        }

        return { ...node, data: { ...node.data, imageUrl: url } as WorkflowNodeData };
    });

/**
 * Gives a file-backed image node a display URL when it has none (after an undo, a restore, or a
 * node copied without one). Each URL is fetched fresh: a signed URL expires, so none is cached.
 * The URL goes into the store without marking the workflow dirty: it is not saved content.
 */
export const useResolveWorkflowImages = (): void => {
    const lunora = useLunora();
    const nodes = useWorkflowStore((state) => state.nodes);
    const inFlight = useRef(new Set<string>());

    useEffect(() => {
        for (const node of nodes) {
            const { imageFileId, imageUrl } = node.data as { imageFileId?: string; imageUrl?: string };

            if (!imageFileId || imageUrl || inFlight.current.has(imageFileId)) {
                continue;
            }

            inFlight.current.add(imageFileId);

            void lunora
                .query(api.file.getChatFileImageUrl, { fileId: imageFileId as Id<"chatFiles"> })
                .then((url) => {
                    if (url) {
                        useWorkflowStore.setState((state) => {
                            return { nodes: withResolvedUrl(state.nodes, imageFileId, url) };
                        });
                    }

                    return undefined;
                })
                // The node stays without a picture; the next change to the graph retries it.
                .catch(() => undefined)
                .finally(() => {
                    inFlight.current.delete(imageFileId);
                });
        }
    }, [lunora, nodes]);
};
