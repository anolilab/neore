"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import {
    Command,
    CommandCollection,
    CommandEmpty,
    CommandGroup,
    CommandGroupLabel,
    CommandInput,
    CommandItem,
    CommandList,
    CommandPanel,
} from "@neore/ui/components/command";
import cn from "@neore/ui/utils/cn";
import { CheckIcon, CheckSquare2, Image, Info, Layers2, Lock, Mic, Square, Star, Type, Video } from "lucide-react";
import type { FC, ReactNode } from "react";
import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { trackEvent } from "@/lib/analytics";
import { localizeModelDescription } from "@/lib/model-descriptions";

import {
    filterModelsByQuery,
    getCreatorDisplayName,
    getCreatorSlug,
    getModelCapabilities,
    getModelMode,
    getModelModeName,
    getModelSearchText,
    groupModelsByCreator,
    stripProviderPrefix,
} from "./utilities";

const getCostMultiplier = (costPer1M: number | null | undefined): string | null => {
    if (!costPer1M || costPer1M <= 0) {
        return null;
    }

    if (costPer1M >= 20) {
        return "10×";
    }

    if (costPer1M >= 8) {
        return "5×";
    }

    if (costPer1M >= 3) {
        return "3×";
    }

    if (costPer1M >= 1.5) {
        return "2×";
    }

    return null;
};

/** Display labels keyed by the stable capability label from `getModelCapabilities`. */
const CAPABILITY_DISPLAY: Record<string, MessageDescriptor> = {
    "Effort Control": msg`Effort Control`,
    Fast: msg`Fast`,
    "Image Generation": msg`Image Gen`,
    "PDF Comprehension": msg`PDF`,
    Reasoning: msg`Extended Thinking`,
    "Tool Calling": msg`Tool Calling`,
    Vision: msg`Vision`,
};

export type ModelPickerTab = "all" | "starred";
export type ModelPickerSelectionMode = "single" | "parallel";
export type ModelModeFilter = "text" | "image" | "video" | "speech-to-text" | null;

export interface ModelPickerProps {
    /** Optional initial mode filter */
    defaultModeFilter?: ModelModeFilter;
    defaultTab?: ModelPickerTab;
    /** Starred model ids (controlled from outside — e.g. user settings) */
    favorites?: string[];
    footer: ReactNode;
    /** Hide the mode filter toggles */
    hideModeFilter?: boolean;
    initialModelId?: string;
    initialModelIds?: string[];
    /** When true, disables model selection and shows an upgrade banner */
    isAnonymous?: boolean;
    /** Optional filtered model list — defaults to feature-flagged gateway models when not provided */
    models?: GatewayModel[];
    onSelect?: (modelId: string) => void;
    onSelectMultiple?: (modelIds: string[]) => void;
    /** Called when the user stars/un-stars a model */
    onToggleFavorite?: (modelId: string, isFavorite: boolean) => void;
    panelClassName?: string;
}

interface ModelItem {
    icon?: ReactNode;
    label: string;
    model: GatewayModel;
    onSelect: () => void;
    value: string;
}

interface ModelGroup {
    isFavorite?: boolean;
    items: ModelItem[];
    value: string;
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

const ModelDetailPanel = memo<{ model: GatewayModel }>(({ model }) => {
    const { i18n } = useLingui();
    const displayCapability = (label: string): string => {
        const descriptor = CAPABILITY_DISPLAY[label];

        return descriptor ? i18n._(descriptor) : label;
    };
    const creatorSlug = getCreatorSlug(model);
    const creatorName = getCreatorDisplayName(creatorSlug);
    const capabilities = getModelCapabilities(model);

    // Provider display
    const providerDisplay = model.displayProvider ?? creatorName;
    // Developer: fall back to creator
    const developerDisplay = creatorName;

    return (
        <div className="flex w-full flex-col overflow-y-auto">
            {/* Header */}
            <div className="flex items-center gap-3 p-4 pb-3">
                <ProviderIcon className="size-8 shrink-0" provider={model.provider || model.displayProvider || ""} providerIcon={creatorSlug} />
                <div className="min-w-0">
                    <p className="text-foreground truncate text-[13px] leading-snug font-semibold">{stripProviderPrefix(model.name ?? model.id)}</p>
                    <p className="text-muted-foreground/50 text-[11px]">{developerDisplay}</p>
                </div>
            </div>

            {/* Description */}
            {model.desc ? (
                <div className="border-border/40 border-t px-4 py-3">
                    <p className="text-muted-foreground/40 mb-1.5 text-[9px] font-semibold tracking-widest uppercase">
                        <Trans>Description</Trans>
                    </p>
                    <p className="text-muted-foreground text-[11.5px] leading-relaxed">
                        {localizeModelDescription(model.desc, (descriptor) => i18n._(descriptor))}
                    </p>
                </div>
            ) : null}

            {/* Features */}
            {capabilities.length > 0 ? (
                <div className="border-border/40 border-t px-4 py-3">
                    <p className="text-muted-foreground/40 mb-1.5 text-[9px] font-semibold tracking-widest uppercase">
                        <Trans>Features</Trans>
                    </p>
                    <div className="flex flex-wrap gap-1">
                        {capabilities.map((cap) => (
                            <span
                                className="border-border/40 text-muted-foreground bg-muted/50 inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-medium"
                                key={cap.label}
                            >
                                {displayCapability(cap.label)}
                            </span>
                        ))}
                    </div>
                </div>
            ) : null}

            {/* Metadata */}
            <div className="border-border/40 border-t px-4 py-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <div>
                        <p className="text-muted-foreground/40 mb-0.5 text-[9px] font-semibold tracking-widest uppercase">
                            <Trans>Provider</Trans>
                        </p>
                        <p className="text-foreground text-[11.5px] font-medium">{providerDisplay}</p>
                    </div>
                    <div>
                        <p className="text-muted-foreground/40 mb-0.5 text-[9px] font-semibold tracking-widest uppercase">
                            <Trans>Developer</Trans>
                        </p>
                        <p className="text-foreground text-[11.5px] font-medium">{developerDisplay}</p>
                    </div>
                </div>
            </div>
        </div>
    );
});

// ─── Provider Sidebar Button ──────────────────────────────────────────────────

const ProviderSidebarButton = memo<{
    icon: ReactNode;
    isSelected: boolean;
    label: string;
    onClick: () => void;
    showBorder?: boolean;
}>(({ icon, isSelected, label, onClick, showBorder = false }) => (
    <button
        aria-label={label}
        className={cn(
            "relative flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150",
            showBorder && "mb-0.5 border-b pb-2",
            isSelected
                ? "text-foreground before:bg-primary before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded-full"
                : "text-muted-foreground/70 hover:text-foreground",
        )}
        onClick={onClick}
        type="button"
    >
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
        <span className={cn("truncate text-[12px]", isSelected ? "font-medium" : "font-normal")}>{label}</span>
    </button>
));

// ─── Model Row ────────────────────────────────────────────────────────────────

// ─── Provider Sidebar Item ─────────────────────────────────────────────────────
// Memoized wrapper so that each item creates stable onClick and icon references

const ProviderSidebarItem = memo<{
    isSelected: boolean;
    name: string;
    onSelect: (slug: string) => void;
    slug: string;
}>(({ isSelected, name, onSelect, slug }) => {
    const handleClick = () => onSelect(slug);
    const icon = <ProviderIcon className="size-3.5" provider={name} providerIcon={slug} />;

    return <ProviderSidebarButton icon={icon} isSelected={isSelected} label={name} onClick={handleClick} />;
});

// ─── Model Row ────────────────────────────────────────────────────────────────

const ModelItemContent = memo<{
    isFavorite: boolean;
    isInfoActive: boolean;
    isSelected: boolean;
    model: GatewayModel;
    onInfo: (modelId: string) => void;
    onInfoLeave: () => void;
    onToggleFavorite: (modelId: string, setFavorite: boolean) => void;
    selectionMode: ModelPickerSelectionMode;
}>(({ isFavorite, isInfoActive, isSelected, model, onInfo, onInfoLeave, onToggleFavorite, selectionMode }) => {
    const { i18n, t } = useLingui();
    const costMultiplier = getCostMultiplier(model.pricing?.input_per_million);

    return (
        <div className="flex min-w-0 flex-1 items-center gap-2">
            {/* Name + badges */}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-[13px] leading-none font-medium">{stripProviderPrefix(model.name ?? model.id)}</span>
                    {model.isPremium ? (
                        <span className="shrink-0 rounded-[3px] bg-amber-500/15 px-1 py-0 text-[9px] font-semibold tracking-wide text-amber-600 uppercase dark:bg-amber-400/15 dark:text-amber-400">
                            <Trans>Pro</Trans>
                        </span>
                    ) : null}
                    {costMultiplier ? <span className="text-muted-foreground/40 shrink-0 text-[10px] tabular-nums">{costMultiplier}</span> : null}
                    {model.isNew ? (
                        <span className="shrink-0 rounded-[3px] bg-emerald-500/12 px-1 py-0 text-[9px] font-semibold tracking-wide text-emerald-600 uppercase dark:bg-emerald-400/15 dark:text-emerald-400">
                            <Trans>New</Trans>
                        </span>
                    ) : null}
                </div>
                {model.desc ? (
                    <span className="text-muted-foreground/50 truncate text-[11px] leading-none">
                        {localizeModelDescription(model.desc, (descriptor) => i18n._(descriptor))}
                    </span>
                ) : null}
            </div>

            {/* Actions — reveal on hover */}
            <div className="flex shrink-0 items-center gap-0.5">
                <button
                    aria-label={isFavorite ? t`Remove from starred` : t`Add to starred`}
                    className={cn(
                        "rounded p-1 transition-all duration-100",
                        isFavorite ? "text-amber-400 opacity-100" : "text-muted-foreground/30 opacity-0 group-hover/row:opacity-100 hover:text-amber-400",
                    )}
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggleFavorite(model.id, !isFavorite);
                    }}
                    type="button"
                >
                    <Star className={cn("size-3.5", isFavorite && "fill-current")} />
                </button>
                <button
                    aria-label={t`Model info`}
                    className={cn(
                        "rounded p-1 transition-all duration-100",
                        isInfoActive
                            ? "text-foreground opacity-100"
                            : "text-muted-foreground/40 hover:text-foreground opacity-40 group-hover/row:opacity-70 hover:!opacity-100",
                    )}
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onInfo(model.id);
                    }}
                    onMouseEnter={() => onInfo(model.id)}
                    onMouseLeave={onInfoLeave}
                    type="button"
                >
                    <Info className="size-3.5" />
                </button>
                {selectionMode === "single" ? (
                    <span className="ml-0.5 flex size-3.5 shrink-0 items-center justify-center">
                        {isSelected ? <CheckIcon className="text-primary size-3.5" /> : null}
                    </span>
                ) : null}
            </div>
        </div>
    );
});

// ─── Model Group ──────────────────────────────────────────────────────────────

const ModelGroupRenderer = memo<{
    anchorMode: string | null;
    group: ModelGroup;
    infoModelId?: string;
    isAnonymous?: boolean;
    isFavorite: (id: string) => boolean;
    onInfo: (modelId: string) => void;
    onInfoLeave: () => void;
    parallelMaxReached: boolean;
    parallelSelectedIds: Set<string>;
    selectedModelId?: string;
    selectionMode: ModelPickerSelectionMode;
    showGroupLabel?: boolean;
    showProviderIcon?: boolean;
    toggleFavorite: (id: string, isFavorite: boolean) => void;
}>(
    ({
        anchorMode,
        group,
        infoModelId,
        isAnonymous = false,
        isFavorite,
        onInfo,
        onInfoLeave,
        parallelMaxReached,
        parallelSelectedIds,
        selectedModelId,
        selectionMode,
        showGroupLabel = true,
        showProviderIcon = false,
        toggleFavorite,
    }) => {
        const { t } = useLingui();

        return (
            <CommandGroup items={group.items}>
                {showGroupLabel ? (
                    <CommandGroupLabel className="text-muted-foreground/40 px-3 pt-3 pb-0.5 text-[10px] font-semibold tracking-widest uppercase">
                        {group.value}
                    </CommandGroupLabel>
                ) : null}
                <CommandCollection>
                    {(item: ModelItem) => {
                        const isParallelSelected = parallelSelectedIds.has(item.model.id);
                        const isSelected = selectionMode === "parallel" ? isParallelSelected : selectedModelId === item.value;
                        // A model is type-locked when a different mode is already anchored via the first selection
                        const isTypeMismatch =
                            selectionMode === "parallel" && anchorMode !== null && getModelMode(item.model) !== anchorMode && !isParallelSelected;
                        const isLockedForAnonymous = isAnonymous && item.model.id !== selectedModelId;
                        const isDisabled =
                            isLockedForAnonymous || (selectionMode === "parallel" && ((parallelMaxReached && !isParallelSelected) || isTypeMismatch));

                        let stateClassName = "";
                        let lockedTitle: string | undefined;

                        if (isLockedForAnonymous) {
                            stateClassName = "cursor-not-allowed opacity-40";
                            lockedTitle = t`Sign up to unlock all models`;
                        } else if (isTypeMismatch) {
                            stateClassName = "cursor-not-allowed opacity-25";
                            lockedTitle = t`Only ${getModelModeName(anchorMode!)} models can be compared. Clear selection to switch types.`;
                        } else if (isDisabled) {
                            stateClassName = "cursor-not-allowed opacity-40";
                        }

                        let parallelIndicator: ReactNode;

                        if (isTypeMismatch) {
                            parallelIndicator = <Lock className="text-muted-foreground/30 size-4" />;
                        } else if (isParallelSelected) {
                            parallelIndicator = <CheckSquare2 className="text-primary size-4" />;
                        } else {
                            parallelIndicator = <Square className={cn("size-4", isDisabled ? "text-muted-foreground/20" : "text-muted-foreground/30")} />;
                        }

                        return (
                            <CommandItem
                                className={cn(
                                    "group/row mx-1.5 flex-row !items-center rounded-md px-2 py-2 transition-colors duration-100",
                                    isSelected && selectionMode === "single" ? "bg-accent/60" : "",
                                    isParallelSelected && selectionMode === "parallel" ? "bg-accent/40" : "",
                                    stateClassName,
                                )}
                                key={item.value}
                                onClick={(e: React.MouseEvent & { preventBaseUIHandler?: () => void }) => {
                                    e.preventBaseUIHandler?.();

                                    if (isLockedForAnonymous) {
                                        trackEvent("signup_wall_shown", { trigger: "model_picker" });
                                    }

                                    if (!isDisabled) {
                                        item.onSelect();
                                    }
                                }}
                                title={lockedTitle}
                                value={item.value}
                            >
                                {/* Anonymous lock icon */}
                                {isLockedForAnonymous ? (
                                    <span className="mr-2 flex shrink-0 items-center justify-center">
                                        <Lock className="text-muted-foreground/30 size-4" />
                                    </span>
                                ) : null}

                                {/* Parallel checkbox / lock */}
                                {!isLockedForAnonymous && selectionMode === "parallel" ? (
                                    <span className="mr-2 flex shrink-0 items-center justify-center">{parallelIndicator}</span>
                                ) : null}

                                {/* Provider icon — only shown on starred tab */}
                                {showProviderIcon ? (
                                    <ProviderIcon
                                        className="mr-2 size-5 shrink-0"
                                        provider={item.model.provider || item.model.displayProvider || ""}
                                        providerIcon={item.model.id.split("/", 1)[0] || item.model.displayProvider || ""}
                                    />
                                ) : null}

                                <ModelItemContent
                                    isFavorite={isFavorite(item.model.id)}
                                    isInfoActive={infoModelId === item.model.id}
                                    isSelected={isSelected}
                                    model={item.model}
                                    onInfo={onInfo}
                                    onInfoLeave={onInfoLeave}
                                    onToggleFavorite={toggleFavorite}
                                    selectionMode={selectionMode}
                                />
                            </CommandItem>
                        );
                    }}
                </CommandCollection>
            </CommandGroup>
        );
    },
);

// ─── Main ─────────────────────────────────────────────────────────────────────

const MAX_PARALLEL = 6;

// Stable icon for the "All providers" sidebar button. Module-level rather than a
// `useMemo` with an empty dependency array, which is not a stability guarantee.
const ALL_PROVIDERS_ICON = <Layers2 className="size-3.5" />;

// Module-level so the default never mints a new array identity per render.
const NO_FAVORITES: string[] = [];

const ModelPicker: FC<ModelPickerProps> = ({
    defaultModeFilter = null,
    defaultTab = "starred",
    favorites = NO_FAVORITES,
    footer,
    hideModeFilter = false,
    initialModelId,
    initialModelIds,
    isAnonymous = false,
    models: modelsProp,
    onSelect,
    onSelectMultiple,
    onToggleFavorite,
    panelClassName,
}) => {
    const { i18n, t } = useLingui();

    // Use provided models list or fall back to the feature-flagged gateway models
    const featureFlaggedModels = useFeatureFlaggedModels();
    const sourceModels = useMemo(() => modelsProp ?? featureFlaggedModels, [modelsProp, featureFlaggedModels]);

    // Compute provider sidebar info from the current source models
    const creatorInfo = useMemo<{ name: string; slug: string }[]>(() => {
        const seen = new Set<string>();
        const creators: { name: string; slug: string }[] = [];

        for (const m of sourceModels) {
            const slug = getCreatorSlug(m);

            if (slug && !seen.has(slug)) {
                seen.add(slug);
                creators.push({ name: getCreatorDisplayName(slug), slug });
            }
        }

        return creators.toSorted((a, b) => a.name.localeCompare(b.name));
    }, [sourceModels]);

    const [selectedModelId, setSelectedModelId] = useState<string | undefined>(initialModelId);
    const [parallelSelectedIds, setParallelSelectedIds] = useState<Set<string>>(() => new Set(initialModelIds));
    const [searchQuery, setSearchQuery] = useState("");
    const [activeTab, setActiveTab] = useState<ModelPickerTab>(defaultTab);
    const [selectionMode, setSelectionMode] = useState<ModelPickerSelectionMode>(() => ((initialModelIds?.length ?? 0) > 0 ? "parallel" : "single"));
    const [infoModelId, setInfoModelId] = useState<string | undefined>();
    const [modeFilter, setModeFilter] = useState<ModelModeFilter>(defaultModeFilter);

    const pickerRef = useRef<HTMLDivElement>(null);
    const onSelectRef = useRef(onSelect);
    const onSelectMultipleRef = useRef(onSelectMultiple);

    // Update callback refs after render to keep them fresh without mutating during render
    useLayoutEffect(() => {
        onSelectRef.current = onSelect;
        onSelectMultipleRef.current = onSelectMultiple;
    });

    const favoriteModelIds = favorites;
    const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites]);
    const toggleFavorite = useCallback((id: string, setFavorite: boolean) => onToggleFavorite?.(id, setFavorite), [onToggleFavorite]);

    const [selectedProvider, setSelectedProvider] = useState<string | null>(() => {
        if (initialModelId) {
            const slug = initialModelId.split("/", 1)[0];

            if (slug) {
                return slug;
            }
        }

        return null;
    });

    const handleModelSelect = useCallback(
        (modelId: string) => {
            if (selectionMode === "parallel") {
                setParallelSelectedIds((previous) => {
                    const next = new Set(previous);

                    if (next.has(modelId)) {
                        next.delete(modelId);
                    } else if (next.size < MAX_PARALLEL) {
                        next.add(modelId);
                    }

                    return next;
                });
            } else {
                setSelectedModelId(modelId);
                onSelectRef.current?.(modelId);
            }
        },
        [selectionMode],
    );

    const infoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const cancelInfoClose = useCallback(() => {
        if (!infoCloseTimer.current) {
            return;
        }

        clearTimeout(infoCloseTimer.current);
        infoCloseTimer.current = null;
    }, []);

    const scheduleInfoClose = useCallback(() => {
        cancelInfoClose();
        infoCloseTimer.current = setTimeout(setInfoModelId, 200, undefined);
    }, [cancelInfoClose]);

    const handleInfo = useCallback(
        (modelId: string) => {
            cancelInfoClose();
            setInfoModelId(modelId);
        },
        [cancelInfoClose],
    );

    const handleProviderSelect = useCallback((slug: string | null) => {
        setSelectedProvider(slug);
        setSearchQuery("");
    }, []);

    // Stable callback for selecting "All" (null slug) — avoids inline arrow in JSX
    const handleProviderSelectAll = useCallback(() => handleProviderSelect(null), [handleProviderSelect]);

    const handleTabChange = useCallback((tab: ModelPickerTab) => {
        setActiveTab(tab);
        setSelectedProvider(null);
        setSearchQuery("");
        setInfoModelId(undefined);
    }, []);

    const handleSelectionModeChange = useCallback((mode: ModelPickerSelectionMode) => {
        setSelectionMode(mode);
        setInfoModelId(undefined);

        if (mode === "single") {
            setParallelSelectedIds(new Set());
        }
    }, []);

    const { favoriteModels, regularModels } = useMemo(() => {
        const favoriteIdsSet = new Set(favoriteModelIds);
        const favoriteEntries: GatewayModel[] = [];
        const regulars: GatewayModel[] = [];
        const hasSearchQuery = searchQuery.trim().length > 0;
        const isFilterByProvider = !hasSearchQuery && selectedProvider !== null && activeTab === "all";

        for (const model of sourceModels) {
            if (activeTab === "starred" && !favoriteIdsSet.has(model.id)) {
                continue;
            }

            if (isFilterByProvider && getCreatorSlug(model) !== selectedProvider) {
                continue;
            }

            // Filter by mode if a mode filter is active
            if (modeFilter !== null && getModelMode(model) !== modeFilter) {
                continue;
            }

            if (favoriteIdsSet.has(model.id)) {
                favoriteEntries.push(model);
            } else {
                regulars.push(model);
            }
        }

        return { favoriteModels: favoriteEntries, regularModels: regulars };
    }, [favoriteModelIds, selectedProvider, searchQuery, activeTab, sourceModels, modeFilter]);

    const createModelItems = useCallback(
        (models: GatewayModel[]): ModelItem[] =>
            models.map((model) => {
                return {
                    icon: undefined,
                    label: model.name ?? model.id,
                    model,
                    onSelect: () => handleModelSelect(model.id),
                    value: model.id,
                };
            }),
        [handleModelSelect],
    );

    const groupedItems = useMemo(() => {
        const groups: ModelGroup[] = [];

        if (activeTab === "starred") {
            const grouped = groupModelsByCreator(favoriteModels);

            for (const [creator, creatorModels] of grouped.entries()) {
                groups.push({ isFavorite: true, items: createModelItems(creatorModels), value: creator });
            }
        } else {
            const allModels = [...favoriteModels, ...regularModels];
            const grouped = groupModelsByCreator(allModels);

            for (const [creator, creatorModels] of grouped.entries()) {
                groups.push({ items: createModelItems(creatorModels), value: creator });
            }
        }

        return groups;
    }, [favoriteModels, regularModels, activeTab, createModelItems]);

    // One search text per model per locale (`i18n` is a new object on every
    // locale change), so a keystroke only runs `includes` over prebuilt strings.
    const searchTexts = useMemo(
        () =>
            new Map(
                sourceModels.map((model) => [
                    model.id,
                    getModelSearchText(
                        model,
                        localizeModelDescription(model.desc, (descriptor) => i18n._(descriptor)),
                    ),
                ]),
            ),
        [sourceModels, i18n],
    );

    const filteredGroupedItems = useMemo(() => {
        if (!searchQuery.trim()) {
            return groupedItems;
        }

        const filtered: ModelGroup[] = [];

        for (const group of groupedItems) {
            const filteredItems = filterModelsByQuery(group.items, searchQuery, searchTexts);

            if (filteredItems.length > 0) {
                filtered.push({ ...group, items: filteredItems });
            }
        }

        return filtered;
    }, [groupedItems, searchQuery, searchTexts]);

    const infoModel = useMemo(() => {
        if (!infoModelId) {
            return undefined;
        }

        return sourceModels.find((m) => m.id === infoModelId);
    }, [infoModelId, sourceModels]);

    const isParallelMaxReached = parallelSelectedIds.size >= MAX_PARALLEL;
    const isShowProviderSidebar = activeTab === "all" && !searchQuery.trim();
    const isStarredEmpty = activeTab === "starred" && favoriteModels.length === 0 && !searchQuery.trim();
    const isShowGroupLabels = activeTab !== "starred";

    // Derive the "anchor" mode from the first selected model in parallel mode.
    // All other types are locked out once a selection is made.
    const anchorMode = useMemo(() => {
        if (parallelSelectedIds.size === 0) {
            return null;
        }

        const firstId = [...parallelSelectedIds][0];
        const firstModel = sourceModels.find((m) => m.id === firstId);

        return firstModel ? getModelMode(firstModel) : null;
    }, [parallelSelectedIds, sourceModels]);

    return (
        <PopoverPrimitive.Root
            onOpenChange={(open) => {
                if (!open) {
                    setInfoModelId(undefined);
                }
            }}
            open={!!infoModel}
        >
            <div ref={pickerRef}>
                <Command filter={() => true} items={filteredGroupedItems} onValueChange={setSearchQuery} value={searchQuery}>
                    {isAnonymous && (
                        <div className="flex items-center gap-2.5 border-b bg-amber-50 px-3 py-2.5 dark:bg-amber-950/20">
                            <Lock className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                            <p className="text-[12px] leading-snug text-amber-700 dark:text-amber-300">
                                {t`Guest accounts use free models only.`}{" "}
                                <a className="font-semibold underline underline-offset-2" href="/auth/sign-up">
                                    {t`Subscribe for $8/mo to unlock all models.`}
                                </a>
                            </p>
                        </div>
                    )}
                    <CommandInput placeholder={t`Search models...`} />

                    {/* Tab bar */}
                    <div className="flex items-center border-t">
                        <div className="flex">
                            <button
                                className={cn(
                                    "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12.5px] font-medium transition-colors duration-150",
                                    activeTab === "starred"
                                        ? "text-foreground border-foreground -mb-px"
                                        : "text-muted-foreground/60 hover:text-foreground border-transparent",
                                )}
                                onClick={() => handleTabChange("starred")}
                                type="button"
                            >
                                <Star className={cn("size-3", activeTab === "starred" ? "fill-amber-400 text-amber-400" : "opacity-50")} />
                                {t`Starred`}
                            </button>
                            <button
                                className={cn(
                                    "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12.5px] font-medium transition-colors duration-150",
                                    activeTab === "all"
                                        ? "text-foreground border-foreground -mb-px"
                                        : "text-muted-foreground/60 hover:text-foreground border-transparent",
                                )}
                                onClick={() => handleTabChange("all")}
                                type="button"
                            >
                                <Layers2 className={cn("size-3", activeTab === "all" ? "opacity-80" : "opacity-40")} />
                                {t`All models`}
                            </button>
                        </div>

                        {/* Pill toggle — hidden for anonymous users */}
                        {!isAnonymous && (
                            <div className="mr-2 ml-auto">
                                <div className="bg-muted/70 flex items-center rounded-md p-0.5">
                                    <button
                                        className={cn(
                                            "rounded-[5px] px-2.5 py-1 text-[11.5px] font-medium transition-all duration-150",
                                            selectionMode === "single"
                                                ? "bg-background text-foreground shadow-sm"
                                                : "text-muted-foreground/50 hover:text-muted-foreground",
                                        )}
                                        onClick={() => handleSelectionModeChange("single")}
                                        type="button"
                                    >
                                        {t`Single`}
                                    </button>
                                    <button
                                        className={cn(
                                            "rounded-[5px] px-2.5 py-1 text-[11.5px] font-medium transition-all duration-150",
                                            selectionMode === "parallel"
                                                ? "bg-background text-foreground shadow-sm"
                                                : "text-muted-foreground/50 hover:text-muted-foreground",
                                        )}
                                        onClick={() => handleSelectionModeChange("parallel")}
                                        type="button"
                                    >
                                        {t`Parallel`}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Mode filter row */}
                    {!hideModeFilter && (
                        <div className="flex items-center gap-1 border-t px-2 py-1.5">
                            <span className="text-muted-foreground/50 mr-1 text-[10px] font-medium tracking-wider uppercase">{t`Type`}</span>
                            <button
                                className={cn(
                                    "rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                    modeFilter === null ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                                )}
                                onClick={() => setModeFilter(null)}
                                type="button"
                            >
                                {t`All`}
                            </button>
                            <button
                                className={cn(
                                    "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                    modeFilter === "text" ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                                )}
                                onClick={() => setModeFilter("text")}
                                type="button"
                            >
                                <Type className="size-3" />
                                {t`Text`}
                            </button>
                            <button
                                className={cn(
                                    "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                    modeFilter === "image" ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                                )}
                                onClick={() => setModeFilter("image")}
                                type="button"
                            >
                                <Image className="size-3" />
                                {t`Image`}
                            </button>
                            <button
                                className={cn(
                                    "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                    modeFilter === "video" ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                                )}
                                onClick={() => setModeFilter("video")}
                                type="button"
                            >
                                <Video className="size-3" />
                                {t`Video`}
                            </button>
                            <button
                                className={cn(
                                    "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                    modeFilter === "speech-to-text"
                                        ? "bg-primary/10 text-primary"
                                        : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                                )}
                                onClick={() => setModeFilter("speech-to-text")}
                                type="button"
                            >
                                <Mic className="size-3" />
                                {t`Audio`}
                            </button>
                        </div>
                    )}

                    <CommandPanel className={cn("flex h-60 flex-row overflow-hidden rounded-none", panelClassName)}>
                        {/* Provider sidebar */}
                        {isShowProviderSidebar ? (
                            <div className="border-border/50 flex w-30 shrink-0 flex-col overflow-y-auto border-r pt-1.5 pb-1">
                                <ProviderSidebarButton
                                    icon={ALL_PROVIDERS_ICON}
                                    isSelected={selectedProvider === null}
                                    label={t`All`}
                                    onClick={handleProviderSelectAll}
                                    showBorder
                                />
                                {creatorInfo.map(({ name, slug }) => (
                                    <ProviderSidebarItem
                                        isSelected={selectedProvider === slug}
                                        key={slug}
                                        name={name}
                                        onSelect={handleProviderSelect}
                                        slug={slug}
                                    />
                                ))}
                            </div>
                        ) : null}

                        {/* Model list */}
                        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            {isStarredEmpty ? (
                                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                                    <div className="border-border/30 flex size-10 items-center justify-center rounded-xl border">
                                        <Star className="text-muted-foreground/30 size-4" />
                                    </div>
                                    <div>
                                        <p className="text-foreground/80 text-sm font-medium">{t`No starred models`}</p>
                                        <p className="text-muted-foreground/40 mt-1 text-[11.5px] leading-relaxed">
                                            {t`Click ★ on any model in All models to add it here.`}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <CommandEmpty className="not-empty:size-full">{t`No models found.`}</CommandEmpty>
                                    <CommandList className="py-1.5">
                                        {filteredGroupedItems.map((group) => (
                                            <ModelGroupRenderer
                                                anchorMode={selectionMode === "parallel" ? anchorMode : null}
                                                group={group}
                                                infoModelId={infoModelId}
                                                isAnonymous={isAnonymous}
                                                isFavorite={isFavorite}
                                                key={`${activeTab}-${group.value}`}
                                                onInfo={handleInfo}
                                                onInfoLeave={scheduleInfoClose}
                                                parallelMaxReached={isParallelMaxReached}
                                                parallelSelectedIds={parallelSelectedIds}
                                                selectedModelId={selectedModelId}
                                                selectionMode={selectionMode}
                                                showGroupLabel={isShowGroupLabels}
                                                showProviderIcon={activeTab === "starred"}
                                                toggleFavorite={toggleFavorite}
                                            />
                                        ))}
                                    </CommandList>
                                </>
                            )}
                        </div>
                    </CommandPanel>

                    {/* Parallel footer */}
                    {selectionMode === "parallel" ? (
                        <div className="border-border/40 flex items-center justify-between border-t px-3 py-2">
                            <div className="flex flex-col gap-0.5">
                                <span className={cn("text-[11.5px]", isParallelMaxReached ? "text-amber-500 dark:text-amber-400" : "text-muted-foreground/50")}>
                                    {isParallelMaxReached
                                        ? t`Maximum ${MAX_PARALLEL} models reached`
                                        : t`${parallelSelectedIds.size} of ${MAX_PARALLEL} selected`}
                                </span>
                                {anchorMode ? (
                                    <span className="text-muted-foreground/40 flex items-center gap-1 text-[10px]">
                                        <Lock className="size-2.5" />
                                        {t`Locked to ${getModelModeName(anchorMode)} models`}
                                    </span>
                                ) : null}
                            </div>
                            <button
                                className={cn(
                                    "rounded-md px-3 py-1 text-[12px] font-medium transition-colors duration-100",
                                    parallelSelectedIds.size > 0
                                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                        : "text-muted-foreground/30 cursor-not-allowed",
                                )}
                                disabled={parallelSelectedIds.size === 0}
                                onClick={() => {
                                    onSelectMultipleRef.current?.([...parallelSelectedIds]);
                                }}
                                type="button"
                            >
                                {t`Confirm`}
                            </button>
                        </div>
                    ) : null}

                    {footer}
                </Command>
            </div>

            {/* Info panel — portal-rendered, anchored to right of picker */}
            <PopoverPrimitive.Portal>
                <PopoverPrimitive.Positioner align="start" anchor={pickerRef} className="isolate z-50" side="right" sideOffset={8}>
                    <PopoverPrimitive.Popup
                        className="bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=right]:slide-in-from-left-2 w-64 origin-(--transform-origin) overflow-hidden rounded-lg shadow-md ring-1 outline-hidden duration-100"
                        onMouseEnter={cancelInfoClose}
                        onMouseLeave={scheduleInfoClose}
                    >
                        {infoModel ? <ModelDetailPanel model={infoModel} /> : null}
                    </PopoverPrimitive.Popup>
                </PopoverPrimitive.Positioner>
            </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
    );
};

export default ModelPicker;
