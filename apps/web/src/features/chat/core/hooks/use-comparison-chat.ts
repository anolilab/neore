"use client";

/**
 * useComparisonChat - Hook for managing multi-model comparison chat
 *
 * Handles:
 * - Creating comparison parent thread and child model threads
 * - Sending messages to multiple models in parallel
 * - Tracking streaming state for each model
 * - Managing thread relationships
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import env from "@/lib/env";
import { useCRPC } from "@/lib/lunora/crpc";

import type { ComparisonBranch } from "../../thread/comparison-view";
import type { PendingAttachment } from "../stores/chat-ui-store";
import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";

/** Chat stream endpoint — all requests go through the LLM Gateway */
const CHAT_STREAM_URL = `${env.VITE_LLM_GATEWAY_URL}/v1/chat`;

export interface ComparisonState {
    /** Child threads for each model */
    branches: ComparisonBranch[];
    /** Whether this is a comparison thread */
    isComparisonThread: boolean;
    /** Whether comparison is currently streaming */
    isStreaming: boolean;
    /** Parent comparison thread ID */
    parentThreadId: string | null;
}

interface UseComparisonChatOptions {
    jwtToken: string;
    /** Existing parent thread ID (if resuming a comparison) */
    parentThreadId?: string;
}

interface UseComparisonChatReturn {
    /** Whether comparison mode is enabled */
    comparisonMode: boolean;
    /** Loading state */
    isLoading: boolean;
    /** Selected models for comparison */
    selectedModels: ModelId[];
    /** Send a message to all selected models (creates new child threads) */
    sendComparisonMessage: (text: string, models: ModelId[], attachments?: PendingAttachment[]) => Promise<void>;
    /** Send a follow-up message to existing child threads (no thread creation) */
    sendToExistingChildren: (text: string, children: { model: string; threadId: string }[], attachments?: PendingAttachment[]) => Promise<void>;
    /** Current comparison state */
    state: ComparisonState;
}

const useComparisonChat = ({ jwtToken, parentThreadId }: UseComparisonChatOptions): UseComparisonChatReturn => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const navigate = useNavigate();

    // Model store state
    const comparisonMode = useModelStore((state) => state.comparisonMode);
    const selectedModels = useModelStore((state) => state.selectedModelsForComparison);
    const getPendingSettings = useModelStore((state) => state.getPendingSettings);

    // clearComposer is only called inside an async callback, not in render output,
    // so access it via getState() to avoid an unnecessary store subscription.

    // Local state
    const [isLoading, setIsLoading] = useState(false);
    const [parentThread, setParentThread] = useState<string | null>(parentThreadId ?? null);
    const [branches, setBranches] = useState<ComparisonBranch[]>([]);

    // Mutations
    const { mutateAsync: createThreadMutation } = useMutation(crpc.chat.functions.createThread.mutationOptions());
    const { mutateAsync: createRelationshipMutation } = useMutation(crpc.chat.functions.createThreadRelationshipPublic.mutationOptions());

    // Check if any branch is streaming
    const isStreaming = useMemo(() => branches.some((b) => b.isLoading || !!b.activeStreamId), [branches]);

    // Cheap boolean derived from two primitives — no useMemo overhead needed (rerender-simple-expression-in-memo).
    const isComparisonThread = !!parentThread && branches.length > 0;

    /**
     * Send a message to multiple models in parallel
     */
    const sendComparisonMessage = useCallback(
        async (text: string, models: ModelId[], attachments?: PendingAttachment[]) => {
            if (models.length < 2) {
                console.error("[useComparisonChat] Not enough models selected");

                return;
            }

            setIsLoading(true);

            const comparisonTitle = t`Model Comparison`;

            try {
                const pendingSettings = getPendingSettings();

                // Create parent comparison thread if it doesn't exist
                let comparisonParentId = parentThread;

                if (!comparisonParentId) {
                    comparisonParentId = await createThreadMutation({
                        branchName: comparisonTitle,
                        customSystemPrompt: pendingSettings?.customSystemPrompt,
                        language: pendingSettings?.language,
                        model: models[0] ?? "unknown",
                        multiChat: true, // Flag for instant detection without querying children
                    });
                    setParentThread(comparisonParentId);
                }

                // Prepare file IDs from attachments
                const fileIds = attachments?.flatMap((a) => (a.status === "complete" && typeof a.fileId === "string" && a.fileId.length > 0 ? [a.fileId] : []));

                // Create child threads and send messages in parallel
                const branchPromises = models.map(async (model): Promise<ComparisonBranch> => {
                    // Create child thread for this model
                    const childThreadId = await createThreadMutation({
                        branchName: model,
                        customSystemPrompt: pendingSettings?.customSystemPrompt,
                        enabledFeatures: pendingSettings?.enabledFeatures,
                        language: pendingSettings?.language,
                        model,
                        reasoningEffort: pendingSettings?.reasoningEffort,
                        statelessMode: pendingSettings?.statelessMode,
                    });

                    // Create relationship to parent and send message in parallel —
                    // both only need childThreadId which is already resolved (async-parallel).
                    const [, response] = await Promise.all([
                        createRelationshipMutation({
                            branchPoint: 0,
                            branchType: "comparison",
                            // Both ids are widened to `string` here: the parent may come
                            // from the `parentThreadId` prop and `createThreadMutation`
                            // returns the new thread's id, so re-apply the brand.
                            parentThreadId: comparisonParentId! as Id<"threads">,
                            threadId: childThreadId as Id<"threads">,
                        }),
                        fetch(CHAT_STREAM_URL, {
                            body: JSON.stringify({
                                customSystemPrompt: pendingSettings?.customSystemPrompt,
                                enabledFeatures: pendingSettings?.enabledFeatures,
                                fileIds,
                                language: pendingSettings?.language,
                                model,
                                prompt: text,
                                reasoningEffort: pendingSettings?.reasoningEffort,
                                statelessMode: pendingSettings?.statelessMode,
                                threadId: childThreadId,
                            }),
                            headers: {
                                "Content-Type": "application/json",
                                ...(jwtToken && { Authorization: `Bearer ${jwtToken}` }),
                            },
                            method: "POST",
                        }),
                    ]);

                    if (!response.ok) {
                        const errorData = await response.json().catch(() => {
                            return {};
                        });

                        console.error(`[useComparisonChat] Failed to send to ${model}:`, errorData);

                        return {
                            activeStreamId: null,
                            isLoading: false,
                            messages: [],
                            model,
                            threadId: childThreadId,
                        };
                    }

                    const data = (await response.json().catch(() => {
                        return {};
                    })) as Record<string, unknown>;

                    return {
                        activeStreamId: (data.streamId as string) || null,
                        isLoading: true,
                        messages: [],
                        model,
                        threadId: childThreadId,
                    };
                });

                // Wait for all branches to be created and messages sent
                const newBranches = await Promise.all(branchPromises);

                setBranches(newBranches);

                // Navigate to comparison view (parent thread)
                void navigate({
                    params: { threadId: comparisonParentId },
                    to: "/chat/$threadId",
                });

                useChatUIStore.getState().clearComposer();
            } catch (error) {
                console.error("[useComparisonChat] Error sending comparison message:", error);
            } finally {
                setIsLoading(false);
            }
        },
        [parentThread, jwtToken, getPendingSettings, createThreadMutation, createRelationshipMutation, navigate, t],
    );

    /**
     * Send a follow-up message to existing child threads (no thread creation, no navigation)
     */
    const sendToExistingChildren = useCallback(
        async (text: string, children: { model: string; threadId: string }[], attachments?: PendingAttachment[]) => {
            if (children.length === 0) {
                return;
            }

            setIsLoading(true);

            try {
                const pendingSettings = getPendingSettings();

                const fileIds = attachments?.flatMap((a) => (a.status === "complete" && typeof a.fileId === "string" && a.fileId.length > 0 ? [a.fileId] : []));

                await Promise.all(
                    children.map(async ({ model, threadId: childThreadId }) => {
                        const response = await fetch(CHAT_STREAM_URL, {
                            body: JSON.stringify({
                                customSystemPrompt: pendingSettings?.customSystemPrompt,
                                enabledFeatures: pendingSettings?.enabledFeatures,
                                fileIds,
                                language: pendingSettings?.language,
                                model,
                                prompt: text,
                                reasoningEffort: pendingSettings?.reasoningEffort,
                                statelessMode: pendingSettings?.statelessMode,
                                threadId: childThreadId,
                            }),
                            headers: {
                                "Content-Type": "application/json",
                                ...(jwtToken && { Authorization: `Bearer ${jwtToken}` }),
                            },
                            method: "POST",
                        });

                        if (!response.ok) {
                            console.error(`[useComparisonChat] Failed to send to existing thread ${childThreadId}`);
                        }
                    }),
                );
            } catch (error) {
                console.error("[useComparisonChat] Error sending to existing children:", error);
            } finally {
                setIsLoading(false);
            }
        },
        [jwtToken, getPendingSettings],
    );

    // isComparisonThread is a derived const from parentThread + branches, so no extra dep needed.
    const state: ComparisonState = useMemo(() => {
        return {
            branches,
            isComparisonThread,
            isStreaming,
            parentThreadId: parentThread,
        };
    }, [parentThread, branches, isStreaming]);

    return {
        comparisonMode,
        isLoading,
        selectedModels,
        sendComparisonMessage,
        sendToExistingChildren,
        state,
    };
};

export default useComparisonChat;
