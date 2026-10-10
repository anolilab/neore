"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useCRPC } from "@/lib/lunora/crpc";

import validatePromptSettings from "../lib/prompt-validation";
import { getAutoPopulatedVariables, replaceVariables } from "../lib/prompt-variables";

/**
 * Hook to load a prompt by ID and apply its settings to the chat
 * This is used when navigating to /chat?promptId=xxx.
 */
const usePromptLoader = (promptId: string | undefined) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const models = useFeatureFlaggedModels();
    const setComposerText = useChatUIStore((state) => state.setComposerText);
    const hasAppliedPrompt = useRef(false);

    const setSelectedModel = useModelStore((state) => state.setSelectedModel);
    const setPendingSettings = useModelStore((state) => state.setPendingSettings);

    // Get current user context for auto-populated variables
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const { data: activeOrganization } = hooks.useActiveOrganization();

    // Load prompt if promptId is provided
    // `promptId` is the raw `/chat?promptId=…` search param, so the row-id brand has to be applied here.
    const { data: prompt } = useQuery(crpc.prompts.functions.getPrompt.queryOptions(promptId ? { promptId: promptId as Id<"prompts"> } : skipToken));

    useEffect(() => {
        if (!promptId || !prompt || hasAppliedPrompt.current) {
            return;
        }

        // Validate prompt settings
        const validationResult = validatePromptSettings(prompt.model, prompt.reasoningEffort, prompt.enabledFeatures, models);

        if (!validationResult.isValid) {
            const errorMessages = Object.values(validationResult.errors).filter(Boolean).flat().join(", ");

            toast.error(t`Cannot use prompt: ${errorMessages}`);
            hasAppliedPrompt.current = true;

            return;
        }

        // Apply model settings if configured
        if (prompt.model) {
            setSelectedModel(prompt.model, undefined);
        }

        // Apply reasoning effort and features via pendingSettings (for new threads)
        if (prompt.reasoningEffort !== undefined || prompt.enabledFeatures) {
            setPendingSettings({
                enabledFeatures: prompt.enabledFeatures,
                reasoningEffort: prompt.reasoningEffort,
            });
        }

        // Build variable values with auto-populated ones
        const autoVariables = getAutoPopulatedVariables({
            email: sessionData?.user?.email,
            name: sessionData?.user?.name,
            organization: activeOrganization?.name,
        });

        // Merge with prompt variable defaults
        const values = { ...autoVariables };

        if (prompt.variables) {
            for (const v of prompt.variables) {
                if (!Object.hasOwn(values, v.name) && v.defaultValue) {
                    values[v.name] = v.defaultValue;
                }
            }
        }

        // Replace variables in prompt content
        const content = replaceVariables(prompt.content, values, { keepUnmatched: true });

        // Set the composer text with the prompt content
        setComposerText(content);
        toast.success(t`Prompt loaded`);
        hasAppliedPrompt.current = true;
    }, [promptId, prompt, models, setComposerText, setSelectedModel, setPendingSettings, sessionData, activeOrganization, t]);

    // Reset the ref when promptId changes
    useEffect(() => {
        hasAppliedPrompt.current = false;
    }, [promptId]);
};

export default usePromptLoader;
