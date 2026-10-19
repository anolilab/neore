"use client";

import type { GatewayModel } from "@neore/ai/models";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

const NO_BLOCKED_CREATORS: string[] = [];

export interface ModelFilterRules {
    allowedModels?: string[];
    allowedProviders?: string[];
    allowedRegions?: string[];
    /** Labs (creator slugs, e.g. "meta") hidden from the model picker only. Applied in `ModelPicker`, not here: other surfaces still resolve every model. */
    blockedCreators?: string[];
    blockedModels?: string[];
    blockedProviders?: string[];
    blockedRegions?: string[];
    denyDataCollection?: boolean;
    requireZDR?: boolean;
}

/**
 * Get the regions for a model.
 * Gateway models include a `regions` field directly.
 * Falls back to provider-based heuristics for models without region data.
 */
const PROVIDER_REGIONS_FALLBACK: Record<string, string[]> = {
    anthropic: ["US", "EU"],
    google: ["US", "EU"],
    groq: ["US"],
    meta: ["US"],
    mistral: ["EU", "US"],
    openai: ["US"],
    xai: ["US"],
};

const getModelRegions = (model: GatewayModel): string[] => {
    if (model.regions && model.regions.length > 0) {
        return model.regions;
    }

    return PROVIDER_REGIONS_FALLBACK[model.provider] ?? [];
};

/**
 * Check if a model passes the filter rules.
 */
const isModelAllowed = (model: GatewayModel, rules: ModelFilterRules): boolean => {
    // Model ID allow-list
    if (rules.allowedModels && rules.allowedModels.length > 0 && !rules.allowedModels.includes(model.id)) return false;

    // Model ID block-list
    if (rules.blockedModels && rules.blockedModels.length > 0 && rules.blockedModels.includes(model.id)) return false;

    // Provider allow-list
    if (rules.allowedProviders && rules.allowedProviders.length > 0 && !rules.allowedProviders.includes(model.provider)) return false;

    // Provider block-list
    if (rules.blockedProviders && rules.blockedProviders.length > 0 && rules.blockedProviders.includes(model.provider)) return false;

    // Region allow-list
    if (rules.allowedRegions && rules.allowedRegions.length > 0) {
        const regions = getModelRegions(model);

        if (regions.length === 0) return false;

        if (regions.every((r) => !rules.allowedRegions!.includes(r))) return false;
    }

    // Region block-list
    if (rules.blockedRegions && rules.blockedRegions.length > 0) {
        const regions = getModelRegions(model);

        if (regions.length > 0 && regions.every((r) => rules.blockedRegions!.includes(r))) return false;
    }

    return true;
};

/**
 * Returns the user's model filter rules from preferences.
 */
export const useModelFilterRules = (): ModelFilterRules | undefined => {
    const crpc = useCRPC();
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));

    return aiPreferences?.modelFilterRules as ModelFilterRules | undefined;
};

/**
 * Filters a list of GatewayModels based on the user's model filter rules.
 * Returns the original list if no filter rules are configured.
 */
export const useFilteredModels = (models: GatewayModel[]): GatewayModel[] => {
    const rules = useModelFilterRules();

    if (!rules) return models;

    const hasRules =
        (rules.allowedRegions && rules.allowedRegions.length > 0) ||
        (rules.blockedRegions && rules.blockedRegions.length > 0) ||
        (rules.allowedModels && rules.allowedModels.length > 0) ||
        (rules.blockedModels && rules.blockedModels.length > 0) ||
        (rules.allowedProviders && rules.allowedProviders.length > 0) ||
        (rules.blockedProviders && rules.blockedProviders.length > 0);

    if (!hasRules) return models;

    return models.filter((m) => isModelAllowed(m, rules));
};

/** The hidden list with one lab added. A lab already in it is not repeated. */
export const withCreatorHidden = (blocked: ReadonlyArray<string>, slug: string): string[] => (blocked.includes(slug) ? [...blocked] : [...blocked, slug]);

/** The hidden list with one lab removed; every other entry stays as it is. */
export const withoutCreator = (blocked: ReadonlyArray<string>, slug: string): string[] => blocked.filter((s) => s !== slug);

/**
 * The labs hidden from the model picker, and an updater for them. The mutation
 * replaces the whole `modelFilterRules` object, so the other rules are carried
 * over. Shared by the picker's "Hide" action and the filters page.
 *
 * The updater is applied to the newest rules this hook knows, not to the
 * render's snapshot, so two edits in flight both survive.
 */
export const useBlockedCreators = () => {
    const crpc = useCRPC();
    const rules = useModelFilterRules();
    const updateMutation = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());
    const { mutateAsync } = updateMutation;
    // ponytail: a refetch that lands mid-save resets this to the server copy, which can lack that save. Serialise saves if that bites.
    const newest = useRef(rules);

    useEffect(() => {
        newest.current = rules;
    }, [rules]);

    const setBlockedCreators = useCallback(
        (update: (current: ReadonlyArray<string>) => string[]) => {
            const base = newest.current;
            const next: ModelFilterRules = { ...base, blockedCreators: update(base?.blockedCreators ?? NO_BLOCKED_CREATORS) };

            newest.current = next;

            return mutateAsync({ modelFilterRules: next }).catch((error: unknown) => {
                if (newest.current === next) {
                    newest.current = base;
                }

                throw error;
            });
        },
        [mutateAsync],
    );

    return { blockedCreators: rules?.blockedCreators ?? NO_BLOCKED_CREATORS, isPending: updateMutation.isPending, setBlockedCreators };
};
