import type { Id } from "@neore/backend/dataModel";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../stores/workflow-store";
import type { WorkflowNode, WorkflowNodeData } from "../types";

const RETRY_AFTER_MS = 60 * 1000;
// `displayUrlExpiresInSeconds` (backend `lib/storage-ref.ts`) keeps a URL valid for at least 12 hours.
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
const REFRESH_CHECK_MS = 60 * 1000;

const imageRefOf = (node: WorkflowNode): { imageFileId?: string; imageUrl?: string } => node.data as { imageFileId?: string; imageUrl?: string };

/** The sorted, comma-joined file ids of nodes that have (or lack) a display URL: a stable selector result. */
const fileIdsKey = (nodes: WorkflowNode[], resolved: boolean): string => {
    const ids = new Set<string>();

    for (const node of nodes) {
        const { imageFileId, imageUrl } = imageRefOf(node);

        if (imageFileId && Boolean(imageUrl) === resolved) {
            ids.add(imageFileId);
        }
    }

    return [...ids].toSorted((a, b) => a.localeCompare(b)).join(",");
};

const splitKey = (key: string): string[] => (key ? key.split(",") : []);

/** Writes the resolved URL onto every node that keeps this file reference. */
const withResolvedUrl = (nodes: WorkflowNode[], imageFileId: string, url: string): WorkflowNode[] =>
    nodes.map((node) => {
        if (imageRefOf(node).imageFileId !== imageFileId) {
            return node;
        }

        return { ...node, data: { ...node.data, imageUrl: url } as WorkflowNodeData };
    });

const applyResolvedUrl = (imageFileId: string, url: string): void => {
    useWorkflowStore.setState((state) => {
        return { nodes: withResolvedUrl(state.nodes, imageFileId, url) };
    });
};

/**
 * Gives a file-backed image node a display URL when it has none (after an undo, a restore, or a
 * node copied without one), and replaces it before the signed URL can expire.
 * The URL goes into the store without marking the workflow dirty: it is not saved content.
 */
export const useResolveWorkflowImages = (): void => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const unresolvedKey = useWorkflowStore((state) => fileIdsKey(state.nodes, false));
    const resolvedKey = useWorkflowStore((state) => fileIdsKey(state.nodes, true));
    const inFlight = useRef(new Set<string>());
    const failedAt = useRef(new Map<string, number>());
    const resolvedAt = useRef(new Map<string, number>());

    useEffect(() => {
        const resolve = async (imageFileId: string): Promise<void> => {
            inFlight.current.add(imageFileId);

            try {
                const url = await queryClient.fetchQuery({
                    ...crpc.file.getChatFileImageUrl.queryOptions({ fileId: imageFileId as Id<"chatFiles"> }, { live: false }),
                    staleTime: 0,
                });

                if (url) {
                    failedAt.current.delete(imageFileId);
                    resolvedAt.current.set(imageFileId, Date.now());
                    applyResolvedUrl(imageFileId, url);
                } else {
                    failedAt.current.set(imageFileId, Date.now());
                }
            } catch {
                failedAt.current.set(imageFileId, Date.now());
            } finally {
                inFlight.current.delete(imageFileId);
            }
        };

        const run = (): void => {
            const now = Date.now();
            const isIdle = (imageFileId: string): boolean =>
                !inFlight.current.has(imageFileId) && now - (failedAt.current.get(imageFileId) ?? -Infinity) >= RETRY_AFTER_MS;
            const unresolved = splitKey(unresolvedKey);
            const resolved = splitKey(resolvedKey);

            for (const imageFileId of unresolved) {
                if (isIdle(imageFileId)) {
                    void resolve(imageFileId);
                }
            }

            for (const imageFileId of resolved) {
                const obtainedAt = resolvedAt.current.get(imageFileId);

                if (obtainedAt === undefined) {
                    resolvedAt.current.set(imageFileId, now);
                } else if (now - obtainedAt >= REFRESH_AFTER_MS && isIdle(imageFileId)) {
                    void resolve(imageFileId);
                }
            }
        };

        run();

        const timer = setInterval(run, REFRESH_CHECK_MS);

        return () => {
            clearInterval(timer);
        };
    }, [crpc, queryClient, unresolvedKey, resolvedKey]);
};
