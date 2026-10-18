/**
 * Cut a clip out of a video in the browser and re-encode it as H.264/AAC MP4,
 * with `mediabunny` (WebCodecs). Stream copy is not available here, so every
 * kept frame is decoded and encoded again, which is fine for the clips a
 * reference video is (at most 15 s is what the model takes).
 *
 * This module is the only importer of the library, and the dialog imports this
 * module dynamically when a trim starts, so the library is its own chunk. That
 * chunk is named after this file, and `WEB_CLIENT_ONLY_CHUNKS`
 * (`scripts/worker-bundle.ts`) keeps it out of the web Worker's upload.
 */
import { BlobSource, BufferTarget, Conversion, ConversionCanceledError, Input, MP4, Mp4OutputFormat, Output, QTFF } from "mediabunny";

import type { TrimRange } from "./video-trim";
import { AUDIO_BITRATE, exceedsReferenceVideoLimit, hasMp4Header, outputSizeFor, TrimOutputTooLargeError, videoBitrateFor } from "./video-trim";

const EXTENSION = /\.[^.]*$/u;

export interface TrimVideoOptions {
    /** Fraction of the kept clip encoded so far, 0–1. */
    onProgress?: (fraction: number) => void;
    range: TrimRange;
    /** Aborting cancels the encode and rejects with an `AbortError`. */
    signal?: AbortSignal;
}

const abortError = (): DOMException => new DOMException("The trim was cancelled", "AbortError");

/**
 * The kept range of `file` as a new MP4 `File`, named after the source. The
 * result is checked against the reference-video cap and for an `ftyp` box
 * before it is returned, so a file the upload route would refuse never leaves
 * the browser.
 */
export const trimVideo = async (file: File, { onProgress, range, signal }: TrimVideoOptions): Promise<File> => {
    if (signal?.aborted) {
        throw abortError();
    }

    // Reference video is MP4 or QuickTime (`referenceMediaTypeOf`); naming the two keeps the other demuxers out of the chunk.
    const input = new Input({ formats: [MP4, QTFF], source: new BlobSource(file) });

    try {
        const target = new BufferTarget();
        const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
        const conversion = await Conversion.init({
            // Transcode everything: a copied track starts at the keyframe before `start`, so the clip could run longer than the range shown.
            copy: false,
            audio: { bitrate: AUDIO_BITRATE, codec: "aac" },
            input,
            output,
            trim: { end: range.end, start: range.start },
            video: (track) => {
                return {
                    bitrate: videoBitrateFor(range.end - range.start),
                    codec: "avc",
                    ...outputSizeFor(track.displayWidth, track.displayHeight),
                    fit: "contain",
                };
            },
        });

        if (!conversion.isValid || conversion.utilizedTracks.every((track) => !track.isVideoTrack())) {
            const reasons = conversion.discardedTracks.map((track) => track.reason).join(", ");

            // The source has no video this browser can decode, or the encoder refused it.
            throw new Error(reasons || "no video track");
        }

        // An abort during `init` fired before this listener existed, so it is honoured here, before anything executes.
        if (signal?.aborted) {
            await conversion.cancel();

            throw abortError();
        }

        const onAbort = (): void => {
            void conversion.cancel();
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        conversion.onProgress = (fraction) => onProgress?.(fraction);

        try {
            await conversion.execute();
        } catch (error) {
            if (error instanceof ConversionCanceledError || signal?.aborted) {
                throw abortError();
            }

            throw error;
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }

        const { buffer } = target;

        if (!buffer) {
            throw new Error("no output");
        }

        if (exceedsReferenceVideoLimit(buffer.byteLength)) {
            throw new TrimOutputTooLargeError();
        }

        if (!hasMp4Header(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8)))) {
            throw new Error("output is not MP4");
        }

        const name = `${file.name.replace(EXTENSION, "") || "video"}.mp4`;

        return new File([buffer], name, { type: "video/mp4" });
    } finally {
        input.dispose();
    }
};
