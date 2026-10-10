"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Button } from "@neore/ui/components/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@neore/ui/components/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/popover";
import MOBILE_BREAKPOINT_QUERY from "@neore/ui/utils/breakpoints";
import cn from "@neore/ui/utils/cn";
import { ChevronsUpDown } from "lucide-react";
import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";
import { useMediaMatch } from "rooks";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import useFavoriteModels from "@/features/chat/core/hooks/use-favorite-models";
import useCustomModels from "@/features/settings/hooks/use-custom-models";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

import ModelPicker from "./model-picker";
import { findModelById } from "./utilities";

interface ModelPickerButtonProps {
    className?: string;
    disabled?: boolean;

    /**
     * Also list models from the user's own endpoints. Opt-in: only the chat
     * path (`chat/execute.ts`) knows how to run a `custom:` id.
     */
    includeCustomModels?: boolean;
    model?: GatewayModel;
    modelId?: string;
    onSelect?: (modelId: string) => void;
    onSelectMultiple?: (modelIds: string[]) => void;
    placeholder?: string;
    /** When provided (≥2 ids), renders the multi-model comparison trigger */
    selectedModelIds?: string[];
    size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
    variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
}

/** Stacked provider icon chips for the multi-model trigger. */
const MultiModelChips: FC<{ modelIds: string[]; models: GatewayModel[] }> = ({ modelIds, models }) => {
    const MAX_VISIBLE = 3;
    const visible = modelIds.slice(0, MAX_VISIBLE);
    const overflow = modelIds.length - MAX_VISIBLE;

    return (
        <div className="flex items-center">
            {visible.map((id, i) => {
                const m = findModelById(models, id);
                const provider = m?.provider || m?.displayProvider || id.split("/", 1)[0] || "";

                return (
                    <div
                        className="ring-background bg-muted flex size-4 items-center justify-center overflow-hidden rounded-sm ring-1"
                        key={id}
                        style={{ marginLeft: i === 0 ? 0 : "-5px", zIndex: MAX_VISIBLE - i }}
                    >
                        <ProviderIcon className="size-3" provider={provider} providerIcon={id.split("/", 1)[0] || provider} />
                    </div>
                );
            })}
            {overflow > 0 && (
                <div
                    className="ring-background bg-muted text-muted-foreground flex size-4 items-center justify-center rounded-sm text-[9px] font-semibold ring-1"
                    style={{ marginLeft: "-5px" }}
                >
                    +{overflow}
                </div>
            )}
        </div>
    );
};

const ModelPickerButton: FC<ModelPickerButtonProps> = ({
    className,
    disabled,
    includeCustomModels = false,
    model: modelProp,
    modelId,
    onSelect,
    onSelectMultiple,
    placeholder,
    selectedModelIds,
    size = "default",
    variant = "outline",
}) => {
    const { t } = useLingui();
    const isMobile = useMediaMatch(MOBILE_BREAKPOINT_QUERY);
    const [open, setOpen] = useState(false);
    const defaultPlaceholder = t`Select model...`;
    const { isAnonymous } = useIsAnonymous();
    const gatewayModels = useFeatureFlaggedModels();
    // Custom endpoints only when the picker opens, or when the current pick is
    // one (its label comes from that list) — not on every first paint.
    const customModels = useCustomModels(includeCustomModels && (open || Boolean(modelId?.startsWith("custom:"))));
    const featureFlaggedModels = useMemo(() => (customModels.length > 0 ? [...gatewayModels, ...customModels] : gatewayModels), [gatewayModels, customModels]);
    const { favoriteModelIds, toggleFavorite } = useFavoriteModels();

    const isComparisonMode = (selectedModelIds?.length ?? 0) >= 2;

    const model = useMemo(() => {
        if (modelProp) {
            return modelProp;
        }

        if (modelId) {
            return findModelById(featureFlaggedModels, modelId);
        }

        return undefined;
    }, [modelProp, modelId, featureFlaggedModels]);

    const handleSelect = useCallback(
        (selectedModelId: string) => {
            onSelect?.(selectedModelId);
            setOpen(false);
        },
        [onSelect],
    );

    const handleSelectMultiple = useCallback(
        (selectedIds: string[]) => {
            onSelectMultiple?.(selectedIds);
            setOpen(false);
        },
        [onSelectMultiple],
    );

    const triggerButton = isComparisonMode ? (
        // Multi-model comparison trigger
        <Button
            className={cn(
                "justify-between gap-1.5",
                // When comparison mode is active, remove fixed width so it auto-sizes
                className?.includes("w-[200px]") ? className.replace("w-[200px]", "w-auto") : className,
            )}
            disabled={disabled}
            size={size}
            variant={variant}
        >
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <MultiModelChips modelIds={selectedModelIds!} models={featureFlaggedModels} />
                <span className="text-xs font-medium tabular-nums">
                    <Plural one="1 model" other="# models" value={selectedModelIds!.length} />
                </span>
            </div>
            <ChevronsUpDown aria-hidden="true" className="ml-1 h-3.5 w-3.5 shrink-0 opacity-40" />
        </Button>
    ) : (
        // Single model trigger (default)
        <Button className={cn("justify-between", className)} disabled={disabled} size={size} variant={variant}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
                {model && (
                    <ProviderIcon
                        className="size-3"
                        provider={model.provider || model.displayProvider || ""}
                        providerIcon={model.id.split("/", 1)[0] || model.displayProvider || ""}
                    />
                )}
                <span className="truncate">{model?.name || placeholder || defaultPlaceholder}</span>
            </div>
            <ChevronsUpDown aria-hidden="true" className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
    );

    if (isMobile) {
        return (
            <Drawer onOpenChange={setOpen} open={open}>
                <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
                <DrawerContent>
                    <DrawerHeader className="shrink-0">
                        <DrawerTitle>{t`Select Model`}</DrawerTitle>
                    </DrawerHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                        <ModelPicker
                            favorites={favoriteModelIds}
                            footer={null}
                            initialModelId={isComparisonMode ? undefined : modelId}
                            initialModelIds={isComparisonMode ? selectedModelIds : undefined}
                            isAnonymous={isAnonymous}
                            models={featureFlaggedModels}
                            onSelect={handleSelect}
                            onSelectMultiple={handleSelectMultiple}
                            onToggleFavorite={toggleFavorite}
                            panelClassName="h-[50vh]"
                        />
                    </div>
                </DrawerContent>
            </Drawer>
        );
    }

    const modelPickerContent = (
        <ModelPicker
            favorites={favoriteModelIds}
            footer={null}
            initialModelId={isComparisonMode ? undefined : modelId}
            initialModelIds={isComparisonMode ? selectedModelIds : undefined}
            isAnonymous={isAnonymous}
            models={featureFlaggedModels}
            onSelect={handleSelect}
            onSelectMultiple={handleSelectMultiple}
            onToggleFavorite={toggleFavorite}
        />
    );

    return (
        <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger render={triggerButton} />
            <PopoverContent align="start" className="max-h-125 w-145 gap-0 overflow-hidden p-0" sideOffset={4}>
                {modelPickerContent}
            </PopoverContent>
        </Popover>
    );
};

export default ModelPickerButton;
