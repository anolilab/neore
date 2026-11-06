"use client";

import type { GatewayModel } from "@neore/ai/models";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { filterModelsByBlockedCreators } from "@/components/model-picker/utilities";
import { useCRPC } from "@/lib/lunora/crpc";

import useFeatureFlaggedModels from "./use-feature-flagged-models";
import { useGatewayModelsSettled } from "./use-gateway-models";
import { useBlockedCreators } from "./use-model-filter-rules";

/** The list while the user's rules are not known: a failed read, or a read not yet answered. A link then selects no model. */
const NO_MODELS: GatewayModel[] = [];

/**
 * The models the composer's picker offers this user: the feature-flagged catalog, with the user's overrides and filter rules
 * applied, minus the creators the user has blocked. The picker builds its list from the same two steps (`ModelPicker`), so a
 * model a prompt link names must be in this list for the link to select it.
 */
export const useComposerModels = (): GatewayModel[] => {
    const crpc = useCRPC();
    // The user's overrides, filter rules and creator blocks come from this one read; without it the list is not filtered.
    const { isError } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const models = useFeatureFlaggedModels({ applyUserOverrides: true });
    const { blockedCreators } = useBlockedCreators();
    const filtered = useMemo(() => filterModelsByBlockedCreators(models, blockedCreators), [models, blockedCreators]);

    return isError ? NO_MODELS : filtered;
};

/**
 * Whether the composer's list is final: the catalog has answered, and the user's rules have loaded or failed to load. Until then the
 * list can show models the user has blocked, so a link that selects a model waits for this.
 */
export const useComposerModelsSettled = (): boolean => {
    const crpc = useCRPC();
    const { isError, isSuccess } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));

    return useGatewayModelsSettled() && (isSuccess || isError);
};

/**
 * The ids of the composer's list, once it is final; `undefined` while it is not. A link's open and a copy both decide on these ids.
 */
export const useComposerModelIds = (): ReadonlySet<string> | undefined => {
    const models = useComposerModels();
    const settled = useComposerModelsSettled();

    return useMemo(() => (settled ? new Set(models.map((entry) => entry.id)) : undefined), [models, settled]);
};
