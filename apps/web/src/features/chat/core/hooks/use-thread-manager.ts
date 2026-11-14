/**
 * Thread manager hook - handles thread CRUD operations
 * Simplified to use navigation instead of state machine
 */

import { useLingui } from "@lingui/react/macro";
import type { ThreadDoc } from "@neore/backend/agent";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { shardOptionsFor } from "@neore/client-runtime";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { routeIsOn, survivingPaneAfterDelete } from "@/features/chat/split/split-layout-store";
import { trackEvent } from "@/lib/analytics";
import { providerLogger } from "@/lib/logger";
import { useCRPC, useLunora } from "@/lib/lunora/crpc";

import type { ThreadMetadata } from "../stores/thread-store";
import useThreadStore from "../stores/thread-store";
import useAllThreadsData from "./use-all-threads-data";

/**
 * Extended thread document type that includes parent thread relationship data.
 * The base ThreadDoc from lunora-agent doesn't include parentThreadIds as it's
 * stored in a separate relationship table, but queries may join this data.
 */
type ThreadDocument = ThreadDoc & {
    parentThreadIds?: string[];
};

export interface BranchNode {
    children: BranchNode[];
    depth: number;
    metadata: ThreadMetadata;
    threadId: string;
}

/**
 * Hook for thread management operations
 * Handles createBranch, deleteBranch, mergeBranch, getBranchTree, etc.
 * @param enabled If false, skips the Lunora queries to avoid unauthenticated errors
 */
export const useThreadManager = (enabled: boolean = true, currentThreadId?: string) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const crpc = useCRPC();
    const lunora = useLunora();
    const queryClient = useQueryClient();

    const threadMetadata = useThreadStore((state) => state.threadMetadata);
    const { addOptimisticDeletion, deleteThreadMetadata, removeOptimisticDeletion, setThreadMetadata } = useThreadStore(
        useShallow((state) => {
            return {
                addOptimisticDeletion: state.addOptimisticDeletion,
                deleteThreadMetadata: state.deleteThreadMetadata,
                removeOptimisticDeletion: state.removeOptimisticDeletion,
                setThreadMetadata: state.setThreadMetadata,
            };
        }),
    );

    const allThreadsData = useAllThreadsData(enabled);

    const { mutateAsync: branchThreadMutation } = useMutation(crpc.chat.functions.branchThread.mutationOptions());
    const { mutateAsync: deleteThreadMutation } = useMutation(crpc.chat.functions.softDeleteThread.mutationOptions());

    const getChildBranches = (threadId: string): string[] => {
        const children = new Set<string>();

        for (const [id, metadata] of threadMetadata.entries()) {
            if (metadata.parentThreadId === threadId) {
                children.add(id);
            }
        }

        const threads = allThreadsData?.lunora;

        if (threads) {
            for (const thread of threads) {
                if ((thread as ThreadDocument).parentThreadIds?.includes(threadId)) {
                    children.add(thread._id);
                }
            }
        }

        return [...children];
    };

    const getParentThread = (threadId: string): string | null => {
        const localMetadata = threadMetadata.get(threadId);

        if (localMetadata?.parentThreadId) {
            return localMetadata.parentThreadId;
        }

        const threads = allThreadsData?.lunora;

        if (threads) {
            const threadDocument = threads.find((thread) => thread._id === threadId) as ThreadDocument | undefined;

            return threadDocument?.parentThreadIds?.[0] || null;
        }

        return null;
    };

    /**
     * `fromMessageId` names the fork point exactly; without it the server
     * resolves `fromMessageIndex` along the displayed path. Neither forks the
     * whole thread (the thread list's "Create branch").
     */
    const createBranch = async (fromThreadId: string, fromMessageIndex: number | undefined, branchName?: string, fromMessageId?: string): Promise<string> => {
        if (fromMessageIndex !== undefined && fromMessageIndex < 0) {
            throw new Error(`Invalid message index ${fromMessageIndex}`);
        }

        // Thread ids arrive here as plain strings (route params, store keys, caller
        // arguments) but always name existing thread documents.
        const branchId = await branchThreadMutation({
            branchName,
            branchPoint: fromMessageIndex,
            messageId: fromMessageId,
            threadId: fromThreadId as Id<"threads">,
        });

        // Set metadata synchronously BEFORE navigation so the thread route has data immediately
        setThreadMetadata((previous) => {
            const next = new Map(previous);

            next.set(branchId, {
                branchPoint: fromMessageIndex,
                createdAt: new Date(),
                lastActivity: new Date(),
                parentThreadId: fromThreadId,
                status: "active",
                title: branchName || t`Branch`,
            });

            return next;
        });

        // Prime the TanStack Query cache so the thread route has instant data
        // `branchThread` returns the id of the thread it just created.
        queryClient.setQueryData(crpc.chat.functions.getThread.queryKey({ threadId: branchId as Id<"threads"> }), {
            _creationTime: Date.now(),
            _id: branchId,
            parentThreadIds: [fromThreadId],
            status: "active",
            title: branchName || t`Branch`,
        });

        const parentThread = allThreadsData?.lunora?.find((thread: ThreadDocument) => thread._id === fromThreadId);

        trackEvent("thread_branched", { parent_model: parentThread?.model });

        navigate({
            params: { threadId: branchId },
            to: "/chat/$threadId",
        });

        return branchId;
    };

    const deleteBranch = async (threadId: string): Promise<string[]> => {
        if (threadId === "default") {
            throw new Error("Cannot delete the default thread");
        }

        const childBranches = getChildBranches(threadId);
        // Each row settles on its own: a row whose delete failed reappears, one that was deleted stays hidden.
        const targets = [...childBranches, threadId];

        // Hidden at once, and shown again for any row the server refuses (an admin acting as the owner is refused).
        for (const id of targets) {
            addOptimisticDeletion(id);
        }

        const results = await Promise.allSettled(targets.map((id) => deleteThreadMutation({ threadId: id as Id<"threads"> })));
        const deletedIds: string[] = [];

        targets.forEach((id, index) => {
            const result = results[index];

            if (result?.status === "rejected") {
                providerLogger.error("[ThreadManager] Failed to delete thread", { error: result.reason, threadId: id });
                removeOptimisticDeletion(id);

                return;
            }

            // Local metadata goes only once the server has deleted the row.
            deleteThreadMetadata(id);
            deletedIds.push(id);
        });

        if (!deletedIds.includes(threadId)) {
            throw new Error("The thread was not deleted");
        }

        trackEvent("thread_deleted", {});

        if (currentThreadId === threadId) {
            // The survivor is read, then the route moves only if it still shows a deleted chat.
            // With the split view on, the other open panes stay: the route moves to one of them instead of `/chat`.
            void (async () => {
                const survivor = await survivingPaneAfterDelete(deletedIds, (id) => {
                    const args = { threadId: id as Id<"threads"> };

                    return lunora.query(api.chat.functions.getThread, args, shardOptionsFor(args));
                });

                if (!routeIsOn(deletedIds)) {
                    return;
                }

                navigate(survivor === undefined ? { replace: true, to: "/chat" } : { params: { threadId: survivor }, replace: true, to: "/chat/$threadId" });
            })();
        }

        // The thread first, then the branches deleted with it: what an undo restores.
        return [threadId, ...deletedIds.filter((id) => id !== threadId)];
    };

    const getBranchTree = (rootThreadId?: string): BranchNode[] => {
        const buildTree = (threadId: string, depth: number = 0): BranchNode => {
            let metadata = threadMetadata.get(threadId);

            const threads = allThreadsData?.lunora;

            if (!metadata && threads) {
                const threadDocument = threads.find((thread) => thread._id === threadId) as ThreadDocument | undefined;

                if (threadDocument) {
                    metadata = {
                        createdAt: new Date(threadDocument.createdAt ?? threadDocument._creationTime),
                        lastActivity: new Date(threadDocument.createdAt ?? threadDocument._creationTime),
                        parentThreadId: threadDocument.parentThreadIds?.[0],
                        status: threadDocument.status === "active" ? "active" : "archived",
                        title: threadDocument.title || t`Untitled Thread`,
                    };
                }
            }

            if (!metadata) {
                throw new Error(`Metadata not found for thread ${threadId}`);
            }

            const children = getChildBranches(threadId).map((childId) => buildTree(childId, depth + 1));

            return {
                children,
                depth,
                metadata,
                threadId,
            };
        };

        if (rootThreadId) {
            return [buildTree(rootThreadId)];
        }

        const rootThreads = new Set<string>();

        for (const [threadId, metadata] of threadMetadata.entries()) {
            if (!metadata.parentThreadId) {
                rootThreads.add(threadId);
            }
        }

        const threads = allThreadsData?.lunora;

        if (threads) {
            for (const thread of threads) {
                if (!(thread as ThreadDocument).parentThreadIds?.length) {
                    rootThreads.add(thread._id);
                }
            }
        }

        return [...rootThreads].map((threadId) => buildTree(threadId));
    };

    const getThreadPath = (threadId: string): string[] => {
        const path: string[] = [];
        let currentId: string | null = threadId;

        while (currentId) {
            path.unshift(currentId);
            currentId = getParentThread(currentId);
        }

        return path;
    };

    const getBranchSiblings = (threadId: string): string[] => {
        const metadata = threadMetadata.get(threadId);

        if (!metadata?.parentThreadId) {
            return [];
        }

        return getChildBranches(metadata.parentThreadId).filter((id) => id !== threadId);
    };

    const switchToBranch = async (threadId: string) => {
        setThreadMetadata((previous) => {
            const newMetadata = new Map(previous);
            const metadata = newMetadata.get(threadId);

            if (metadata) {
                newMetadata.set(threadId, {
                    ...metadata,
                    lastActivity: new Date(),
                });
            }

            return newMetadata;
        });

        navigate({
            params: { threadId },
            to: "/chat/$threadId",
        });
    };

    return {
        createBranch,
        deleteBranch,
        getBranchSiblings,
        getBranchTree,
        getChildBranches,
        getParentThread,
        getThreadPath,
        switchToBranch,
    };
};

export { type ThreadMetadata } from "../stores/thread-store";
