/**
 * The dictation window's page: opens the microphone, turns what it hears into 16 kHz mono 16-bit samples, and hands each chunk to the
 * preload. The audio exists only in memory, here and in the main process; this page has no network and no storage.
 */
import type { CaptureFailure } from "../channels";
import { SAMPLE_RATE } from "../channels";
import type { DictationWindowApi } from "./api";

/** 1024 samples are 64 ms: small enough that the tail left in the buffer at release is a syllable at most. */
const BUFFER_SAMPLES = 1024;
/** The key is up a moment after the last word; capture runs on briefly so the end of it is not clipped. */
const RELEASE_GRACE_MS = 150;

const api = (globalThis as unknown as { neoreDictation: DictationWindowApi }).neoreDictation;
const status = document.querySelector<HTMLElement>("#status");
const level = document.querySelector<HTMLElement>("#level");

const show = (text: string): void => {
    if (status !== null) {
        status.textContent = text;
    }
};

const failureOf = (error: unknown): CaptureFailure => {
    const name = error instanceof DOMException ? error.name : "";

    if (name === "NotAllowedError" || name === "SecurityError") {
        return "denied";
    }

    return name === "NotFoundError" || name === "OverconstrainedError" ? "no-device" : "error";
};

const toInt16 = (samples: Float32Array): Int16Array => {
    const out = new Int16Array(samples.length);

    for (const [index, sample] of samples.entries()) {
        const clamped = Math.max(-1, Math.min(1, sample ?? 0));

        out[index] = clamped * (clamped < 0 ? 0x80_00 : 0x7F_FF);
    }

    return out;
};

const rms = (samples: Float32Array): number => {
    let sum = 0;

    for (const sample of samples) {
        sum += sample * sample;
    }

    return Math.sqrt(sum / Math.max(1, samples.length));
};

/** What the stop handler needs from the capture, which may not have started when the stop arrives. */
const capturing: { release?: () => Promise<void>; stopped: boolean } = { stopped: false };

const closeStream = (stream: MediaStream): void => {
    for (const track of stream.getTracks()) {
        track.stop();
    }
};

const capture = async (): Promise<void> => {
    let stream: MediaStream;

    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (error) {
        show("The microphone is not available.");
        api.failed(failureOf(error));

        return;
    }

    // Released while the microphone was still opening: nothing to record.
    if (capturing.stopped) {
        closeStream(stream);

        return;
    }

    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = context.createMediaStreamSource(stream);
    // Deprecated, but the one tap that needs no module script: a worklet cannot be loaded from a file page.
    const processor = context.createScriptProcessor(BUFFER_SAMPLES, 1, 1);

    processor.addEventListener("audioprocess", (event) => {
        const samples = event.inputBuffer.getChannelData(0);

        api.audio(toInt16(samples).buffer as ArrayBuffer);

        if (level !== null) {
            level.style.transform = `scaleX(${Math.min(1, rms(samples) * 6)})`;
        }
    });
    source.connect(processor);
    processor.connect(context.destination);
    show("Listening…");

    capturing.release = async () => {
        processor.disconnect();
        source.disconnect();
        closeStream(stream);
        await context.close();
    };
};

// Registered before the microphone opens, so a release that comes first is not lost.
api.onStop(() => {
    capturing.stopped = true;
    setTimeout(async () => {
        await capturing.release?.();
        api.ended();
    }, RELEASE_GRACE_MS);
});

// eslint-disable-next-line unicorn/prefer-top-level-await -- the page builds as an IIFE, where top-level await does not parse
capture();
