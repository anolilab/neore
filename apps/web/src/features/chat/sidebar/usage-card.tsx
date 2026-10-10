"use client";

import { useLingui } from "@lingui/react/macro";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@neore/ui/components/hover-card";
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue } from "@neore/ui/components/progress";
import { skipToken, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { FileText, Image, Mic, Video } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useState } from "react";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";
import { referenceNow } from "@/lib/reference-time";

interface ContentLimitBarProps {
    capacity: number;
    icon: ReactNode;
    label: string;
    remaining: number;
}

const getOverallColor = (percentage: number): string => {
    if (percentage > 50) {
        return "bg-emerald-500";
    }

    if (percentage > 20) {
        return "bg-amber-500";
    }

    return "bg-rose-500";
};

const getOverallGlow = (percentage: number): string => {
    if (percentage > 50) {
        return "rgba(16,185,129,0.4)";
    }

    if (percentage > 20) {
        return "rgba(245,158,11,0.4)";
    }

    return "rgba(244,63,94,0.4)";
};

const getOverallDots = (percentage: number): string => {
    if (percentage > 50) {
        return "bg-[radial-gradient(#10b98166_1px,transparent_1px)]";
    }

    if (percentage > 20) {
        return "bg-[radial-gradient(#f59e0b66_1px,transparent_1px)]";
    }

    return "bg-[radial-gradient(#f43f5e66_1px,transparent_1px)]";
};

const ContentLimitBar: FC<ContentLimitBarProps> = ({ capacity, icon, label, remaining }) => {
    if (capacity === 0) {
        return null;
    }

    const percentage = Math.round((remaining / capacity) * 100);

    return (
        <Progress className="gap-0" max={capacity} value={remaining}>
            <div className="flex items-center justify-between gap-2 pb-1 text-white">
                <ProgressLabel className="flex items-center gap-1.5 text-xs">
                    {icon}
                    {label}
                </ProgressLabel>
                <ProgressValue className="text-xs">{() => `${remaining}/${capacity}`}</ProgressValue>
            </div>
            <ProgressTrack className="h-1.5">
                <ProgressIndicator className={getOverallColor(percentage)} />
            </ProgressTrack>
        </Progress>
    );
};

const UsageCard: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();

    // A usage ring, not something first paint has to draw.
    const afterFirstPaint = useAfterFirstPaint();
    // Frozen per mount: a clock read per render would change the query key each minute.
    const [now] = useState(referenceNow);
    const { data: rateLimit } = useQuery(crpc.chat.functions.getMessageRateLimit.queryOptions(afterFirstPaint ? { now } : skipToken));

    if (!rateLimit) {
        return null;
    }

    const { audio, image, text, video } = rateLimit;

    // Calculate overall percentage from all types with capacity > 0
    const types = [text, image, video, audio].filter((bucket) => bucket.capacity > 0);
    const overallPercentage =
        types.length > 0 ? Math.round(types.reduce((sum, bucket) => sum + (bucket.remaining / bucket.capacity) * 100, 0) / types.length) : 0;

    return (
        <HoverCard>
            <HoverCardTrigger className="group relative flex cursor-help flex-col items-center overflow-hidden rounded-lg border">
                <div className="z-1 flex w-10 flex-col items-center gap-2.5 rounded-xl px-1.5 py-3 transition-colors">
                    <span className="text-brand-black dark:text-brand-white text-[11px] tracking-tight tabular-nums">{overallPercentage}%</span>
                    <div className="relative h-12 w-1.5 overflow-hidden rounded-full">
                        <div
                            className={clsx("absolute bottom-0 w-full rounded-full transition-all duration-700 ease-out", getOverallColor(overallPercentage))}
                            style={{
                                boxShadow: `0 0 8px 1px ${getOverallGlow(overallPercentage)}`,
                                height: `${overallPercentage}%`,
                            }}
                        />
                    </div>
                    <span className="text-brand-black dark:text-brand-white text-[7px] leading-none font-medium tracking-widest uppercase">{t`Usage`}</span>
                </div>
                <div
                    className={clsx(
                        "absolute inset-0 z-0 h-full w-11 mask-[radial-gradient(ellipse_60%_50%_at_50%_25%,#000_20%,transparent_100%)] bg-size-[4px_4px] opacity-60",
                        getOverallDots(overallPercentage),
                    )}
                />
            </HoverCardTrigger>
            <HoverCardContent align="end" className="dark w-56 space-y-3 border border-white/10 bg-zinc-900 p-3" side="right" sideOffset={12}>
                <p className="text-xs font-medium text-white/70">{t`Daily Usage`}</p>
                <ContentLimitBar capacity={text.capacity} icon={<FileText className="size-3" />} label={t`Text`} remaining={text.remaining} />
                <ContentLimitBar capacity={image.capacity} icon={<Image className="size-3" />} label={t`Image`} remaining={image.remaining} />
                <ContentLimitBar capacity={video.capacity} icon={<Video className="size-3" />} label={t`Video`} remaining={video.remaining} />
                <ContentLimitBar capacity={audio.capacity} icon={<Mic className="size-3" />} label={t`Audio`} remaining={audio.remaining} />
            </HoverCardContent>
        </HoverCard>
    );
};

export default UsageCard;
