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
 * Gives every file-backed image node a display URL. The node keeps only its `imageFileId`
 * (see `stripResolvedImageUrl`), so the URL is fetched when the canvas shows the node and is
 * written to the store without marking the workflow dirty: it is not part of the saved content.
 */
export const useResolveWorkflowImages = (): void => {
    const lunora = useLunora();
    const nodes = useWorkflowStore((state) => state.nodes);
    const requested = useRef(new Map<string, string | undefined>());

    useEffect(() => {
        for (const node of nodes) {
            const { imageFileId, imageUrl } = node.data as { imageFileId?: string; imageUrl?: string };

            if (!imageFileId || imageUrl) {
                continue;
            }

            if (requested.current.has(imageFileId)) {
                const cached = requested.current.get(imageFileId);

                if (cached) {
                    useWorkflowStore.setState((state) => {
                        return { nodes: withResolvedUrl(state.nodes, imageFileId, cached) };
                    });
                }

                continue;
            }

            requested.current.set(imageFileId, undefined);

            void lunora
                .query(api.file.getChatFileImageUrl, { fileId: imageFileId as Id<"chatFiles"> })
                .then((url) => {
                    if (url) {
                        requested.current.set(imageFileId, url);
                        useWorkflowStore.setState((state) => {
                            return { nodes: withResolvedUrl(state.nodes, imageFileId, url) };
                        });
                    }

                    return undefined;
                })
                .catch(() => {
                    requested.current.delete(imageFileId);
                });
        }
    }, [lunora, nodes]);
};
