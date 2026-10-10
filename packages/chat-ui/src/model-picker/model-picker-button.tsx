"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Button } from "@neore/ui/components/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@neore/ui/components/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/popover";
import { ChevronsUpDown } from "lucide-react";
import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";

import cn from "../utils/cn";
import { ModelPicker } from "./model-picker";
import { findModelById } from "./utils";

interface ModelPickerButtonProps {
    className?: string;
    disabled?: boolean;
    favorites?: string[];
    isAnonymous?: boolean;
    isMobile?: boolean;
    model?: GatewayModel;
    modelId?: string;
    models: GatewayModel[];
    onSelect?: (modelId: string) => void;
    onSelectMultiple?: (modelIds: string[]) => void;
    onToggleFavorite?: (modelId: string) => void;
    placeholder?: string;
    selectedModelIds?: string[];
    size?: "default" | "icon" | "icon-lg" | "icon-sm" | "icon-xs" | "lg" | "sm" | "xs";
    variant?: "default" | "destructive" | "ghost" | "link" | "outline" | "secondary";
}

// ─── Multi model chips ─────────────────────────────────────────────────────────

const MAX_VISIBLE_CHIPS = 3;

const MultiModelChips: FC<{ modelIds: string[]; models: GatewayModel[] }> = ({ modelIds, models }) => {
    const visible = modelIds.slice(0, MAX_VISIBLE_CHIPS);
    const overflow = modelIds.length - MAX_VISIBLE_CHIPS;

    return (
        <div aria-hidden="true" className="flex items-center">
            {visible.map((id, i) => {
                const m = findModelById(models, id);
                const provider = m?.provider || m?.displayProvider || id.split("/", 1)[0] || "";

                return (
                    <div
                        className="ring-background bg-muted flex size-4 items-center justify-center overflow-hidden rounded-sm ring-1"
                        key={id}
                        style={{ marginLeft: i === 0 ? 0 : "-5px", zIndex: MAX_VISIBLE_CHIPS - i }}
                    >
                        <ProviderIcon className="size-3" provider={provider} providerIcon={id.split("/", 1)[0] || provider} />
                    </div>
                );
            })}
            {overflow > 0 ? (
                <div
                    className="ring-background bg-muted text-muted-foreground flex size-4 items-center justify-center rounded-sm text-[9px] font-semibold ring-1"
                    style={{ marginLeft: "-5px" }}
                >
                    +{overflow}
                </div>
            ) : null}
        </div>
    );
};

// ─── ModelPickerButton ─────────────────────────────────────────────────────────

const ModelPickerButton: FC<ModelPickerButtonProps> = ({
    className,
    disabled,
    favorites,
    isAnonymous,
    isMobile = false,
    model: modelProp,
    modelId,
    models,
    onSelect,
    onSelectMultiple,
    onToggleFavorite,
    placeholder,
    selectedModelIds,
    size = "default",
    variant = "outline",
}) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);

    const isComparisonMode = (selectedModelIds?.length ?? 0) >= 2;

    const model = useMemo(() => {
        if (modelProp) {
            return modelProp;
        }

        if (modelId) {
            return findModelById(models, modelId);
        }

        return undefined;
    }, [modelProp, modelId, models]);

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

    const comparisonCount = selectedModelIds?.length ?? 0;
    const triggerLabel = useMemo(() => model?.name ?? placeholder ?? t`Select model...`, [model, placeholder, t]);

    const triggerButton = isComparisonMode ? (
        <Button
            aria-expanded={open}
            aria-haspopup="listbox"
            className={cn("justify-between gap-1.5", className?.includes("w-[200px]") ? className.replace("w-[200px]", "w-auto") : className)}
            disabled={disabled}
            size={size}
            variant={variant}
        >
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <MultiModelChips modelIds={selectedModelIds!} models={models} />
                <span className="text-xs font-medium tabular-nums">
                    <Plural one="# model" other="# models" value={comparisonCount} />
                </span>
            </div>
            <ChevronsUpDown aria-hidden="true" className="ml-1 h-3.5 w-3.5 shrink-0 opacity-40" />
        </Button>
    ) : (
        <Button
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={triggerLabel}
            className={cn("justify-between", className)}
            disabled={disabled}
            size={size}
            variant={variant}
        >
            <div className="flex min-w-0 flex-1 items-center gap-2">
                {model ? (
                    <ProviderIcon
                        className="size-3"
                        provider={model.provider || model.displayProvider || ""}
                        providerIcon={model.id.split("/", 1)[0] || model.displayProvider || ""}
                    />
                ) : null}
                <span className="truncate">{triggerLabel}</span>
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
                            favorites={favorites}
                            footer={null}
                            initialModelId={isComparisonMode ? undefined : modelId}
                            initialModelIds={isComparisonMode ? selectedModelIds : undefined}
                            isAnonymous={isAnonymous}
                            models={models}
                            onSelect={handleSelect}
                            onSelectMultiple={onSelectMultiple ? handleSelectMultiple : undefined}
                            onToggleFavorite={onToggleFavorite}
                            panelClassName="h-[50vh]"
                        />
                    </div>
                </DrawerContent>
            </Drawer>
        );
    }

    const pickerContent = (
        <ModelPicker
            favorites={favorites}
            footer={null}
            initialModelId={isComparisonMode ? undefined : modelId}
            initialModelIds={isComparisonMode ? selectedModelIds : undefined}
            isAnonymous={isAnonymous}
            models={models}
            onSelect={handleSelect}
            onSelectMultiple={onSelectMultiple ? handleSelectMultiple : undefined}
            onToggleFavorite={onToggleFavorite}
        />
    );

    return (
        <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger render={triggerButton} />
            <PopoverContent align="start" className="max-h-125 w-145 gap-0 overflow-hidden p-0" sideOffset={4}>
                {pickerContent}
            </PopoverContent>
        </Popover>
    );
};

export { ModelPickerButton };
export type { ModelPickerButtonProps };
