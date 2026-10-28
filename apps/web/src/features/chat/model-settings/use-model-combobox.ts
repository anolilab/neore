"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation as useReactQueryMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ThreadRow } from "@/features/chat/core/context/chat-context-types";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { trackEvent } from "@/lib/analytics";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import type { PendingAgentSwitch } from "./agent-switch-confirm-dialog";
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
    const queryClient = useQueryClient();
    // A switch on a long conversation waits here for the user to see what it costs.
    const [pendingSwitch, setPendingSwitch] = useState<PendingAgentSwitch | null>(null);

    // Get thread data if we have a threadId
    const { data: thread } = useQuery(crpc.chat.functions.getThread.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken));

    // updateThread is an Action, wrapped with TanStack Query for state management
    const { mutateAsync: updateThreadAction } = useReactQueryMutation(useLunoraActionOptions(api.chat.functions.updateThread));

    const { mutateAsync: switchAgent } = useReactQueryMutation(useLunoraActionOptions(api.chat.agent_switch.switchThreadAgent));

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

    const revertSwitch = (id: string, row: ThreadRow) => loadThreadData({ mode: row.mode, model: row.activeAgent?.model ?? row.model }, id);

    const runSwitch = async (newModel: string, id: string, row: ThreadRow, mode?: "full" | "portable") => {
        try {
            const result = await switchAgent({
                clientId: crypto.randomUUID(),
                ...(mode && { mode }),
                target: { kind: "model", model: newModel },
                threadId: id as Id<"threads">,
            });

            // The thread decides the agent from here on, so a branch switch can move it: no local pick to keep.
            loadThreadData({ mode: row.mode, model: result.agent.model }, id);
        } catch (error) {
            revertSwitch(id, row);
            showError(error instanceof Error ? error : t`Could not switch the model. Please try again.`);
        }
    };

    // Past the cold-start threshold the user sees the cost first; the divider is written only after they agree.
    const startSwitch = async (newModel: string, id: string, row: ThreadRow) => {
        try {
            // Read fresh: the conversation grows between picks.
            const preview = await queryClient.fetchQuery({
                ...crpc.chat.agent_switch.previewAgentSwitch.queryOptions({ model: newModel, threadId: id as Id<"threads"> }, { live: false }),
                staleTime: 0,
            });

            if (preview.coldStartCostly) {
                setPendingSwitch({ model: newModel, preview });

                return;
            }
        } catch {
            // No estimate is no reason to refuse; the switch itself says what is wrong, if anything is.
        }

        await runSwitch(newModel, id, row);
    };

    const confirmSwitch = async (mode: "full" | "portable") => {
        const pending = pendingSwitch;

        setPendingSwitch(null);

        if (pending && threadId && thread) {
            await runSwitch(pending.model, threadId, thread, mode);
        }
    };

    const cancelSwitch = () => {
        setPendingSwitch(null);

        if (threadId && thread) {
            revertSwitch(threadId, thread);
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
            await startSwitch(newModel, threadId, thread);

            return;
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
        cancelSwitch,
        changeModel,
        confirmSwitch,
        pendingSwitch,
        model: effectiveModel,
        thread,
        updateThread,
    };
};

export default useModelCombobox;
