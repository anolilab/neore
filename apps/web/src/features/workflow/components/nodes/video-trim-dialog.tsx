import { useLingui } from "@lingui/react/macro";
import { MAX_REFERENCE_VIDEO_BYTES } from "@neore/backend/document-limits";
import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ui/components/responsive-dialog";
import type { SyntheticEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

import type { TrimRange } from "../../utils/video-trim";
import {
    clampTrimRange,
    REFERENCE_VIDEO_MAX_SECONDS,
    REFERENCE_VIDEO_MIN_SECONDS,
    referenceVideoLength,
    trimmedLength,
    TrimOutputTooLargeError,
} from "../../utils/video-trim";

const MEGABYTE = 1024 * 1024;

const formatSeconds = (seconds: number): string => seconds.toFixed(1);

export interface VideoTrimDialogProps {
    file: File;
    /** Closed without an upload: the node keeps what it had. */
    onCancel: () => void;
    /** The file to upload: the trimmed MP4, or the original when the user skips the trim. */
    onConfirm: (file: File) => void;
    /** An object URL of `file`, created and revoked by the caller. */
    src: string;
}

/**
 * Picks the part of a reference video to keep, re-encodes it as MP4 in the
 * browser and hands the result to the node's upload. The preview is the
 * source, from a native `<video>`: its duration bounds the range, and the
 * encoder library only loads when the user starts the trim.
 */
const VideoTrimDialog = ({ file, onCancel, onConfirm, src }: VideoTrimDialogProps) => {
    const { t } = useLingui();
    const startId = useId();
    const endId = useId();
    const videoRef = useRef<HTMLVideoElement>(null);
    const abortRef = useRef<AbortController | undefined>(undefined);
    const [duration, setDuration] = useState<number>();
    const [previewFailed, setPreviewFailed] = useState(false);
    const [range, setRange] = useState<TrimRange>({ end: 0, start: 0 });
    const [progress, setProgress] = useState<number>();
    const [error, setError] = useState<string | null>(null);

    useEffect(
        () => () => {
            abortRef.current?.abort();
        },
        [],
    );

    const isEncoding = progress !== undefined;
    const oversized = file.size > MAX_REFERENCE_VIDEO_BYTES;
    const length = trimmedLength(range);
    const lengthState = referenceVideoLength(length);
    // A single clip may be shorter than the 2 s minimum, since references add up; one over 15 s can never fit.
    const canTrim = duration !== undefined && !previewFailed && !isEncoding && lengthState !== "too-long";

    const onMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
        const seconds = event.currentTarget.duration;

        if (!Number.isFinite(seconds) || seconds <= 0) {
            setPreviewFailed(true);

            return;
        }

        setDuration(seconds);
        setRange({ end: Math.min(seconds, REFERENCE_VIDEO_MAX_SECONDS), start: 0 });
    };

    const updateRange = (next: TrimRange, moved: "start" | "end") => {
        if (duration === undefined) {
            return;
        }

        const clamped = clampTrimRange(next, duration);

        setRange(clamped);

        // Show the frame the start handle points at, the one that is kept.
        if (moved === "start" && videoRef.current) {
            videoRef.current.currentTime = clamped.start;
        }
    };

    const handleTrim = async () => {
        const controller = new AbortController();

        abortRef.current = controller;
        setError(null);
        setProgress(0);

        try {
            // The encoder is its own chunk: it is fetched on the first trim, not with the editor.
            const { trimVideo } = await import("../../utils/video-trim-encode");
            const trimmed = await trimVideo(file, {
                onProgress: (fraction) => {
                    setProgress(Math.round(fraction * 100));
                },
                range,
                signal: controller.signal,
            });

            onConfirm(trimmed);
        } catch (error_) {
            if (!controller.signal.aborted) {
                setError(
                    error_ instanceof TrimOutputTooLargeError
                        ? t`The trimmed video is larger than ${String(MAX_REFERENCE_VIDEO_BYTES / MEGABYTE)} MB. Choose a shorter range.`
                        : t`This video could not be trimmed in this browser. Upload it without trimming instead.`,
                );
            }
        } finally {
            abortRef.current = undefined;
            setProgress(undefined);
        }
    };

    const handleCancel = () => {
        abortRef.current?.abort();
        onCancel();
    };

    return (
        <Dialog
            onOpenChange={(open) => {
                if (!open) {
                    handleCancel();
                }
            }}
            open
        >
            <DialogContent className="nokey max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t`Trim video`}</DialogTitle>
                    <DialogDescription>
                        {t`Keep part of the video. The kept part is re-encoded as MP4 in this browser, which can take a moment.`}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 px-6 pb-2">
                    <video
                        className="w-full rounded-md bg-black"
                        controls
                        muted
                        onError={() => {
                            setPreviewFailed(true);
                        }}
                        onLoadedMetadata={onMetadata}
                        playsInline
                        preload="metadata"
                        ref={videoRef}
                        src={src}
                    />
                    {previewFailed && (
                        <p className="text-destructive text-sm" role="alert">
                            {t`This video cannot be previewed in this browser, so it cannot be trimmed here.`}
                        </p>
                    )}
                    {duration !== undefined && (
                        <fieldset className="flex flex-col gap-3" disabled={isEncoding}>
                            <legend className="sr-only">{t`Range to keep`}</legend>
                            <div className="flex flex-col gap-1 text-sm">
                                <div className="flex justify-between">
                                    <label htmlFor={startId}>{t`Start`}</label>
                                    <span aria-hidden="true" className="tabular-nums">{`${formatSeconds(range.start)} s`}</span>
                                </div>
                                <input
                                    aria-valuetext={`${formatSeconds(range.start)} s`}
                                    id={startId}
                                    max={duration}
                                    min={0}
                                    onChange={(event) => {
                                        updateRange({ end: range.end, start: Number(event.currentTarget.value) }, "start");
                                    }}
                                    step={0.1}
                                    type="range"
                                    value={range.start}
                                />
                            </div>
                            <div className="flex flex-col gap-1 text-sm">
                                <div className="flex justify-between">
                                    <label htmlFor={endId}>{t`End`}</label>
                                    <span aria-hidden="true" className="tabular-nums">{`${formatSeconds(range.end)} s`}</span>
                                </div>
                                <input
                                    aria-valuetext={`${formatSeconds(range.end)} s`}
                                    id={endId}
                                    max={duration}
                                    min={0}
                                    onChange={(event) => {
                                        updateRange({ end: Number(event.currentTarget.value), start: range.start }, "end");
                                    }}
                                    step={0.1}
                                    type="range"
                                    value={range.end}
                                />
                            </div>
                        </fieldset>
                    )}
                    <div aria-live="polite" className="flex flex-col gap-1 text-sm" role="status">
                        {duration !== undefined && <p className="tabular-nums">{t`Trimmed length: ${formatSeconds(length)} s`}</p>}
                        {duration !== undefined && lengthState === "too-short" && (
                            <p className="text-muted-foreground">
                                {t`Reference videos together must be at least ${String(REFERENCE_VIDEO_MIN_SECONDS)} seconds.`}
                            </p>
                        )}
                        {lengthState === "too-long" && (
                            <p className="text-destructive">{t`A reference video can be at most ${String(REFERENCE_VIDEO_MAX_SECONDS)} seconds.`}</p>
                        )}
                        {isEncoding && <p>{t`Trimming… ${String(progress)}%`}</p>}
                    </div>
                    {progress !== undefined && <progress aria-label={t`Trimming progress`} className="w-full" max={100} value={progress} />}
                    {error && (
                        <p className="text-destructive text-sm" role="alert">
                            {error}
                        </p>
                    )}
                    {oversized && (
                        <p className="text-muted-foreground text-xs">
                            {t`This video is larger than ${String(MAX_REFERENCE_VIDEO_BYTES / MEGABYTE)} MB, so it must be trimmed.`}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button onClick={handleCancel} variant="ghost">
                        {t`Cancel`}
                    </Button>
                    {!oversized && (
                        <Button disabled={isEncoding} onClick={() => onConfirm(file)} variant="outline">
                            {t`Upload without trimming`}
                        </Button>
                    )}
                    <Button disabled={!canTrim} onClick={handleTrim}>
                        {t`Trim and upload`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default VideoTrimDialog;
