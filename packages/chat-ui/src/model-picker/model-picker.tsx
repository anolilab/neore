"use client";

import { useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { requiresPaidPlan } from "@neore/ai/models";
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
import { CheckIcon, CheckSquare2, Image, Layers2, Lock, Mic, Square, Star, Type, Video } from "lucide-react";
import type { ReactNode } from "react";
import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import cn from "../utils/cn";
import {
    filterModelsByQuery,
    getCreatorDisplayName,
    getCreatorSlug,
    getModelCapabilities,
    getModelMode,
    getModelModeName,
    groupModelsByCreator,
    stripProviderPrefix,
} from "./utils";

export type ModelPickerTab = "all" | "starred";
export type ModelModeFilter = "image" | "speech-to-text" | "text" | "text-to-speech" | "video" | null;

const MAX_PARALLEL = 6;

/** Static element — hoisted so it is not re-created (or memoized) per render. */
const ALL_PROVIDERS_ICON = <Layers2 aria-hidden="true" className="size-3.5" />;

export interface ModelPickerProps {
    defaultModeFilter?: ModelModeFilter;
    defaultTab?: ModelPickerTab;
    favorites?: string[];
    footer?: ReactNode;
    hideModeFilter?: boolean;
    initialModelId?: string;
    initialModelIds?: string[];
    isAnonymous?: boolean;
    models: GatewayModel[];
    onSelect?: (modelId: string) => void;
    onSelectMultiple?: (modelIds: string[]) => void;
    onToggleFavorite?: (modelId: string) => void;
    panelClassName?: string;
}

// ─── Internal types ────────────────────────────────────────────────────────────

interface ModelItem {
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

// ─── Provider sidebar button ───────────────────────────────────────────────────

const ProviderSidebarButton = memo<{
    icon: ReactNode;
    isSelected: boolean;
    label: string;
    onClick: () => void;
    showBorder?: boolean;
}>(({ icon, isSelected, label, onClick, showBorder = false }) => (
    <button
        aria-label={label}
        aria-pressed={isSelected}
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
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
            {icon}
        </span>
        <span className={cn("truncate text-[12px]", isSelected ? "font-medium" : "font-normal")}>{label}</span>
    </button>
));

ProviderSidebarButton.displayName = "ProviderSidebarButton";

// ─── Provider sidebar item ─────────────────────────────────────────────────────

const ProviderSidebarItem = memo<{
    isSelected: boolean;
    name: string;
    onSelect: (slug: string) => void;
    slug: string;
}>(({ isSelected, name, onSelect, slug }) => {
    const handleClick = useCallback(() => onSelect(slug), [onSelect, slug]);
    const icon = useMemo(() => <ProviderIcon className="size-3.5" provider={name} providerIcon={slug} />, [slug, name]);

    return <ProviderSidebarButton icon={icon} isSelected={isSelected} label={name} onClick={handleClick} />;
});

ProviderSidebarItem.displayName = "ProviderSidebarItem";

// ─── Model item content ────────────────────────────────────────────────────────

const ModelItemContent = memo<{
    isFavorite: boolean;
    isSelected: boolean;
    model: GatewayModel;
    onToggleFavorite?: (modelId: string) => void;
    showCheckmark?: boolean;
}>(({ isFavorite, isSelected, model, onToggleFavorite, showCheckmark = false }) => {
    const { i18n, t } = useLingui();
    const capabilities = getModelCapabilities(model);

    return (
        <div className="flex min-w-0 flex-1 items-center gap-2">
            {/* Name + badges */}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-[13px] leading-none font-medium">{stripProviderPrefix(model.name ?? model.id)}</span>
                    {requiresPaidPlan(model) ? (
                        <span className="shrink-0 rounded-[3px] bg-amber-500/15 px-1 py-0 text-[9px] font-semibold tracking-wide text-amber-600 uppercase dark:bg-amber-400/15 dark:text-amber-400">
                            {t`Pro`}
                        </span>
                    ) : null}
                    {(model as any).isNew ? (
                        <span className="shrink-0 rounded-[3px] bg-emerald-500/12 px-1 py-0 text-[9px] font-semibold tracking-wide text-emerald-600 uppercase dark:bg-emerald-400/15 dark:text-emerald-400">
                            {t`New`}
                        </span>
                    ) : null}
                </div>
                {capabilities.length > 0 ? (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                        {capabilities.slice(0, 3).map((cap) => (
                            <span
                                className="border-border/40 text-muted-foreground/60 bg-muted/50 inline-flex h-4 items-center rounded px-1 text-[9px] font-medium"
                                key={cap.id}
                            >
                                {i18n._(cap.label)}
                            </span>
                        ))}
                    </div>
                ) : null}
            </div>

            {/* Actions */}
            <div className="flex shrink-0 items-center gap-0.5">
                {onToggleFavorite ? (
                    <button
                        aria-label={isFavorite ? t`Remove from starred` : t`Add to starred`}
                        className={cn(
                            "rounded p-1 transition-all duration-100",
                            isFavorite ? "text-amber-400 opacity-100" : "text-muted-foreground/30 opacity-0 group-hover/row:opacity-100 hover:text-amber-400",
                        )}
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onToggleFavorite(model.id);
                        }}
                        type="button"
                    >
                        <Star aria-hidden="true" className={cn("size-3.5", isFavorite && "fill-current")} />
                    </button>
                ) : null}
                {showCheckmark ? (
                    <span className="ml-0.5 flex size-3.5 shrink-0 items-center justify-center">
                        {isSelected ? <CheckIcon aria-hidden="true" className="text-primary size-3.5" /> : null}
                    </span>
                ) : null}
            </div>
        </div>
    );
});

ModelItemContent.displayName = "ModelItemContent";

// ─── Model group renderer ──────────────────────────────────────────────────────

const ModelGroupRenderer = memo<{
    anchorMode: string | null;
    favorites: Set<string>;
    group: ModelGroup;
    isAnonymous?: boolean;
    onToggleFavorite?: (modelId: string) => void;
    parallelMaxReached: boolean;
    parallelSelectedIds: Set<string>;
    selectedModelId?: string;
    selectionMode: "parallel" | "single";
    showGroupLabel?: boolean;
    showProviderIcon?: boolean;
}>(
    ({
        anchorMode,
        favorites,
        group,
        isAnonymous = false,
        onToggleFavorite,
        parallelMaxReached,
        parallelSelectedIds,
        selectedModelId,
        selectionMode,
        showGroupLabel = true,
        showProviderIcon = false,
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
                        const isTypeMismatch =
                            selectionMode === "parallel" && anchorMode !== null && getModelMode(item.model) !== anchorMode && !isParallelSelected;
                        const isLockedForAnonymous = isAnonymous && item.model.id !== selectedModelId;
                        const isDisabled =
                            isLockedForAnonymous || (selectionMode === "parallel" && ((parallelMaxReached && !isParallelSelected) || isTypeMismatch));

                        let unavailableClassName = "";
                        let unavailableTitle: string | undefined;

                        if (isLockedForAnonymous) {
                            unavailableClassName = "cursor-not-allowed opacity-40";
                            unavailableTitle = t`Sign up to unlock all models`;
                        } else if (isTypeMismatch) {
                            unavailableClassName = "cursor-not-allowed opacity-25";
                            unavailableTitle = t`Only same-type models can be compared. Clear selection to switch types.`;
                        } else if (isDisabled) {
                            unavailableClassName = "cursor-not-allowed opacity-40";
                        }

                        let parallelCheckbox = <Square className={cn("size-4", isDisabled ? "text-muted-foreground/20" : "text-muted-foreground/30")} />;

                        if (isTypeMismatch) {
                            parallelCheckbox = <Lock className="text-muted-foreground/30 size-4" />;
                        } else if (isParallelSelected) {
                            parallelCheckbox = <CheckSquare2 className="text-primary size-4" />;
                        }

                        return (
                            <CommandItem
                                className={cn(
                                    "group/row mx-1.5 flex-row !items-center rounded-md px-2 py-2 transition-colors duration-100",
                                    isSelected && selectionMode === "single" ? "bg-accent/60" : "",
                                    isParallelSelected && selectionMode === "parallel" ? "bg-accent/40" : "",
                                    unavailableClassName,
                                )}
                                key={item.value}
                                onClick={(event: React.MouseEvent & { preventBaseUIHandler?: () => void }) => {
                                    event.preventBaseUIHandler?.();

                                    if (!isDisabled) {
                                        item.onSelect();
                                    }
                                }}
                                title={unavailableTitle}
                                value={item.value}
                            >
                                {/* Anonymous lock */}
                                {isLockedForAnonymous ? (
                                    <span aria-hidden="true" className="mr-2 flex shrink-0 items-center justify-center">
                                        <Lock className="text-muted-foreground/30 size-4" />
                                    </span>
                                ) : null}

                                {/* Parallel selection checkbox */}
                                {!isLockedForAnonymous && selectionMode === "parallel" ? (
                                    <span aria-hidden="true" className="mr-2 flex shrink-0 items-center justify-center">
                                        {parallelCheckbox}
                                    </span>
                                ) : null}

                                {/* Provider icon — shown on starred tab */}
                                {showProviderIcon ? (
                                    <ProviderIcon
                                        className="mr-2 size-5 shrink-0"
                                        provider={item.model.provider || item.model.displayProvider || ""}
                                        providerIcon={item.model.id.split("/", 1)[0] || item.model.displayProvider || ""}
                                    />
                                ) : null}

                                <ModelItemContent
                                    isFavorite={favorites.has(item.model.id)}
                                    isSelected={isSelected}
                                    model={item.model}
                                    onToggleFavorite={onToggleFavorite}
                                    showCheckmark={selectionMode === "single"}
                                />
                            </CommandItem>
                        );
                    }}
                </CommandCollection>
            </CommandGroup>
        );
    },
);

ModelGroupRenderer.displayName = "ModelGroupRenderer";

// ─── Main ModelPicker ──────────────────────────────────────────────────────────

export const ModelPicker: React.FC<ModelPickerProps> = ({
    defaultModeFilter = null,
    defaultTab = "starred",
    favorites: favoritesProp,
    footer,
    hideModeFilter = false,
    initialModelId,
    initialModelIds,
    isAnonymous = false,
    models,
    onSelect,
    onSelectMultiple,
    onToggleFavorite,
    panelClassName,
}) => {
    const { i18n, t } = useLingui();
    const favoriteSet = useMemo(() => new Set(favoritesProp), [favoritesProp]);

    const [selectedModelId, setSelectedModelId] = useState<string | undefined>(initialModelId);
    const [parallelSelectedIds, setParallelSelectedIds] = useState<Set<string>>(() => new Set(initialModelIds));
    const [searchQuery, setSearchQuery] = useState("");
    const [activeTab, setActiveTab] = useState<ModelPickerTab>(defaultTab);
    const [selectionMode, setSelectionMode] = useState<"parallel" | "single">(() => ((initialModelIds?.length ?? 0) > 0 ? "parallel" : "single"));
    const [modeFilter, setModeFilter] = useState<ModelModeFilter>(defaultModeFilter);
    const [selectedProvider, setSelectedProvider] = useState<string | null>(() => {
        if (initialModelId) {
            const slug = initialModelId.split("/", 1)[0];

            if (slug) {
                return slug;
            }
        }

        return null;
    });

    const onSelectRef = useRef(onSelect);
    const onSelectMultipleRef = useRef(onSelectMultiple);

    useLayoutEffect(() => {
        onSelectRef.current = onSelect;
        onSelectMultipleRef.current = onSelectMultiple;
    });

    // Compute creator info for sidebar
    const creatorInfo = useMemo<{ name: string; slug: string }[]>(() => {
        const seen = new Set<string>();
        const creators: { name: string; slug: string }[] = [];

        for (const m of models) {
            const slug = getCreatorSlug(m);

            if (slug && !seen.has(slug)) {
                seen.add(slug);
                creators.push({ name: getCreatorDisplayName(slug), slug });
            }
        }

        return creators.toSorted((a, b) => a.name.localeCompare(b.name));
    }, [models]);

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

    const handleProviderSelect = useCallback((slug: string | null) => {
        setSelectedProvider(slug);
        setSearchQuery("");
    }, []);

    const handleProviderSelectAll = useCallback(() => handleProviderSelect(null), [handleProviderSelect]);

    const handleTabChange = useCallback((tab: ModelPickerTab) => {
        setActiveTab(tab);
        setSelectedProvider(null);
        setSearchQuery("");
    }, []);

    const handleSelectionModeChange = useCallback((mode: "parallel" | "single") => {
        setSelectionMode(mode);

        if (mode === "single") {
            setParallelSelectedIds(new Set());
        }
    }, []);

    // Filter and group models
    const { favoriteModels, regularModels } = useMemo(() => {
        const favorites: GatewayModel[] = [];
        const regulars: GatewayModel[] = [];
        const hasSearchQuery = searchQuery.trim().length > 0;
        const isFilterByProvider = !hasSearchQuery && selectedProvider !== null && activeTab === "all";

        const filtered = hasSearchQuery ? filterModelsByQuery(models, searchQuery) : models;

        for (const model of filtered) {
            if (activeTab === "starred" && !favoriteSet.has(model.id)) {
                continue;
            }

            if (isFilterByProvider && getCreatorSlug(model) !== selectedProvider) {
                continue;
            }

            if (modeFilter !== null && getModelMode(model) !== modeFilter) {
                continue;
            }

            if (favoriteSet.has(model.id)) {
                favorites.push(model);
            } else {
                regulars.push(model);
            }
        }

        return { favoriteModels: favorites, regularModels: regulars };
    }, [models, favoriteSet, searchQuery, selectedProvider, activeTab, modeFilter]);

    const createModelItems = useCallback(
        (modelList: GatewayModel[]): ModelItem[] =>
            modelList.map((model) => {
                return {
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

    const isParallelMaxReached = parallelSelectedIds.size >= MAX_PARALLEL;
    const isShowProviderSidebar = activeTab === "all" && !searchQuery.trim();
    const isStarredEmpty = activeTab === "starred" && favoriteModels.length === 0 && !searchQuery.trim();
    const isShowGroupLabels = activeTab !== "starred";
    const isShowStarredTab = favoritesProp !== undefined;

    const anchorMode = useMemo(() => {
        if (parallelSelectedIds.size === 0) {
            return null;
        }

        const firstId = [...parallelSelectedIds][0];
        const firstModel = models.find((m) => m.id === firstId);

        return firstModel ? getModelMode(firstModel) : null;
    }, [parallelSelectedIds, models]);

    const isShowParallelFooter = onSelectMultiple !== undefined && selectionMode === "parallel";
    const selectedCount = parallelSelectedIds.size;
    const anchorModeName = anchorMode ? i18n._(getModelModeName(anchorMode)) : "";

    return (
        <div>
            <Command filter={() => true} items={groupedItems} onValueChange={setSearchQuery} value={searchQuery}>
                {/* Anonymous banner */}
                {isAnonymous ? (
                    <div className="flex items-center gap-2.5 border-b bg-amber-50 px-3 py-2.5 dark:bg-amber-950/20" role="status">
                        <Lock aria-hidden="true" className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <p className="text-[12px] leading-snug text-amber-700 dark:text-amber-300">
                            {t`Guest accounts use free models only. Sign up to unlock all models.`}
                        </p>
                    </div>
                ) : null}

                <CommandInput placeholder={t`Search models...`} />

                {/* Tab bar */}
                <div className="flex items-center border-t">
                    <div aria-label={t`Model tabs`} className="flex" role="tablist">
                        {isShowStarredTab ? (
                            <button
                                aria-selected={activeTab === "starred"}
                                className={cn(
                                    "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12.5px] font-medium transition-colors duration-150",
                                    activeTab === "starred"
                                        ? "text-foreground border-foreground -mb-px"
                                        : "text-muted-foreground/60 hover:text-foreground border-transparent",
                                )}
                                onClick={() => handleTabChange("starred")}
                                role="tab"
                                type="button"
                            >
                                <Star aria-hidden="true" className={cn("size-3", activeTab === "starred" ? "fill-amber-400 text-amber-400" : "opacity-50")} />
                                {t`Starred`}
                            </button>
                        ) : null}
                        <button
                            aria-selected={activeTab === "all"}
                            className={cn(
                                "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12.5px] font-medium transition-colors duration-150",
                                activeTab === "all"
                                    ? "text-foreground border-foreground -mb-px"
                                    : "text-muted-foreground/60 hover:text-foreground border-transparent",
                            )}
                            onClick={() => handleTabChange("all")}
                            role="tab"
                            type="button"
                        >
                            <Layers2 aria-hidden="true" className={cn("size-3", activeTab === "all" ? "opacity-80" : "opacity-40")} />
                            {t`All models`}
                        </button>
                    </div>

                    {/* Selection mode toggle — hidden for anonymous and when onSelectMultiple is not provided */}
                    {!isAnonymous && onSelectMultiple !== undefined ? (
                        <div className="mr-2 ml-auto">
                            <div aria-label={t`Selection mode`} className="bg-muted/70 flex items-center rounded-md p-0.5" role="group">
                                <button
                                    aria-pressed={selectionMode === "single"}
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
                                    aria-pressed={selectionMode === "parallel"}
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
                    ) : null}
                </div>

                {/* Mode filter row */}
                {hideModeFilter ? null : (
                    <div aria-label={t`Filter by mode`} className="flex items-center gap-1 border-t px-2 py-1.5" role="group">
                        <span className="text-muted-foreground/50 mr-1 text-[10px] font-medium tracking-wider uppercase" id="mode-filter-label">
                            {t`Type`}
                        </span>
                        <button
                            aria-pressed={modeFilter === null}
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
                            aria-pressed={modeFilter === "text"}
                            className={cn(
                                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                modeFilter === "text" ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                            )}
                            onClick={() => setModeFilter("text")}
                            type="button"
                        >
                            <Type aria-hidden="true" className="size-3" />
                            {t`Text`}
                        </button>
                        <button
                            aria-pressed={modeFilter === "image"}
                            className={cn(
                                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                modeFilter === "image" ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                            )}
                            onClick={() => setModeFilter("image")}
                            type="button"
                        >
                            <Image aria-hidden="true" className="size-3" />
                            {t`Image`}
                        </button>
                        <button
                            aria-pressed={modeFilter === "video"}
                            className={cn(
                                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                modeFilter === "video" ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                            )}
                            onClick={() => setModeFilter("video")}
                            type="button"
                        >
                            <Video aria-hidden="true" className="size-3" />
                            {t`Video`}
                        </button>
                        <button
                            aria-pressed={modeFilter === "speech-to-text"}
                            className={cn(
                                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150",
                                modeFilter === "speech-to-text"
                                    ? "bg-primary/10 text-primary"
                                    : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50",
                            )}
                            onClick={() => setModeFilter("speech-to-text")}
                            type="button"
                        >
                            <Mic aria-hidden="true" className="size-3" />
                            {t`Audio`}
                        </button>
                    </div>
                )}

                <CommandPanel className={cn("flex h-60 flex-row overflow-hidden rounded-none", panelClassName)}>
                    {/* Provider sidebar */}
                    {isShowProviderSidebar ? (
                        <nav aria-label={t`Filter by provider`} className="border-border/50 flex w-30 shrink-0 flex-col overflow-y-auto border-r pt-1.5 pb-1">
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
                        </nav>
                    ) : null}

                    {/* Model list */}
                    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                        {isStarredEmpty ? (
                            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                                <div className="border-border/30 flex size-10 items-center justify-center rounded-xl border">
                                    <Star aria-hidden="true" className="text-muted-foreground/30 size-4" />
                                </div>
                                <div>
                                    <p className="text-foreground/80 text-sm font-medium">{t`No starred models`}</p>
                                    <p className="text-muted-foreground/40 mt-1 text-[11.5px] leading-relaxed">
                                        {t`Click the star on any model in All models to add it here.`}
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <>
                                <CommandEmpty className="not-empty:size-full">{t`No models found.`}</CommandEmpty>
                                <CommandList className="py-1.5">
                                    {groupedItems.map((group) => (
                                        <ModelGroupRenderer
                                            anchorMode={selectionMode === "parallel" ? anchorMode : null}
                                            favorites={favoriteSet}
                                            group={group}
                                            isAnonymous={isAnonymous}
                                            key={`${activeTab}-${group.value}`}
                                            onToggleFavorite={onToggleFavorite}
                                            parallelMaxReached={isParallelMaxReached}
                                            parallelSelectedIds={parallelSelectedIds}
                                            selectedModelId={selectedModelId}
                                            selectionMode={selectionMode}
                                            showGroupLabel={isShowGroupLabels}
                                            showProviderIcon={activeTab === "starred"}
                                        />
                                    ))}
                                </CommandList>
                            </>
                        )}
                    </div>
                </CommandPanel>

                {/* Multi-select footer */}
                {isShowParallelFooter ? (
                    <div className="border-border/40 flex items-center justify-between border-t px-3 py-2">
                        <div className="flex flex-col gap-0.5">
                            <span
                                aria-live="polite"
                                className={cn("text-[11.5px]", isParallelMaxReached ? "text-amber-500 dark:text-amber-400" : "text-muted-foreground/50")}
                                role="status"
                            >
                                {isParallelMaxReached ? t`Maximum ${MAX_PARALLEL} models reached` : t`${selectedCount} of ${MAX_PARALLEL} selected`}
                            </span>
                            {anchorMode ? (
                                <span className="text-muted-foreground/40 flex items-center gap-1 text-[10px]">
                                    <Lock aria-hidden="true" className="size-2.5" />
                                    {t`Locked to ${anchorModeName} models`}
                                </span>
                            ) : null}
                        </div>
                        <button
                            aria-disabled={parallelSelectedIds.size === 0}
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
    );
};

ModelPicker.displayName = "ModelPicker";
