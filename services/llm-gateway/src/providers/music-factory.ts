/**
 * Music provider factory.
 *
 * Music has no AI SDK V3 primitive, so we call FAL's queue API directly:
 *   1. POST https://queue.fal.run/{endpoint}                 → returns { request_id, status_url, response_url }
 *   2. Poll GET status_url until status === "COMPLETED"     (with backoff)
 *   3. GET response_url                                       → final result with audio.url / audio_file.url
 *   4. Fetch the audio bytes from that URL
 *
 * Each FAL music endpoint has slightly different output shapes — Stable
 * Audio 2.5 and Lyria 2 return `audio.url`; MusicGen and Cassette AI return
 * `audio_file.url`. {@link extractAudioPart} normalises both.
 *
 * The music-model catalog is derived from `@neore/ai`'s `MODEL_REGISTRY`
 * (single source of truth). Add or change music models in
 * `packages/ai/src/models/registry.ts` — set `gatewayKey`,
 * `costPerMusicGenerationMicrodollars`, and the `gateway*` metadata fields
 * to expose a model here.
 */
import type { JSONObject } from "@ai-sdk/provider";
import type { GatewayMusicModelInfo } from "@neore/ai/models";
import { GATEWAY_MUSIC_MODELS } from "@neore/ai/models";

import { GatewayError } from "../lib/errors.js";

/** Music model metadata — re-exported under the gateway's historical name. */
export type MusicModelInfo = GatewayMusicModelInfo;

export const MUSIC_MODELS: Record<string, MusicModelInfo> = GATEWAY_MUSIC_MODELS;

/**
 * Result of a successful FAL music render. The factory has already fetched
 * the bytes from FAL's output URL so the caller can upload them straight to R2.
 */
export interface MusicRenderResult {
    bytes: Uint8Array;
    mimeType: string;
    /** Reported sample rate, when FAL surfaces it (some endpoints do, some don't). */
    sampleRate?: number;
}

/**
 * Run a single music generation against FAL via the queue API.
 *
 * Caller is responsible for telemetry. This function throws on transient
 * failures (network / 5xx / timeouts) so the render core's existing
 * `isTransient` heuristic can decide retry-vs-fail.
 */
export const runFalMusicGeneration = async (
    endpoint: string,
    apiKey: string,
    inputs: JSONObject,
    options: { maxPollMs?: number; pollIntervalMs?: number } = {},
): Promise<MusicRenderResult> => {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const maxPollMs = options.maxPollMs ?? 5 * 60 * 1000; // 5 min cap; music typically <30s

    const submitUrl = `https://queue.fal.run/${endpoint}`;
    const submitResponse = await fetch(submitUrl, {
        body: JSON.stringify(inputs),
        headers: {
            Authorization: `Key ${apiKey}`,
            "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
    });

    if (!submitResponse.ok) {
        const text = await submitResponse.text().catch(() => "");

        throw new GatewayError("PROVIDER_ERROR", `FAL submit failed (${submitResponse.status}): ${text.slice(0, 500)}`, { statusCode: submitResponse.status });
    }

    const submit = (await submitResponse.json()) as { request_id?: string; response_url?: string; status_url?: string };

    if (!submit.status_url || !submit.response_url) {
        throw new GatewayError("PROVIDER_ERROR", "FAL submit returned malformed response (missing status_url / response_url)");
    }

    const deadline = Date.now() + maxPollMs;

    while (Date.now() < deadline) {
        const statusResponse = await fetch(submit.status_url, {
            headers: { Authorization: `Key ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
        });

        if (!statusResponse.ok) {
            const text = await statusResponse.text().catch(() => "");

            throw new GatewayError("PROVIDER_ERROR", `FAL status poll failed (${statusResponse.status}): ${text.slice(0, 200)}`, {
                statusCode: statusResponse.status,
            });
        }

        const status = (await statusResponse.json()) as { status?: string };

        if (status.status === "COMPLETED") {
            const resultResponse = await fetch(submit.response_url, {
                headers: { Authorization: `Key ${apiKey}` },
                signal: AbortSignal.timeout(30_000),
            });

            if (!resultResponse.ok) {
                const text = await resultResponse.text().catch(() => "");

                throw new GatewayError("PROVIDER_ERROR", `FAL response fetch failed (${resultResponse.status}): ${text.slice(0, 200)}`, {
                    statusCode: resultResponse.status,
                });
            }

            const result = (await resultResponse.json()) as FalAudioResponse;
            const audio = extractAudioPart(result);

            if (!audio) {
                throw new GatewayError("PROVIDER_ERROR", "FAL music render returned no audio URL (expected audio.url or audio_file.url)");
            }

            const bytesResponse = await fetch(audio.url, { signal: AbortSignal.timeout(60_000) });

            if (!bytesResponse.ok) {
                await bytesResponse.body?.cancel();

                throw new GatewayError("PROVIDER_ERROR", `FAL audio download failed (${bytesResponse.status})`, { statusCode: bytesResponse.status });
            }

            const buffer = await bytesResponse.arrayBuffer();

            return {
                bytes: new Uint8Array(buffer),
                mimeType: audio.contentType ?? bytesResponse.headers.get("content-type") ?? "audio/wav",
                sampleRate: audio.sampleRate,
            };
        }

        if (status.status === "FAILED" || status.status === "CANCELLED") {
            throw new GatewayError("PROVIDER_ERROR", `FAL music render ${status.status.toLowerCase()}`);
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, pollIntervalMs);
        });
    }

    throw new GatewayError("PROVIDER_UNAVAILABLE", `FAL music render exceeded ${maxPollMs}ms poll window`);
};

export interface AudioPart {
    contentType?: string;
    sampleRate?: number;
    url: string;
}

/**
 * Normalise FAL's two audio output shapes — `{ audio: { url, content_type,
 * sample_rate } }` (stable-audio-25, lyria2) and `{ audio_file: { url,
 * content_type } }` (musicgen, cassetteai, legacy stable-audio).
 */
/** The three output fields FAL music endpoints use for the rendered clip. */
export interface FalAudioResponse {
    audio?: unknown;
    audio_file?: unknown;
    audio_url?: unknown;
}

export const extractAudioPart = (result: FalAudioResponse): AudioPart | null => {
    const candidates = [result.audio, result.audio_file, result.audio_url];

    for (const candidate of candidates) {
        if (!candidate) continue;

        if (typeof candidate === "string") {
            return { url: candidate };
        }

        if (typeof candidate === "object") {
            const object = candidate as { content_type?: unknown; sample_rate?: unknown; url?: unknown };
            const url = typeof object.url === "string" ? object.url : undefined;

            if (!url) continue;

            return {
                contentType: typeof object.content_type === "string" ? object.content_type : undefined,
                sampleRate: typeof object.sample_rate === "number" ? object.sample_rate : undefined,
                url,
            };
        }
    }

    return null;
};
