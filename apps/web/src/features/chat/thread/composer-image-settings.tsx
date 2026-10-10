"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import type { ImageSize } from "@neore/ai/models";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Separator } from "@neore/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import { Ban, Hash, Images, Shuffle, Wand2, Zap } from "lucide-react";
import type { FC } from "react";
import { useMemo } from "react";

import { CinemaToggleButton } from "@/features/chat/components/cinema-studio";
import type { ImageGenerationSettings } from "@/features/chat/core/stores/model-store";

interface ComposerImageSettingsProps {
    className?: string;
    disabled?: boolean;
    onSettingsChange: (settings: Partial<ImageGenerationSettings>) => void;
    settings: ImageGenerationSettings;
    supportedAspectRatios?: ReadonlyArray<string>;
    supportsNegativePrompt?: boolean;
}

const ASPECT_RATIOS: { description: MessageDescriptor; label: MessageDescriptor | string; value: ImageSize }[] = [
    { description: msg`Match input`, label: msg`Auto`, value: "auto" },
    { description: msg`Square`, label: "1:1", value: "1:1" },
    { description: msg`Portrait (standard)`, label: "3:4", value: "3:4" },
    { description: msg`Portrait (photo)`, label: "2:3", value: "2:3" },
    { description: msg`Portrait (tall)`, label: "9:16", value: "9:16" },
    { description: msg`Portrait (2x tall)`, label: "1:2", value: "1:2" },
    { description: msg`Portrait (ultra-tall)`, label: "9:19.5", value: "9:19.5" },
    { description: msg`Portrait (mobile)`, label: "9:20", value: "9:20" },
    { description: msg`Landscape (photo)`, label: "3:2", value: "3:2" },
    { description: msg`Landscape (standard)`, label: "4:3", value: "4:3" },
    { description: msg`Cinematic`, label: "16:9", value: "16:9" },
    { description: msg`Landscape (2x wide)`, label: "2:1", value: "2:1" },
    { description: msg`Landscape (ultra-wide)`, label: "19.5:9", value: "19.5:9" },
    { description: msg`Landscape (widescreen)`, label: "20:9", value: "20:9" },
    { description: msg`Cinematic (ultra-wide)`, label: "21:9", value: "21:9" },
];

// Abbreviated for compact display
const QUALITY_OPTIONS: { label: string; value: "hd" | "standard" }[] = [
    { label: "Std", value: "standard" },
    { label: "HD", value: "hd" },
];

const STYLE_OPTIONS: { label: MessageDescriptor; value: string }[] = [
    { label: msg`Auto`, value: "" },
    { label: msg`Vivid`, value: "vivid" },
    { label: msg`Natural`, value: "natural" },
    { label: msg`Anime`, value: "anime" },
    { label: msg`Photo`, value: "photographic" },
    { label: msg`Digital`, value: "digital-art" },
    { label: msg`Cinema`, value: "cinematic" },
];

const COUNT_OPTIONS: { label: string; value: number }[] = [
    { label: "1", value: 1 },
    { label: "2", value: 2 },
    { label: "3", value: 3 },
    { label: "4", value: 4 },
];

const DEFAULT_CINEMA = { enabled: true } as const;

/**
 * Pure size computation for an aspect ratio string.
 */
const getAspectRatioSize = (ratio: string): { height: number; width: number } => {
    const parts = ratio.replace("-hd", "").split(":");
    const w = Number(parts[0]) || 1;
    const h = Number(parts[1]) || 1;
    const baseSize = 12;

    if (w > h) {
        return { height: Math.round((baseSize * h) / w), width: baseSize };
    }

    if (h > w) {
        return { height: baseSize, width: Math.round((baseSize * w) / h) };
    }

    return { height: baseSize, width: baseSize };
};

/**
 * Visual preview of aspect ratio as a small rectangle.
 */
const AspectRatioPreview: FC<{ ratio: ImageSize }> = ({ ratio }) => {
    const size = getAspectRatioSize(ratio);

    return <div className="border-muted-foreground/50 shrink-0 border" style={{ height: size.height, width: size.width }} />;
};

const ComposerImageSettings: FC<ComposerImageSettingsProps> = ({
    className,
    disabled,
    onSettingsChange,
    settings,
    supportedAspectRatios,
    supportsNegativePrompt,
}) => {
    const { i18n, t } = useLingui();

    const availableAspectRatios = useMemo(
        () => (supportedAspectRatios ? ASPECT_RATIOS.filter((r) => supportedAspectRatios.includes(r.value)) : ASPECT_RATIOS),
        [supportedAspectRatios],
    );

    const triggerClass = "h-7 gap-1.5 border-border/50 px-2 text-xs";

    return (
        <div className={clsx("flex flex-wrap items-center gap-1", className)}>
            {/* ── Group 1: visual style ── */}

            {/* Aspect ratio */}
            {availableAspectRatios.length > 1 && (
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <div className="inline-flex">
                                <Select
                                    disabled={disabled}
                                    onValueChange={(value) => onSettingsChange({ aspectRatio: value as ImageSize })}
                                    value={settings.aspectRatio}
                                >
                                    <SelectTrigger className={triggerClass}>
                                        <AspectRatioPreview ratio={settings.aspectRatio} />
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {availableAspectRatios.map((ratio) => (
                                            <SelectItem key={ratio.value} value={ratio.value}>
                                                <div className="flex items-center gap-2">
                                                    <div className="w-4">
                                                        <AspectRatioPreview ratio={ratio.value} />
                                                    </div>
                                                    <span>{typeof ratio.label === "string" ? ratio.label : i18n._(ratio.label)}</span>
                                                    <span className="text-muted-foreground text-xs">{i18n._(ratio.description)}</span>
                                                </div>
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        }
                    />
                    <TooltipContent side="top">{t`Aspect ratio`}</TooltipContent>
                </Tooltip>
            )}

            {/* Quality */}
            <Tooltip>
                <TooltipTrigger
                    render={
                        <div className="inline-flex">
                            <Select
                                disabled={disabled}
                                onValueChange={(value) => onSettingsChange({ quality: value as "hd" | "standard" })}
                                value={settings.quality || "standard"}
                            >
                                <SelectTrigger className={triggerClass}>
                                    <Zap className="text-muted-foreground size-3 shrink-0" />
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {QUALITY_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.value === "hd" ? t`HD — sharp & detailed` : t`Standard — fast & efficient`}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    }
                />
                <TooltipContent side="top">{t`Quality`}</TooltipContent>
            </Tooltip>

            {/* Style */}
            <Tooltip>
                <TooltipTrigger
                    render={
                        <div className="inline-flex">
                            <Select disabled={disabled} onValueChange={(value) => onSettingsChange({ style: value || undefined })} value={settings.style || ""}>
                                <SelectTrigger className={triggerClass}>
                                    <Wand2 className="text-muted-foreground size-3 shrink-0" />
                                    <SelectValue placeholder={t`Auto`} />
                                </SelectTrigger>
                                <SelectContent>
                                    {STYLE_OPTIONS.map((option) => (
                                        <SelectItem key={option.value || "auto"} value={option.value || "auto"}>
                                            {i18n._(option.label)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    }
                />
                <TooltipContent side="top">{t`Style`}</TooltipContent>
            </Tooltip>

            <Separator className="mx-0.5 h-4" orientation="vertical" />

            {/* ── Group 2: output count ── */}
            <Tooltip>
                <TooltipTrigger
                    render={
                        <div className="inline-flex">
                            <Select
                                disabled={disabled}
                                onValueChange={(value) => onSettingsChange({ numImages: Number(value) })}
                                value={String(settings.numImages ?? 1)}
                            >
                                <SelectTrigger className={triggerClass}>
                                    <Images className="text-muted-foreground size-3 shrink-0" />
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {COUNT_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={String(option.value)}>
                                            <Plural one="# image" other="# images" value={option.value} />
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    }
                />
                <TooltipContent side="top">{t`Number of images`}</TooltipContent>
            </Tooltip>

            <Separator className="mx-0.5 h-4" orientation="vertical" />

            {/* ── Group 3: seed ── */}
            <div className="border-border/50 flex h-7 items-center rounded-md border">
                <Hash className="text-muted-foreground mx-1.5 size-3 shrink-0" />
                <input
                    className="focus-visible:ring-ring/50 w-14 [appearance:textfield] bg-transparent text-xs focus:outline-none focus-visible:ring-1 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    disabled={disabled}
                    max={2_147_483_647}
                    min={0}
                    onChange={(e) => onSettingsChange({ seed: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder={t`Random`}
                    type="number"
                    value={settings.seed ?? ""}
                />
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <button
                                className={clsx(
                                    "text-muted-foreground hover:text-foreground border-border/50 flex h-full items-center border-l px-1.5 transition-colors",
                                    disabled && "cursor-not-allowed opacity-50",
                                )}
                                disabled={disabled}
                                onClick={() => onSettingsChange({ seed: Math.floor(Math.random() * 2_147_483_647) })}
                                type="button"
                            >
                                <Shuffle className="size-3" />
                            </button>
                        }
                    />
                    <TooltipContent side="top">{t`Random seed`}</TooltipContent>
                </Tooltip>
            </div>

            {/* Negative prompt — only when model supports it */}
            {supportsNegativePrompt && (
                <>
                    <Separator className="mx-0.5 h-4" orientation="vertical" />
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <div className="border-border/50 inline-flex h-7 items-center rounded-md border">
                                    <Ban className="text-muted-foreground mx-1.5 size-3 shrink-0" />
                                    <input
                                        className="focus-visible:ring-ring/50 w-28 bg-transparent text-xs focus:outline-none focus-visible:ring-1"
                                        disabled={disabled}
                                        onChange={(e) => onSettingsChange({ negativePrompt: e.target.value || undefined })}
                                        placeholder={t`Avoid...`}
                                        type="text"
                                        value={settings.negativePrompt ?? ""}
                                    />
                                </div>
                            }
                        />
                        <TooltipContent side="top">{t`Negative prompt — what to exclude`}</TooltipContent>
                    </Tooltip>
                </>
            )}

            <Separator className="mx-0.5 h-4" orientation="vertical" />

            {/* ── Cinema toggle ── */}
            <CinemaToggleButton compact disabled={disabled} value={settings.cinema ?? DEFAULT_CINEMA} />
        </div>
    );
};

export default ComposerImageSettings;
