"use client";

import { useLingui } from "@lingui/react/macro";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Separator } from "@neore/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import { Gauge, Mic2 } from "lucide-react";
import type { FC } from "react";

export interface AudioGenerationSettings {
    speed?: number;
    voice?: string;
}

interface ComposerAudioSettingsProps {
    className?: string;
    disabled?: boolean;
    onSettingsChange: (settings: Partial<AudioGenerationSettings>) => void;
    settings: AudioGenerationSettings;
}

const VOICE_OPTIONS: { label: string; value: string }[] = [
    { label: "Alloy", value: "alloy" },
    { label: "Echo", value: "echo" },
    { label: "Fable", value: "fable" },
    { label: "Onyx", value: "onyx" },
    { label: "Nova", value: "nova" },
    { label: "Shimmer", value: "shimmer" },
];

const SPEED_OPTIONS: { label: string; value: number }[] = [
    { label: "0.5×", value: 0.5 },
    { label: "0.75×", value: 0.75 },
    { label: "1×", value: 1 },
    { label: "1.25×", value: 1.25 },
    { label: "1.5×", value: 1.5 },
];

const ComposerAudioSettings: FC<ComposerAudioSettingsProps> = ({ className, disabled, onSettingsChange, settings }) => {
    const { t } = useLingui();

    const triggerClass = "h-7 gap-1.5 border-border/50 px-2 text-xs";

    return (
        <div className={clsx("flex flex-wrap items-center gap-1", className)}>
            {/* ── Voice ── */}
            <Tooltip>
                <TooltipTrigger
                    render={
                        <div className="inline-flex">
                            <Select
                                disabled={disabled}
                                onValueChange={(value) => onSettingsChange({ voice: value ?? undefined })}
                                value={settings.voice || "alloy"}
                            >
                                <SelectTrigger className={triggerClass}>
                                    <Mic2 className="text-muted-foreground size-3 shrink-0" />
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {VOICE_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    }
                />
                <TooltipContent side="top">{t`Voice`}</TooltipContent>
            </Tooltip>

            <Separator className="mx-0.5 h-4" orientation="vertical" />

            {/* ── Speed ── */}
            <Tooltip>
                <TooltipTrigger
                    render={
                        <div className="inline-flex">
                            <Select
                                disabled={disabled}
                                onValueChange={(value) => onSettingsChange({ speed: Number(value) })}
                                value={String(settings.speed || 1)}
                            >
                                <SelectTrigger className={triggerClass}>
                                    <Gauge className="text-muted-foreground size-3 shrink-0" />
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {SPEED_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={String(option.value)}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    }
                />
                <TooltipContent side="top">{t`Speed`}</TooltipContent>
            </Tooltip>
        </div>
    );
};

export default ComposerAudioSettings;
