/**
 * Pure rules for trimming a reference video before it is uploaded: the range
 * the user picks, the length a reference video must have, and the size its
 * re-encoded output may take. The encoder itself is `video-trim-encode.ts`.
 */
import { MAX_REFERENCE_VIDEO_BYTES } from "@neore/backend/document-limits";

/** Seedance's reference-to-video inputs take 2 to 15 seconds of total length. */
export const REFERENCE_VIDEO_MIN_SECONDS = 2;
export const REFERENCE_VIDEO_MAX_SECONDS = 15;

/** The re-encoded clip is over the reference-video cap. */
export class TrimOutputTooLargeError extends Error {}

/** The shortest range a trim may keep. */
export const MIN_TRIM_SECONDS = 0.1;

/** Upper bound for the re-encoded video track; short clips do not need more. */
const MAX_VIDEO_BITRATE = 12_000_000;

/** Floor so a very long clip still encodes; the output guard catches what this cannot fit. */
const MIN_VIDEO_BITRATE = 100_000;

export const AUDIO_BITRATE = 128_000;

/** Headroom for container overhead and bitrate variance under the byte cap. */
const BUDGET_SHARE = 0.9;

export interface TrimRange {
    /** Seconds into the source where the kept clip ends. */
    end: number;
    /** Seconds into the source where the kept clip starts. */
    start: number;
}

/** Keeps a range inside `[0, duration]`, with `start` at least {@link MIN_TRIM_SECONDS} before `end`. */
export const clampTrimRange = ({ start, end }: TrimRange, duration: number): TrimRange => {
    const clampedEnd = Math.min(Math.max(end, 0), duration);
    const clampedStart = Math.min(Math.max(start, 0), Math.max(clampedEnd - MIN_TRIM_SECONDS, 0));

    return { end: clampedEnd, start: clampedStart };
};

export const trimmedLength = ({ start, end }: TrimRange): number => end - start;

export type ReferenceVideoLength = "ok" | "too-long" | "too-short";

/** Whether a clip of `seconds` is within what a reference video may be. */
export const referenceVideoLength = (seconds: number): ReferenceVideoLength => {
    if (seconds < REFERENCE_VIDEO_MIN_SECONDS) {
        return "too-short";
    }

    return seconds > REFERENCE_VIDEO_MAX_SECONDS ? "too-long" : "ok";
};

/** The video bitrate that keeps a re-encoded clip of `seconds` under `maxBytes`, within the bounds above. */
export const videoBitrateFor = (seconds: number, maxBytes: number = MAX_REFERENCE_VIDEO_BYTES): number => {
    const budget = (maxBytes * 8 * BUDGET_SHARE) / Math.max(seconds, MIN_TRIM_SECONDS);

    return Math.floor(Math.min(MAX_VIDEO_BITRATE, Math.max(budget - AUDIO_BITRATE, MIN_VIDEO_BITRATE)));
};

/** The longest side a re-encoded reference video keeps, so a 4K source encodes in reasonable time. */
export const MAX_OUTPUT_SIDE = 1920;

/** The size to re-encode a `width` x `height` frame at, or `undefined` when it already fits {@link MAX_OUTPUT_SIDE}. */
export const outputSizeFor = (width: number, height: number): { height: number; width: number } | undefined => {
    const longest = Math.max(width, height);

    if (longest <= MAX_OUTPUT_SIDE) {
        return undefined;
    }

    // H.264 wants even dimensions.
    const even = (value: number): number => Math.round((value * MAX_OUTPUT_SIDE) / longest / 2) * 2;

    return { height: even(height), width: even(width) };
};

/** Whether a trimmed output of `bytes` is over the reference-video cap. */
export const exceedsReferenceVideoLimit = (bytes: number): boolean => bytes > MAX_REFERENCE_VIDEO_BYTES;

const FTYP = [0x66, 0x74, 0x79, 0x70];

/** Whether the first bytes of a file are an MP4 `ftyp` box, which the upload route checks at offset 4. */
export const hasMp4Header = (head: Uint8Array): boolean => head.length >= 8 && FTYP.every((byte, index) => head[4 + index] === byte);

const SUPPORT_PROBE = {
    audio: { codec: "mp4a.40.2", bitrate: AUDIO_BITRATE, numberOfChannels: 2, sampleRate: 48_000 },
    video: { bitrate: 2_000_000, codec: "avc1.42001f", height: 720, width: 1280 },
} as const;

const support: { pending?: Promise<boolean> } = {};

const detectTrimSupport = async (): Promise<boolean> => {
    if (
        typeof VideoEncoder === "undefined" ||
        typeof AudioEncoder === "undefined" ||
        typeof VideoDecoder === "undefined" ||
        typeof AudioDecoder === "undefined"
    ) {
        return false;
    }

    try {
        const [video, audio] = await Promise.all([VideoEncoder.isConfigSupported(SUPPORT_PROBE.video), AudioEncoder.isConfigSupported(SUPPORT_PROBE.audio)]);

        return video.supported === true && audio.supported === true;
    } catch {
        return false;
    }
};

/**
 * Whether this browser can re-encode a clip to H.264/AAC MP4 with WebCodecs.
 * Answered once per page: the trim control is hidden where this is false, and
 * the plain upload stays. Uses the platform API directly, so the encoder library
 * is not loaded just to show or hide a button.
 */
export const canTrimVideo = (): Promise<boolean> => {
    support.pending ??= detectTrimSupport();

    return support.pending;
};
