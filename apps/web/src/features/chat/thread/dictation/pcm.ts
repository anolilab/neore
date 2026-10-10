/**
 * PCM helpers for realtime dictation: the microphone delivers Float32 frames at
 * the AudioContext's native rate (usually 44.1/48 kHz), ElevenLabs Scribe wants
 * 16-bit little-endian PCM at 16 kHz, base64-encoded.
 *
 * We resample ourselves rather than asking for `new AudioContext({ sampleRate: 16000 })`
 * because Firefox refuses to connect a microphone stream to a context whose rate
 * differs from the device's.
 */

export const TARGET_SAMPLE_RATE = 16_000;

/** Box-filter downsample: averages each output sample's input window (cheap anti-aliasing). */
export const downsample = (input: Float32Array, inputRate: number, outputRate: number = TARGET_SAMPLE_RATE): Float32Array => {
    if (inputRate === outputRate) {
        return input;
    }

    if (inputRate < outputRate) {
        throw new RangeError(`Cannot upsample from ${inputRate} Hz to ${outputRate} Hz`);
    }

    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);

    for (let index = 0; index < outputLength; index += 1) {
        const start = Math.floor(index * ratio);
        const end = Math.min(input.length, Math.floor((index + 1) * ratio));
        let sum = 0;

        for (let cursor = start; cursor < end; cursor += 1) {
            sum += input[cursor] ?? 0;
        }

        output[index] = end > start ? sum / (end - start) : 0;
    }

    return output;
};

/** Float32 [-1, 1] → 16-bit little-endian PCM bytes (clamped). */
export const floatTo16BitPcm = (input: Float32Array): Uint8Array => {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);

    for (const [index, element] of input.entries()) {
        const sample = Math.max(-1, Math.min(1, element ?? 0));

        view.setInt16(index * 2, sample * (sample < 0 ? 0x80_00 : 0x7f_ff), true);
    }

    return new Uint8Array(buffer);
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunkSize = 0x80_00;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCodePoint(...bytes.subarray(offset, offset + chunkSize));
    }

    return btoa(binary);
};

/**
 * Appends dictated segments to the text that was in the composer when dictation
 * started. The base is kept verbatim; segments are trimmed and joined with a
 * single space unless the text already ends in whitespace.
 */
const TRAILING_WHITESPACE = /\s$/;

export const joinTranscript = (base: string, ...segments: string[]): string => {
    let result = base;

    for (const raw of segments) {
        const segment = raw.trim();

        if (!segment) {
            continue;
        }

        result = result && !TRAILING_WHITESPACE.test(result) ? `${result} ${segment}` : `${result}${segment}`;
    }

    return result;
};
