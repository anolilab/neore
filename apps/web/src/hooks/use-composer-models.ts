"use client";

import type { GatewayModel } from "@neore/ai/models";
import { useQuery } from "@tanstack/react-query";
import { usePostHog } from "posthog-js/react";
import { useEffect, useMemo, useState } from "react";

import { filterModelsByBlockedCreators } from "@/components/model-picker/utilities";
import type { LinkableModel } from "@/features/chat/core/utils/prompt-link-model";
import env from "@/lib/env";
import { useCRPC } from "@/lib/lunora/crpc";

import useFeatureFlaggedModels from "./use-feature-flagged-models";
import { useGatewayModels, useGatewayModelsSettled } from "./use-gateway-models";
import { useBlockedCreators } from "./use-model-filter-rules";

/**
 * How long a link waits for PostHog's feature flags before it decides without them. A model behind a flag is hidden until the flags
 * arrive, as the picker hides it, so after this wait the link refuses such a model rather than wait for flags that may never come.
 */
export const FLAG_WAIT_MS = 1500;

/** The list while the user's rules are not known: a failed read. A link then selects no model, so it cannot select one the user blocked. */
const NO_MODELS: GatewayModel[] = [];

/** Separators of an entry's signature: between an entry's fields, and between entries. Neither can occur in a model id. */
const FIELD = "\u{1}";
const ROW = "\u{2}";

/**
 * The models the composer's picker offers this user: the feature-flagged catalog, with the user's overrides and filter rules applied,
 * minus the creators the user has blocked. The picker builds its list from the same two steps (`ModelPicker`).
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
 * Whether the feature flags that gate models are known. A model behind a flag is offered only once its flag is known, so a link that
 * selects one waits for the flags. Re-renders when they arrive, since the list reads them at render.
 */
const useFeatureFlagsKnown = (): boolean => {
    const posthog = usePostHog();
    const gated = useGatewayModels().some((model) => model.featureFlag);
    const [, setFlagsVersion] = useState(0);
    const [waitOver, setWaitOver] = useState(false);
    const [flagsFailed, setFlagsFailed] = useState(false);

    useEffect(() => {
        if (!posthog || typeof posthog.onFeatureFlags !== "function") {
            return undefined;
        }

        return posthog.onFeatureFlags((_flags, _variants, context) => {
            // A flag request that failed will not be retried by this page: the flags are as known as they will be.
            if (context?.errorsLoading === true) {
                setFlagsFailed(true);
            }

            setFlagsVersion((version) => version + 1);
        });
    }, [posthog]);

    useEffect(() => {
        if (!gated) {
            return undefined;
        }

        const timer = setTimeout(() => {
            setWaitOver(true);
        }, FLAG_WAIT_MS);

        return () => {
            clearTimeout(timer);
        };
    }, [gated]);

    // Without a PostHog project there are no flags to wait for.
    return !gated || !env.VITE_POSTHOG_API_KEY || posthog?.flagsEndpointWasHit === true || flagsFailed || waitOver;
};

/**
 * Whether the composer's list is final: the catalog has answered, the user's rules have loaded or failed to load, and the feature flags
 * that gate models are known. Until then the list can show models the user has blocked, or hide a model the user may use, so a link
 * that selects a model waits for this.
 */
export const useComposerModelsSettled = (): boolean => {
    const crpc = useCRPC();
    const { isError, isSuccess } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const flagsKnown = useFeatureFlagsKnown();

    return useGatewayModelsSettled() && (isSuccess || isError) && flagsKnown;
};

/** The map a signature describes. Built only from the signature, so it is recreated only when the list changes. */
const entriesOf = (signature: string): ReadonlyMap<string, LinkableModel> =>
    new Map(
        signature === ""
            ? []
            : signature.split(ROW).map((row): [string, LinkableModel] => {
                  const [id = "", mode = "", provider = ""] = row.split(FIELD);

                  return [id, { id, ...(mode !== "" && { mode }), ...(provider !== "" && { provider }) }];
              }),
    );

/**
 * The entries of the composer's list, keyed by model id, once the list is final; `undefined` while it is not. A link's open and a copy
 * both decide on these entries, so they agree with the picker.
 *
 * The list is rebuilt on every render, so the map is keyed by a signature of its entries: it keeps its identity while the list does not
 * change. A new identity on every render would re-render every consumer of the chat's thread context on each stream update.
 */
export const useComposerModelEntries = (): ReadonlyMap<string, LinkableModel> | undefined => {
    const models = useComposerModels();
    const settled = useComposerModelsSettled();
    const signature = settled ? models.map((model) => [model.id, model.mode ?? "", model.provider ?? ""].join(FIELD)).join(ROW) : undefined;

    return useMemo(() => (signature === undefined ? undefined : entriesOf(signature)), [signature]);
};
