"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Separator } from "@neore/ui/components/separator";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import type { FC } from "react";

import { CinemaToggleButton } from "@/features/chat/components/cinema-studio";
import type { VideoGenerationSettings } from "@/features/chat/core/stores/model-store";

interface ComposerVideoSettingsProps {
    className?: string;
    disabled?: boolean;
    onSettingsChange: (settings: Partial<VideoGenerationSettings>) => void;
    settings: VideoGenerationSettings;
}

const ASPECT_RATIOS: { description: MessageDescriptor; label: MessageDescriptor | string; value: string }[] = [
    { description: msg`Match input`, label: msg`Auto`, value: "auto" },
    { description: msg`Square`, label: "1:1", value: "1:1" },
    { description: msg`Portrait (tall)`, label: "9:16", value: "9:16" },
    { description: msg`Portrait (standard)`, label: "3:4", value: "3:4" },
    { description: msg`Portrait (mobile)`, label: "9:20", value: "9:20" },
    { description: msg`Landscape (standard)`, label: "4:3", value: "4:3" },
    { description: msg`Landscape (wide)`, label: "16:9", value: "16:9" },
    { description: msg`Landscape (2x wide)`, label: "2:1", value: "2:1" },
    { description: msg`Cinematic (ultra-wide)`, label: "21:9", value: "21:9" },
];

const DURATION_MARKS = [3, 5, 10, 15, 30, 60] as const;

/**
 * Visual preview of aspect ratio as a small rectangle.
 */
const AspectRatioPreview: FC<{ ratio: string }> = ({ ratio }) => {
    const parts = ratio.split(":");
    const w = Number(parts[0]) || 1;
    const h = Number(parts[1]) || 1;
    const baseSize = 12;

    let size: { height: number; width: number };

    if (w > h) {
        size = { height: Math.round((baseSize * h) / w), width: baseSize };
    } else if (h > w) {
        size = { height: baseSize, width: Math.round((baseSize * w) / h) };
    } else {
        size = { height: baseSize, width: baseSize };
    }

    return <div className="border-muted-foreground/50 shrink-0 border" style={{ height: size.height, width: size.width }} />;
};

const ComposerVideoSettings: FC<ComposerVideoSettingsProps> = ({ className, disabled, onSettingsChange, settings }) => {
    const { i18n, t } = useLingui();

    const formatDuration = (seconds: number): string => {
        if (seconds < 60) {
            return `${seconds}s`;
        }

        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;

        return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
    };

    const triggerClass = "h-7 gap-1.5 border-border/50 px-2 text-xs";

    return (
        <div className={clsx("flex flex-wrap items-center gap-1", className)}>
            {/* ── Aspect ratio ── */}
            <Tooltip>
                <TooltipTrigger
                    render={
                        <div className="inline-flex">
                            <Select
                                disabled={disabled}
                                onValueChange={(value) => onSettingsChange({ aspectRatio: value ?? undefined })}
                                value={settings.aspectRatio}
                            >
                                <SelectTrigger className={triggerClass}>
                                    <AspectRatioPreview ratio={settings.aspectRatio} />
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {ASPECT_RATIOS.map((ratio) => (
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

            <Separator className="mx-0.5 h-4" orientation="vertical" />

            {/* ── Duration presets (ToggleGroup — single-select) ── */}
            <ToggleGroup
                className="gap-0"
                disabled={disabled}
                onValueChange={(values) => {
                    if (!values || values.length === 0) {
                        return; // prevent deselection;
                    }

                    const next = values.find((v) => v !== String(settings.duration)) ?? values[0];

                    if (next !== undefined) onSettingsChange({ duration: Number(next) });
                }}
                size="default"
                value={settings.duration === undefined ? [] : [String(settings.duration)]}
                variant="outline"
            >
                {DURATION_MARKS.map((duration) => (
                    <ToggleGroupItem key={duration} value={String(duration)}>
                        {formatDuration(duration)}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>

            <Separator className="mx-0.5 h-4" orientation="vertical" />

            {/* ── Cinema toggle ── */}
            <CinemaToggleButton compact disabled={disabled} value={settings.cinema || { enabled: true }} />
        </div>
    );
};

export default ComposerVideoSettings;
