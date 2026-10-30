"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation as useReactQueryMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";

import { useModelStore } from "@/features/chat/core/stores/model-store";
import { trackEvent } from "@/lib/analytics";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError, showInfo } from "@/lib/toast";

import { canSwitchAgent } from "./can-switch-agent";
import { createLatestPickQueue } from "./latest-pick-queue";

interface UseModelComboboxProps {
    threadId?: string;
}

interface ThreadUpdateData {
    customSystemPrompt?: string;
    enabledFeatures?: string[];
    language?: string;
    model?: string;
    reasoningEffort?: number;
    statelessMode?: boolean;
}

const useModelCombobox = ({ threadId }: UseModelComboboxProps) => {
    const { t } = useLingui();
    const { getPendingSettings, loadThreadData, selectedModel, setPendingSettings, setSelectedModel } = useModelStore();
    const crpc = useCRPC();

    // Get thread data if we have a threadId
    const { data: thread } = useQuery(crpc.chat.functions.getThread.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken));

    // updateThread is an Action, wrapped with TanStack Query for state management
    const { mutateAsync: updateThreadAction } = useReactQueryMutation(useLunoraActionOptions(api.chat.functions.updateThread));

    const { mutateAsync: switchAgent } = useReactQueryMutation(crpc.chat.agent_switch.switchThreadAgent.mutationOptions());

    // Picks go to the server one at a time, in the order made, and only the newest may touch the store: a slow
    // answer to an earlier pick must not put its model back over the one the user ended on.
    const pickQueueRef = useRef(createLatestPickQueue());

    // Get effective model (the agent of a switched thread, then the thread's model, then the pick)
    const effectiveModel = thread?.activeAgent?.model ?? thread?.model ?? selectedModel;

    // Update thread settings
    const updateThread = async (data: ThreadUpdateData) => {
        if (threadId && thread) {
            // Update existing thread
            await updateThreadAction({
                model: thread.model,
                // `threadId` is the `/chat/$threadId` route param, which only names real threads.
                threadId: threadId as Id<"threads">,
                ...data,
            });
        } else {
            // Update pending settings for new thread
            const currentSettings = getPendingSettings() || {};

            setPendingSettings({
                ...currentSettings,
                ...data,
            });
        }
    };

    // Change model
    const changeModel = async (newModel: string) => {
        const previousModel = useModelStore.getState().selectedModel;

        // Always update local store for immediate UI feedback
        setSelectedModel(newModel, threadId);

        if (previousModel && previousModel !== newModel) {
            trackEvent("model_switched", { from_model: previousModel, to_model: newModel });
        }

        // A text thread records the change as a switch in its transcript; the thread's own model stays
        // what it was created with, which is what a branch from before the switch runs on.
        if (threadId && thread && canSwitchAgent(thread, newModel)) {
            const { isLatest: isLatestPick, result: request } = pickQueueRef.current.run(
                async () =>
                    await switchAgent({
                        clientId: crypto.randomUUID(),
                        target: { kind: "model", model: newModel },
                        threadId: threadId as Id<"threads">,
                    }),
            );

            try {
                const result = await request;

                if (!isLatestPick()) {
                    return;
                }

                // The thread decides the agent from here on, so a branch switch can move it: no local pick to keep.
                loadThreadData({ mode: thread.mode, model: result.agent.model }, threadId);

                if (result.coldStartCostly) {
                    showInfo(t`The next reply re-reads this whole conversation without the model's cache, so it costs more than usual.`);
                }

                return;
            } catch (error) {
                // A thread with nothing to switch from yet (no messages) has no transcript to put a divider in: the
                // pick is an edit of the thread's model, below.
                if (!isLatestPick()) {
                    return;
                }

                if ((error as { data?: { code?: string } }).data?.code !== "AGENT_SWITCH_UNSUPPORTED") {
                    loadThreadData({ mode: thread.mode, model: thread.activeAgent?.model ?? thread.model }, threadId);
                    showError(error instanceof Error ? error : t`Could not switch the model. Please try again.`);

                    return;
                }
            }
        }

        // If existing thread, also persist to Lunora. A switched thread keeps its model: it is the agent of every
        // branch from before the first switch, and a pick the server cannot switch to lives in the composer only.
        if (threadId && thread && !thread.activeAgent) {
            await updateThreadAction({
                model: newModel,
                threadId: threadId as Id<"threads">,
            });
        }
    };

    return {
        changeModel,
        model: effectiveModel,
        thread,
        updateThread,
    };
};

export default useModelCombobox;
