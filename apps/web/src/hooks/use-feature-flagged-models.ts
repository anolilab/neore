"use client";

import type { GatewayModel } from "@neore/ai/models";
import { useQuery } from "@tanstack/react-query";
import { usePostHog } from "posthog-js/react";

import { useCRPC } from "@/lib/lunora/crpc";

import { useGatewayModels } from "./use-gateway-models";
import { useFilteredModels } from "./use-model-filter-rules";

/**
 * Returns the model catalog visible to the current user.
 *
 * Models are fetched from the LLM Gateway (/v1/models) — the single
 * source of truth for available models, enriched with pricing and region data.
 *
 * Filters applied:
 * 1. PostHog feature flags (hides gated models)
 * 2. User's model filter rules (region, provider, block lists).
 * 3. With `applyUserOverrides`, the user's per-model overrides (`aiUserPreferences.modelOverrides`)
 *    drop the models they switched off. Only the chat model picker opts in; other consumers, such as
 *    message badges and the Models settings page, still resolve every model.
 */
const useFeatureFlaggedModels = (options?: { applyUserOverrides?: boolean }): GatewayModel[] => {
    const posthog = usePostHog();
    const crpc = useCRPC();
    const gatewayModels = useGatewayModels();
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const modelOverrides = aiPreferences?.modelOverrides as Record<string, boolean> | undefined;

    const flagFiltered = gatewayModels.filter((m) => {
        if (options?.applyUserOverrides && modelOverrides?.[m.id] === false) {
            return false;
        }

        if (!m.featureFlag) {
            return true;
        }

        return posthog?.isFeatureEnabled(m.featureFlag) === true;
    });

    // Apply user's model filter rules (region, provider, model block lists)
    return useFilteredModels(flagFiltered);
};

export default useFeatureFlaggedModels;
