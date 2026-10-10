"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { GatewayModel, ModelFilterCapability } from "@neore/ai/models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Heading } from "@neore/ui/components/heading";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Separator } from "@neore/ui/components/separator";
import { Switch } from "@neore/ui/components/switch";
import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Filter, RotateCcw, Search, X } from "lucide-react";
import type { FC } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useCRPC } from "@/lib/lunora/crpc";

const FILTER_CAPABILITIES: { key: ModelFilterCapability; label: MessageDescriptor }[] = [
    { key: "fast", label: msg`Fast` },
    { key: "vision", label: msg`Vision` },
    { key: "reasoning", label: msg`Reasoning` },
    { key: "tool_calling", label: msg`Tool Calling` },
    { key: "image_generation", label: msg`Image Gen` },
    { key: "pdf_comprehension", label: msg`PDF` },
];

/** Display labels for the `mode` and `state` filter values; the values themselves stay the keys. */
const FILTER_VALUE_LABELS: Record<string, MessageDescriptor> = {
    free: msg`Free`,
    image: msg`Image`,
    music: msg`Music`,
    new: msg`New`,
    premium: msg`Premium`,
    text: msg`Text`,
    video: msg`Video`,
};

/** Group key for models without a provider. */
const OTHER_PROVIDER = "Other";

const FILTER_CAPABILITY_LABELS = new Map(FILTER_CAPABILITIES.map((capability) => [capability.key as string, capability.label]));

/** Default lexicographic (UTF-16 code unit) order — the same order `Array#sort` uses for strings. */
const byCodeUnit = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

const ModelsSettings: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const filterValueLabel = (value: string): string => {
        const label: MessageDescriptor | undefined = FILTER_VALUE_LABELS[value];

        return label ? i18n._(label) : value;
    };
    const capabilityLabel = (capability: string): string => {
        const label = FILTER_CAPABILITY_LABELS.get(capability);

        return label ? i18n._(label) : capability;
    };
    // Straight from the hook — this used to be mirrored into state by an effect,
    // which just rendered one frame of an empty list before the copy landed.
    const models = useFeatureFlaggedModels();
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const updateAIUserPreferencesMutation = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());

    // `aiUserPreferences.modelOverrides` is `v.optional(v.any())` in `backend/lunora/schema.ts`
    // (a straight port of the Lunora column), so it arrives here as `unknown`. The write
    // validator in `backend/lunora/auth/fields.ts` is `v.record(v.string(), v.boolean())`,
    // and this page is the only writer — so the runtime shape really is model-id -> enabled.
    const modelOverrides = (aiPreferences?.modelOverrides ?? {}) as Record<string, boolean>;

    const [searchQuery, setSearchQuery] = useState("");
    const [activeFilters, setActiveFilters] = useState<Set<ModelFilterCapability>>(new Set());
    const [showFilters, setShowFilters] = useState(false);
    const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
    const [selectedMode, setSelectedMode] = useState<string | null>(null);
    const [selectedState, setSelectedState] = useState<string | null>(null);

    // Single-pass derivation of all filter metadata + enabled state from models array
    const { baseEnabledState, currentEnabledState, enabledCount, modes, providers, states } = useMemo(() => {
        const enabledState: Record<string, boolean> = {};
        const providerSet = new Set<string>();
        const modeSet = new Set<string>();
        const stateSet = new Set<string>();
        let count = 0;

        for (const model of models) {
            const enabled = model.enabled ?? false;

            enabledState[model.id] = enabled;

            if (enabled) count += 1;

            if (model.provider) {
                providerSet.add(model.provider);
            }

            if (model.mode) {
                modeSet.add(model.mode);
            }

            stateSet.add(model.isPremium ? "premium" : "free");

            if (model.isNew) {
                stateSet.add("new");
            }
        }

        return {
            baseEnabledState: enabledState,
            currentEnabledState: enabledState,
            enabledCount: count,
            modes: [...modeSet].toSorted(byCodeUnit),
            providers: [...providerSet].toSorted(byCodeUnit),
            states: [...stateSet].toSorted(byCodeUnit),
        };
    }, [models]);

    const toggleFilter = (capability: ModelFilterCapability) => {
        setActiveFilters((previous) => {
            const next = new Set(previous);

            if (next.has(capability)) {
                next.delete(capability);
            } else {
                next.add(capability);
            }

            return next;
        });
    };

    const clearFilters = () => {
        setActiveFilters(new Set());
        setSelectedProvider(null);
        setSelectedMode(null);
        setSelectedState(null);
        setSearchQuery("");
    };

    const hasActiveFilters = activeFilters.size > 0 || selectedProvider || selectedMode || selectedState || searchQuery.trim().length > 0;

    const filteredModels = useMemo(() => {
        let filtered: GatewayModel[] = [...models];

        // Filter by search query
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();

            filtered = filtered.filter(
                (model) =>
                    (model.name?.toLowerCase() ?? "").includes(query) ||
                    model.id.toLowerCase().includes(query) ||
                    model.provider?.toLowerCase().includes(query),
            );
        }

        // Filter by capabilities
        if (activeFilters.size > 0) {
            filtered = filtered.filter((model) => {
                if (!model.filterCapabilities) {
                    return false;
                }

                return [...activeFilters].every((filter) => model.filterCapabilities?.includes(filter));
            });
        }

        // Filter by provider
        if (selectedProvider) {
            filtered = filtered.filter((model) => model.provider === selectedProvider);
        }

        // Filter by mode
        if (selectedMode) {
            filtered = filtered.filter((model) => model.mode === selectedMode);
        }

        // Filter by state
        if (selectedState) {
            switch (selectedState) {
                case "free": {
                    filtered = filtered.filter((model) => !model.isPremium);

                    break;
                }
                case "new": {
                    filtered = filtered.filter((model) => model.isNew);

                    break;
                }
                case "premium": {
                    filtered = filtered.filter((model) => model.isPremium);

                    break;
                }
                default: {
                    break;
                }
            }
        }

        return filtered;
    }, [models, searchQuery, activeFilters, selectedProvider, selectedMode, selectedState]);

    // Group models by provider
    const groupByProvider = (modelList: GatewayModel[]) => {
        const groups = new Map<string, GatewayModel[]>();

        modelList.forEach((model) => {
            const provider = model.provider || OTHER_PROVIDER;

            if (!groups.has(provider)) {
                groups.set(provider, []);
            }

            const group = groups.get(provider);

            if (group) {
                group.push(model);
            }
        });

        return groups;
    };

    const groupedModels = groupByProvider(filteredModels);

    const toggleModel = async (modelId: string, newEnabled: boolean) => {
        try {
            const currentOverrides = modelOverrides;
            const baseEnabled = baseEnabledState[modelId] ?? false;
            const newOverrides = { ...currentOverrides };

            // If the new state matches the base state, remove the override
            if (newEnabled === baseEnabled) {
                delete newOverrides[modelId];
            } else {
                // Otherwise, set the override
                newOverrides[modelId] = newEnabled;
            }

            await updateAIUserPreferencesMutation.mutateAsync({
                modelOverrides: Object.keys(newOverrides).length > 0 ? newOverrides : undefined,
            });

            toast.success(newEnabled ? t`Model enabled` : t`Model disabled`);
        } catch (error) {
            toast.error(t`Failed to update model`);
            console.error(error);
        }
    };

    const enableAll = async () => {
        try {
            const newOverrides: Record<string, boolean> = {};

            models.forEach((model) => {
                const baseEnabled = baseEnabledState[model.id] ?? false;

                if (!baseEnabled) {
                    newOverrides[model.id] = true;
                }
            });

            await updateAIUserPreferencesMutation.mutateAsync({
                modelOverrides: Object.keys(newOverrides).length > 0 ? newOverrides : undefined,
            });

            toast.success(t`All models enabled`);
        } catch (error) {
            toast.error(t`Failed to enable all models`);
            console.error(error);
        }
    };

    const disableAll = async () => {
        try {
            await updateAIUserPreferencesMutation.mutateAsync({
                modelOverrides: undefined,
            });

            toast.success(t`All models disabled (reset to defaults)`);
        } catch (error) {
            toast.error(t`Failed to disable all models`);
            console.error(error);
        }
    };

    const resetToDefaults = async () => {
        try {
            await updateAIUserPreferencesMutation.mutateAsync({
                modelOverrides: undefined,
            });

            toast.success(t`Reset to defaults`);
        } catch (error) {
            toast.error(t`Failed to reset to defaults`);
            console.error(error);
        }
    };

    const enableByProvider = async (provider: string) => {
        try {
            const currentOverrides = modelOverrides;
            const newOverrides = { ...currentOverrides };
            const providerModels = models.filter((model) => model.provider === provider);

            providerModels.forEach((model) => {
                const baseEnabled = baseEnabledState[model.id] ?? false;

                if (baseEnabled) {
                    // Remove override if it exists (back to base state)
                    delete newOverrides[model.id];
                } else {
                    newOverrides[model.id] = true;
                }
            });

            await updateAIUserPreferencesMutation.mutateAsync({
                modelOverrides: Object.keys(newOverrides).length > 0 ? newOverrides : undefined,
            });

            toast.success(t`All ${provider} models enabled`);
        } catch (error) {
            toast.error(t`Failed to enable models by provider`);
            console.error(error);
        }
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{t`Models`}</CardTitle>
                            <CardDescription className="text-muted-foreground mt-1 text-xs">
                                {t`Enable or disable models to control which ones appear in the model selector.`} {enabledCount} / {models.length}
                            </CardDescription>
                        </div>
                        <div className="flex gap-2">
                            <Button onClick={enableAll} size="sm" variant="outline">
                                {t`Enable All`}
                            </Button>
                            <Button onClick={disableAll} size="sm" variant="outline">
                                {t`Disable All`}
                            </Button>
                            <Button onClick={resetToDefaults} size="sm" variant="outline">
                                <RotateCcw aria-hidden="true" className="mr-2 size-4" />
                                {t`Reset to Defaults`}
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Search and Filters */}
                    <div className="space-y-3">
                        <div className="relative">
                            <Search aria-hidden="true" className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                            <Input
                                className="pl-9"
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder={t`Search models by name, ID, or provider...`}
                                value={searchQuery}
                            />
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                className="h-8 text-xs"
                                onClick={() => setShowFilters(!showFilters)}
                                size="sm"
                                variant={showFilters ? "default" : "outline"}
                            >
                                <Filter aria-hidden="true" className="mr-1.5 size-3" />
                                {t`Filters`}
                                {activeFilters.size > 0 && <Badge className="ml-1.5 h-4 px-1 text-[10px]">{activeFilters.size}</Badge>}
                            </Button>

                            {providers.length > 0 && (
                                <div className="flex items-center gap-1">
                                    <Label className="text-muted-foreground text-xs" htmlFor="models-provider-filter">
                                        {t`Provider:`}
                                    </Label>
                                    <select
                                        className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                                        id="models-provider-filter"
                                        onChange={(e) => setSelectedProvider(e.target.value || null)}
                                        value={selectedProvider || ""}
                                    >
                                        <option value="">{t`All`}</option>
                                        {providers.map((provider) => (
                                            <option key={provider} value={provider}>
                                                {provider}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {modes.length > 0 && (
                                <div className="flex items-center gap-1">
                                    <Label className="text-muted-foreground text-xs" htmlFor="models-mode-filter">
                                        {t`Mode:`}
                                    </Label>
                                    <select
                                        className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                                        id="models-mode-filter"
                                        onChange={(e) => setSelectedMode(e.target.value || null)}
                                        value={selectedMode || ""}
                                    >
                                        <option value="">{t`All`}</option>
                                        {modes.map((mode) => (
                                            <option key={mode} value={mode}>
                                                {filterValueLabel(mode)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {states.length > 0 && (
                                <div className="flex items-center gap-1">
                                    <Label className="text-muted-foreground text-xs" htmlFor="models-state-filter">
                                        {t`State:`}
                                    </Label>
                                    <select
                                        className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                                        id="models-state-filter"
                                        onChange={(e) => setSelectedState(e.target.value || null)}
                                        value={selectedState || ""}
                                    >
                                        <option value="">{t`All`}</option>
                                        {states.map((state) => (
                                            <option key={state} value={state}>
                                                {filterValueLabel(state)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {hasActiveFilters && (
                                <Button className="h-8 text-xs" onClick={clearFilters} size="sm" variant="ghost">
                                    <X aria-hidden="true" className="mr-1.5 size-3" />
                                    {t`Clear`}
                                </Button>
                            )}
                        </div>

                        {/* Filters Panel */}
                        {showFilters && (
                            <div className="bg-muted/30 rounded-lg border p-3">
                                <div className="text-muted-foreground mb-2 text-xs font-medium">{t`Capabilities`}</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {FILTER_CAPABILITIES.map((filter) => {
                                        const isActive = activeFilters.has(filter.key);

                                        return (
                                            <Button
                                                className={clsx(
                                                    "h-6 px-2 text-[11px]",
                                                    isActive ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
                                                )}
                                                key={filter.key}
                                                onClick={() => toggleFilter(filter.key)}
                                                size="sm"
                                                variant={isActive ? "default" : "outline"}
                                            >
                                                {i18n._(filter.label)}
                                            </Button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>

                    <Separator />

                    {/* Models List */}
                    {filteredModels.length === 0 ? (
                        <div className="text-muted-foreground py-8 text-center text-sm">{t`No models found matching your filters.`}</div>
                    ) : (
                        <div className="space-y-6">
                            {Array.from(groupedModels.entries(), ([provider, providerModels]) => (
                                <div className="space-y-3" key={provider}>
                                    <div className="flex items-center justify-between">
                                        <Heading className="text-sm font-semibold" fallbackLevel={3}>
                                            {provider === OTHER_PROVIDER ? t`Other` : provider}
                                        </Heading>
                                        <Button className="h-7 text-xs" onClick={() => enableByProvider(provider)} size="sm" variant="ghost">
                                            {t`Enable All`}
                                        </Button>
                                    </div>
                                    <div className="space-y-2">
                                        {providerModels.map((model) => {
                                            const isEnabled = currentEnabledState[model.id] ?? false;
                                            const baseEnabled = baseEnabledState[model.id] ?? false;
                                            const isOverridden = modelOverrides[model.id] !== undefined;

                                            return (
                                                <div
                                                    className={clsx(
                                                        "flex items-center justify-between rounded-lg border p-3 transition-colors",
                                                        isOverridden && "bg-muted/50",
                                                    )}
                                                    key={model.id}
                                                >
                                                    <div className="flex min-w-0 flex-1 items-center gap-3">
                                                        {model.displayProvider && (
                                                            <ProviderIcon
                                                                className="size-3"
                                                                provider={model.provider || model.displayProvider}
                                                                providerIcon={model.displayProvider}
                                                            />
                                                        )}
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-leftfont-medium flex-1 truncate">{model.name ?? model.id}</span>
                                                                {model.isPremium && (
                                                                    <Badge
                                                                        className={clsx(
                                                                            "bg-purple-500/10 text-purple-600 dark:text-purple-400",
                                                                            "px-1.5 py-0.5 text-[10px]",
                                                                        )}
                                                                    >
                                                                        {t`Pro`}
                                                                    </Badge>
                                                                )}
                                                                {model.isNew && (
                                                                    <Badge
                                                                        className={clsx(
                                                                            "bg-green-500/10 text-green-600 dark:text-green-400",
                                                                            "px-1.5 py-0.5 text-[10px]",
                                                                        )}
                                                                    >
                                                                        {t`New`}
                                                                    </Badge>
                                                                )}
                                                                {!model.isPremium && (
                                                                    <Badge
                                                                        className={clsx(
                                                                            "bg-blue-500/10 text-blue-600 dark:text-blue-400",
                                                                            "px-1.5 py-0.5 text-[10px]",
                                                                        )}
                                                                    >
                                                                        {t`Free`}
                                                                    </Badge>
                                                                )}
                                                                {isOverridden && (
                                                                    <Badge
                                                                        className={clsx(
                                                                            "bg-orange-500/10 text-orange-600 dark:text-orange-400",
                                                                            "px-1.5 py-0.5 text-[10px]",
                                                                        )}
                                                                        title={baseEnabled ? t`Overridden: Enabled` : t`Overridden: Disabled`}
                                                                    >
                                                                        {t`Overridden`}
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                            {model.name && <p className="text-muted-foreground text-xs">{model.name}</p>}
                                                            {model.filterCapabilities && model.filterCapabilities.length > 0 && (
                                                                <div className="mt-1 flex flex-wrap gap-1">
                                                                    {model.filterCapabilities.map((cap) => (
                                                                        <Badge className="px-1 py-0 text-[10px]" key={cap} variant="outline">
                                                                            {capabilityLabel(cap)}
                                                                        </Badge>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <Switch checked={isEnabled} onCheckedChange={(checked) => toggleModel(model.id, checked)} />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
};

export default ModelsSettings;
