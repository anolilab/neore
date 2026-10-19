"use client";

import type { GatewayModel } from "@neore/ai/models";
import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

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

/** The list-valued rules. An empty list is dropped, so a saved object carries only the rules that are set. */
const LIST_RULES = ["allowedModels", "allowedProviders", "allowedRegions", "blockedCreators", "blockedModels", "blockedProviders", "blockedRegions"] as const;

/**
 * The rules as they are saved. Empty values are dropped and the result is always
 * an object: `undefined` is no save at all (JSON drops the key, so the server's
 * patch keeps the stored rules), so clearing the last rule must write `{}`.
 */
const cleanRules = (rules: ModelFilterRules): ModelFilterRules => {
    const cleaned: ModelFilterRules = {};

    for (const key of LIST_RULES) {
        const list = rules[key];

        if (list && list.length > 0) {
            cleaned[key] = list;
        }
    }

    if (rules.requireZDR) {
        cleaned.requireZDR = true;
    }

    if (rules.denyDataCollection) {
        cleaned.denyDataCollection = true;
    }

    return cleaned;
};

/** The preferences as the query cache holds them. `undefined` until the first load. */
type PreferencesCache = { modelFilterRules?: unknown } | null | undefined;

/** One edit: how it changes the rules it is applied to. */
interface Edit {
    update: (current: ModelFilterRules) => ModelFilterRules;
}

/**
 * The edits of one QueryClient, shared by every hook instance on it (the picker and the filters page).
 *
 * `confirmed` is the last value the server accepted. The cache shows it with every
 * pending edit applied in order. Saves run one at a time: each sends `confirmed`
 * with its own edit applied, so an edit that fails is never saved by a later one,
 * and a later edit is not lost to an earlier failure. A failed edit is removed and
 * the cache recomputed; a saved one becomes `confirmed`.
 */
interface PreferencesEdits {
    confirmed: ModelFilterRules | undefined;
    pending: Edit[];
    queue: Promise<unknown>;
}

const editsByClient = new WeakMap<QueryClient, PreferencesEdits>();

const editsOf = (queryClient: QueryClient): PreferencesEdits => {
    let edits = editsByClient.get(queryClient);

    if (!edits) {
        edits = { confirmed: undefined, pending: [], queue: Promise.resolve() };
        editsByClient.set(queryClient, edits);
    }

    return edits;
};

/** What the cache shows: `confirmed` with every pending edit applied in order. */
const visibleRules = (edits: PreferencesEdits): ModelFilterRules | undefined => {
    if (edits.pending.length === 0) {
        return edits.confirmed;
    }

    let rules = edits.confirmed ?? {};

    for (const edit of edits.pending) {
        rules = cleanRules(edit.update(rules));
    }

    return rules;
};

/**
 * The user's model filter rules, and the one way to save them. `updateRules`
 * takes an updater and applies it to the NEWEST rules, not to the caller's
 * render snapshot, so two edits in flight both survive.
 *
 * The cache shows the edits not yet refused, on top of the last saved value; a
 * refused edit is dropped from it. A user with no preferences row caches `null`:
 * the first edit builds on nothing and its save creates the row.
 *
 * ponytail: a live push or refetch that lands while edits are pending is overwritten by the next edit or settlement. Serialise the edits if that bites.
 */
export const useUpdateModelFilterRules = () => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const preferences = crpc.auth.functions.getAIUserPreferences.queryOptions({});
    const { data, isSuccess: isLoaded } = useQuery(preferences);
    const rules = data?.modelFilterRules as ModelFilterRules | undefined;
    const { isPending, mutateAsync } = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());

    // The key is built inside the callback: a fresh array each render would make `updateRules` change identity every render.
    const updateRules = useCallback(
        async (update: (current: ModelFilterRules) => ModelFilterRules) => {
            const { queryKey } = crpc.auth.functions.getAIUserPreferences.queryOptions({});
            const cached = queryClient.getQueryData<PreferencesCache>(queryKey);

            // Before the preferences load there is nothing to build on, and saving would replace the user's other filters.
            if (cached === undefined) {
                throw new Error("The model filter rules have not loaded yet");
            }

            const edits = editsOf(queryClient);

            if (edits.pending.length === 0) {
                edits.confirmed = cached?.modelFilterRules as ModelFilterRules | undefined;
            }

            const edit: Edit = { update };
            const show = () => {
                const shown = visibleRules(edits);

                queryClient.setQueryData<PreferencesCache>(queryKey, (old) => {
                    return { ...old, modelFilterRules: shown };
                });
            };

            edits.pending.push(edit);
            show();

            // Each save waits for the one before it, so it sends the value that save left.
            const save = async () => {
                const payload = cleanRules(update(edits.confirmed ?? {}));

                try {
                    await mutateAsync({ modelFilterRules: payload });
                    edits.confirmed = payload;
                } finally {
                    edits.pending = edits.pending.filter((pending) => pending !== edit);
                    show();
                }
            };
            const saved = edits.queue.then(save);

            edits.queue = saved.catch(() => undefined);

            return saved;
        },
        [crpc, mutateAsync, queryClient],
    );

    return { isLoaded, isPending, rules, updateRules };
};

/**
 * The labs hidden from the model picker, and an updater for them. Shared by the
 * picker's "Hide" action and the filters page; saving goes through
 * `useUpdateModelFilterRules`, so the other rules are carried over.
 */
export const useBlockedCreators = () => {
    const { isLoaded, isPending, rules, updateRules } = useUpdateModelFilterRules();

    const setBlockedCreators = useCallback(
        (update: (current: ReadonlyArray<string>) => string[]) =>
            updateRules((current) => {
                return { ...current, blockedCreators: update(current.blockedCreators ?? NO_BLOCKED_CREATORS) };
            }),
        [updateRules],
    );

    return { blockedCreators: rules?.blockedCreators ?? NO_BLOCKED_CREATORS, isLoaded, isPending, setBlockedCreators };
};
