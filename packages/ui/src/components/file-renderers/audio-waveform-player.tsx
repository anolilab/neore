"use client";

/**
 * Audio Waveform Player — code-split, lazy-loaded.
 * Uses wavesurfer.js for waveform visualization.
 *
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const AudioWaveformPlayer = lazy(() => import("@neore/ui/components/file-renderers/audio-waveform-player"));
 * ```
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { Pause, Play } from "lucide-react";
import type { FC } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

export interface AudioWaveformPlayerProps {
    className?: string;
    filename?: string;
    url: string;
}

const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const AudioWaveformPlayer: FC<AudioWaveformPlayerProps> = memo(({ className, filename, url }) => {
    const { t } = useLingui();
    const containerRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WaveSurfer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isReady, setIsReady] = useState(false);
    const [error, setError] = useState(false);

    useEffect(() => {
        if (!containerRef.current) {
            return undefined;
        }

        const ws = WaveSurfer.create({
            container: containerRef.current,
            cursorColor: "var(--color-primary)",
            cursorWidth: 2,
            height: 48,
            progressColor: "var(--color-primary)",
            url,
            waveColor: "var(--color-secondary)",
        });

        wsRef.current = ws;

        ws.on("ready", () => {
            setDuration(ws.getDuration());
            setIsReady(true);
        });
        ws.on("timeupdate", (time) => setCurrentTime(time));
        ws.on("play", () => setIsPlaying(true));
        ws.on("pause", () => setIsPlaying(false));
        ws.on("finish", () => setIsPlaying(false));
        ws.on("error", () => setError(true));

        return () => {
            ws.destroy();
            wsRef.current = null;
        };
    }, [url]);

    const togglePlay = useCallback(() => {
        wsRef.current?.playPause();
    }, []);

    if (error) {
        return (
            <div className={cn("my-2 rounded-lg border p-4 text-center", className)}>
                <p className="text-muted-foreground text-sm">{t`Failed to load audio`}</p>
                {filename && <p className="text-muted-foreground mt-1 text-xs">{filename}</p>}
            </div>
        );
    }

    return (
        <div className={cn("my-2 flex w-full max-w-lg items-center gap-3 rounded-lg border p-3", className)}>
            <button
                aria-label={isPlaying ? t`Pause` : t`Play`}
                className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-40"
                disabled={!isReady}
                onClick={togglePlay}
                type="button"
            >
                {isPlaying ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="ml-0.5 size-4" />}
            </button>

            <div className="min-w-0 flex-1">
                {filename && <div className="mb-1 truncate text-xs font-medium">{filename}</div>}
                <div ref={containerRef} />
                <div className="text-muted-foreground mt-1 flex justify-between text-[10px] tabular-nums">
                    <span>{formatTime(currentTime)}</span>
                    <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
                </div>
            </div>
        </div>
    );
});

AudioWaveformPlayer.displayName = "AudioWaveformPlayer";

export default AudioWaveformPlayer;
