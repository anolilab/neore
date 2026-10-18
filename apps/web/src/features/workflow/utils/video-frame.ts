/**
 * Captures one frame of a video in the browser: the video is drawn to a canvas
 * and encoded as PNG. Frames are read here, not on the backend, because no
 * server step can decode video (there is no media service).
 *
 * The browser refuses to read pixels from a video served from another origin
 * without CORS, so the video must be served with `Access-Control-Allow-Origin`
 * (the backend's signed storage URLs are).
 */
/** The end frame is taken this far before the duration: the final sample often cannot be decoded. */
const LAST_FRAME_INSET_SECONDS = 1 / 24;

/** A load or seek that takes longer is failed, not awaited forever. */
const STEP_TIMEOUT_MS = 15_000;

export type FrameCaptureReason = "cors" | "load" | "timeout";

export class FrameCaptureError extends Error {
    public readonly reason: FrameCaptureReason;

    public constructor(reason: FrameCaptureReason) {
        super(`Frame capture failed: ${reason}`);
        this.name = "FrameCaptureError";
        this.reason = reason;
    }
}

/** Seconds into the clip the picked frame is taken at: the requested time, clamped into the clip and off its final sample. */
export const pickedFrameTime = (duration: number, pickedTime: number): number => {
    const last = Math.max(0, duration - LAST_FRAME_INSET_SECONDS);

    return Math.min(Math.max(0, pickedTime), last);
};

const settle = (video: HTMLVideoElement, event: "loadeddata" | "seeked"): Promise<void> =>
    new Promise((resolve, reject) => {
        // One abort removes both listeners, so the handlers need no names to remove them by.
        const listeners = new AbortController();
        const timer = setTimeout(() => {
            listeners.abort();
            reject(new FrameCaptureError("timeout"));
        }, STEP_TIMEOUT_MS);
        const finish = (error?: FrameCaptureError): void => {
            clearTimeout(timer);
            listeners.abort();

            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        video.addEventListener(event, () => finish(), { signal: listeners.signal });
        video.addEventListener("error", () => finish(new FrameCaptureError("load")), { signal: listeners.signal });
    });

/**
 * A PNG of the frame at `timeFor(duration)` of the video at `videoUrl`. Rejects with a
 * {@link FrameCaptureError}: `cors` when the browser will not let the pixels be read.
 */
export const captureVideoFrame = async (videoUrl: string, timeFor: (duration: number) => number): Promise<Blob> => {
    const video = document.createElement("video");

    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const loaded = settle(video, "loadeddata");

    video.src = videoUrl;
    await loaded;

    const target = timeFor(video.duration);

    if (Math.abs(target - video.currentTime) > 0.001) {
        const seeked = settle(video, "seeked");

        video.currentTime = target;
        await seeked;
    }

    const canvas = document.createElement("canvas");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");

    if (!context) {
        throw new FrameCaptureError("load");
    }

    context.drawImage(video, 0, 0);

    // Reading one pixel throws a SecurityError when the video was not CORS-readable.
    try {
        context.getImageData(0, 0, 1, 1);
    } catch {
        throw new FrameCaptureError("cors");
    }

    return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new FrameCaptureError("load"));
            }
        }, "image/png");
    });
};

/**
 * The URL of the clip a video node generated: `assets[0].videoUrl`, the one shape a run stores, or a
 * top-level `videoUrl` saved by an older run.
 */
export const videoUrlOfOutput = (output: unknown): string | undefined => {
    const object = output as { assets?: unknown; videoUrl?: unknown } | undefined;
    const first = Array.isArray(object?.assets) ? (object.assets[0] as { videoUrl?: unknown } | undefined) : undefined;
    const url = typeof first?.videoUrl === "string" ? first.videoUrl : object?.videoUrl;

    return typeof url === "string" && url.startsWith("http") ? url : undefined;
};
