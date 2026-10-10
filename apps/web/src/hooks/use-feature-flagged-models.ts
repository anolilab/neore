"use client";

import type { GatewayModel } from "@neore/ai/models";
import { usePostHog } from "posthog-js/react";

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
 */
const useFeatureFlaggedModels = (): GatewayModel[] => {
    const posthog = usePostHog();
    const gatewayModels = useGatewayModels();

    const flagFiltered = gatewayModels.filter((m) => {
        if (!m.featureFlag) {
            return true;
        }

        return posthog?.isFeatureEnabled(m.featureFlag) === true;
    });

    // Apply user's model filter rules (region, provider, model block lists)
    return useFilteredModels(flagFiltered);
};

export default useFeatureFlaggedModels;
