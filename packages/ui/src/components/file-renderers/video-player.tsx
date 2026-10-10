"use client";

/**
 * Video Player — code-split, lazy-loaded.
 * Uses media-chrome for consistent controls styling.
 * Supports HLS streams via hls.js (loaded only when needed).
 *
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const VideoPlayer = lazy(() => import("@neore/ui/components/file-renderers/video-player"));
 * ```
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import HlsPlayer, { Events as HlsEvents } from "hls.js";
import {
    MediaControlBar,
    MediaController,
    MediaDurationDisplay,
    MediaFullscreenButton,
    MediaMuteButton,
    MediaPlayButton,
    MediaTimeDisplay,
    MediaTimeRange,
    MediaVolumeRange,
} from "media-chrome/react";
import type { CSSProperties, FC } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

export interface VideoPlayerProps {
    className?: string;
    filename?: string;
    mediaType?: string;
    url: string;
}

const isHlsUrl = (url: string, mediaType?: string): boolean => mediaType === "application/vnd.apple.mpegurl" || url.endsWith(".m3u8");

const VideoPlayer: FC<VideoPlayerProps> = memo(({ className, filename, mediaType, url }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<HlsPlayer | null>(null);
    const { t } = useLingui();
    const [error, setError] = useState<"stream" | "unsupported" | null>(null);

    const setupHls = useCallback(() => {
        const video = videoRef.current;

        if (!video || !isHlsUrl(url, mediaType)) {
            return;
        }

        // Safari has native HLS support
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = url;

            return;
        }

        if (!HlsPlayer.isSupported()) {
            setError("unsupported");

            return;
        }

        const hls = new HlsPlayer();

        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(HlsEvents.ERROR, (_event, data) => {
            if (data.fatal) {
                setError("stream");
            }
        });
    }, [url, mediaType]);

    useEffect(() => {
        setupHls();

        return () => {
            hlsRef.current?.destroy();
            hlsRef.current = null;
        };
    }, [setupHls]);

    if (error) {
        return (
            <div className={cn("my-2 rounded-lg border p-4 text-center", className)}>
                <p className="text-muted-foreground text-sm">
                    {error === "unsupported" ? t`HLS playback is not supported in this browser.` : t`Failed to load video stream.`}
                </p>
                {filename && <p className="text-muted-foreground mt-1 text-xs">{filename}</p>}
            </div>
        );
    }

    const mediaChromeStyles = {
        "--media-background-color": "transparent",
        "--media-button-icon-height": "1rem",
        "--media-button-icon-width": "1rem",
        "--media-control-background": "transparent",
        "--media-control-hover-background": "rgba(255,255,255,0.1)",
        "--media-font": "var(--font-sans)",
        "--media-font-size": "10px",
        "--media-icon-color": "white",
        "--media-primary-color": "white",
        "--media-range-bar-color": "white",
        "--media-range-track-background": "rgba(255,255,255,0.3)",
        "--media-text-color": "white",
        "--media-tooltip-arrow-display": "none",
        "--media-tooltip-background": "rgba(0,0,0,0.7)",
        "--media-tooltip-border-radius": "var(--radius-md)",
    } as CSSProperties;

    return (
        <div className={cn("my-2 w-full max-w-2xl overflow-hidden rounded-lg border", className)}>
            <MediaController style={mediaChromeStyles}>
                <video
                    crossOrigin="anonymous"
                    data-slot="video-player"
                    playsInline
                    preload="metadata"
                    ref={videoRef}
                    slot="media"
                    src={isHlsUrl(url, mediaType) ? undefined : url}
                    style={{ maxHeight: "500px", width: "100%" }}
                />
                <MediaControlBar>
                    <MediaPlayButton />
                    <MediaTimeDisplay />
                    <MediaTimeRange />
                    <MediaDurationDisplay />
                    <MediaMuteButton />
                    <MediaVolumeRange />
                    <MediaFullscreenButton />
                </MediaControlBar>
            </MediaController>
            {filename && (
                <div className="bg-muted/50 border-t px-3 py-1.5">
                    <span className="text-muted-foreground truncate text-xs">{filename}</span>
                </div>
            )}
        </div>
    );
});

VideoPlayer.displayName = "VideoPlayer";

export default VideoPlayer;
