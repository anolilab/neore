"use client";

import type { GatewayModel } from "@neore/ai/models";
import { useMemo } from "react";

import { filterModelsByBlockedCreators } from "@/components/model-picker/utilities";

import useFeatureFlaggedModels from "./use-feature-flagged-models";
import { useBlockedCreators } from "./use-model-filter-rules";

/**
 * The models the composer's picker offers this user: the feature-flagged catalog, with the user's overrides and filter rules
 * applied, minus the creators the user has blocked. The picker builds its list from the same two steps (`ModelPicker`), so a
 * model a prompt link names must be in this list for the link to select it.
 */
export const useComposerModels = (): GatewayModel[] => {
    const models = useFeatureFlaggedModels({ applyUserOverrides: true });
    const { blockedCreators } = useBlockedCreators();

    return useMemo(() => filterModelsByBlockedCreators(models, blockedCreators), [models, blockedCreators]);
};
