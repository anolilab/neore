"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation as useReactQueryMutation, useQuery } from "@tanstack/react-query";

import { useModelStore } from "@/features/chat/core/stores/model-store";
import { trackEvent } from "@/lib/analytics";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError, showInfo } from "@/lib/toast";

import { canSwitchAgent } from "./can-switch-agent";

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
            try {
                const result = await switchAgent({
                    clientId: crypto.randomUUID(),
                    target: { kind: "model", model: newModel },
                    threadId: threadId as Id<"threads">,
                });

                // The thread decides the agent from here on, so a branch switch can move it: no local pick to keep.
                loadThreadData({ mode: thread.mode, model: result.agent.model }, threadId);

                if (result.coldStartCostly) {
                    showInfo(t`The next reply re-reads this whole conversation without the model's cache, so it costs more than usual.`);
                }
            } catch (error) {
                loadThreadData({ mode: thread.mode, model: thread.activeAgent?.model ?? thread.model }, threadId);
                showError(error instanceof Error ? error : t`Could not switch the model. Please try again.`);
            }

            return;
        }

        // If existing thread, also persist to Lunora
        if (threadId && thread) {
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
