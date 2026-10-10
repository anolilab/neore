"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import cn from "@ui/utils/cn";
import type { Experimental_TranscriptionResult as TranscriptionResult } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { createContext, use, useMemo } from "react";

type TranscriptionSegment = TranscriptionResult["segments"][number];

type TranscriptionContextValue = {
    currentTime: number;
    onSeek?: (time: number) => void;
    onTimeUpdate: (time: number) => void;
    segments: TranscriptionSegment[];
};

const TranscriptionContext = createContext<TranscriptionContextValue | null>(null);

const useTranscription = () => {
    const context = use(TranscriptionContext);

    if (!context) {
        throw new Error("Transcription components must be used within Transcription");
    }

    return context;
};

export type TranscriptionProps = Omit<ComponentProps<"div">, "children"> & {
    children: (segment: TranscriptionSegment, index: number) => ReactNode;
    currentTime?: number;
    onSeek?: (time: number) => void;
    segments: TranscriptionSegment[];
};

export const Transcription = ({ children, className, currentTime: externalCurrentTime, onSeek, segments, ...props }: TranscriptionProps) => {
    const [currentTime, setCurrentTime] = useControllableState({
        defaultProp: 0,
        onChange: onSeek,
        prop: externalCurrentTime,
    });

    const contextValue = useMemo<TranscriptionContextValue>(() => {
        return {
            currentTime,
            onSeek,
            onTimeUpdate: setCurrentTime,
            segments,
        };
    }, [currentTime, onSeek, setCurrentTime, segments]);

    return (
        <TranscriptionContext value={contextValue}>
            <div className={cn("flex flex-wrap gap-1 text-sm leading-relaxed", className)} data-slot="transcription" {...props}>
                {segments.filter((segment) => segment.text.trim()).map((segment, index) => children(segment, index))}
            </div>
        </TranscriptionContext>
    );
};

export type TranscriptionSegmentProps = ComponentProps<"button"> & {
    index: number;
    segment: TranscriptionSegment;
};

export const TranscriptionSegment = ({ className, index, onClick, segment, ...props }: TranscriptionSegmentProps) => {
    const { currentTime, onSeek } = useTranscription();

    const isActive = currentTime >= segment.startSecond && currentTime < segment.endSecond;
    const isPast = currentTime >= segment.endSecond;

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (onSeek) {
            onSeek(segment.startSecond);
        }

        onClick?.(event);
    };

    return (
        <button
            className={cn(
                "inline text-left",
                isActive && "text-primary",
                isPast && "text-muted-foreground",
                !(isActive || isPast) && "text-muted-foreground/60",
                onSeek && "hover:text-foreground cursor-pointer",
                !onSeek && "cursor-default",
                className,
            )}
            data-active={isActive}
            data-index={index}
            data-slot="transcription-segment"
            onClick={handleClick}
            type="button"
            {...props}
        >
            {segment.text}
        </button>
    );
};
