"use client";

import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation as useReactQueryMutation, useQuery } from "@tanstack/react-query";

import { useModelStore } from "@/features/chat/core/stores/model-store";
import { trackEvent } from "@/lib/analytics";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";

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
    const { getPendingSettings, selectedModel, setPendingSettings, setSelectedModel } = useModelStore();
    const crpc = useCRPC();

    // Get thread data if we have a threadId
    const { data: thread } = useQuery(crpc.chat.functions.getThread.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken));

    // updateThread is an Action, wrapped with TanStack Query for state management
    const { mutateAsync: updateThreadAction } = useReactQueryMutation(useLunoraActionOptions(api.chat.functions.updateThread));

    // Get effective model (thread model takes precedence)
    const effectiveModel = thread?.model ?? selectedModel;

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
