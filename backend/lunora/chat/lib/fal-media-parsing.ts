/**
 * Pure response-shape parsers for FAL media endpoints.
 *
 * FAL is inconsistent about how it returns generated asset URLs across
 * endpoints. These helpers normalise the variants so the action handlers in
 * `functions.ts` stay free of shape-guessing logic — and so the brittle bits
 * are unit-testable without a live FAL call.
 */

/**
 * The keys `extractFalAudioUrl` looks at. The leaves stay `unknown` on purpose:
 * FAL's payloads are untrusted, and the runtime `typeof` guards below are what
 * establishes the shape.
 */
export interface FalAudioResponse {
    audio?: unknown;
    audio_file?: unknown;
    audio_url?: unknown;
}

export interface FalAudioResult {
    contentType?: string;
    sampleRate?: number;
    url: string;
}

/**
 * Normalise FAL's audio output shapes (mirrors `extractAudioPart` in the
 * gateway's music-factory.ts so both surfaces accept the same variants):
 *   - `{ audio: { url, content_type, sample_rate } }`  (stable-audio-25, lyria2)
 *   - `{ audio_file: { url, content_type } }`          (musicgen, cassetteai)
 *   - `{ audio_url: "..." }` / string-form candidate   (defensive fallback)
 *
 * Returns null when no usable URL is present so the caller can throw a single
 * descriptive error rather than reading `undefined.url`.
 */
export const extractFalAudioUrl = (result: FalAudioResponse): FalAudioResult | null => {
    const candidates = [result.audio, result.audio_file, result.audio_url];

    for (const candidate of candidates) {
        if (!candidate) continue;

        if (typeof candidate === "string") {
            return { url: candidate };
        }

        if (typeof candidate !== "object") continue;

        const object = candidate as { content_type?: unknown; sample_rate?: unknown; url?: unknown };
        const url = typeof object.url === "string" ? object.url : undefined;

        if (!url) continue;

        return {
            contentType: typeof object.content_type === "string" ? object.content_type : undefined,
            sampleRate: typeof object.sample_rate === "number" ? object.sample_rate : undefined,
            url,
        };
    }

    return null;
};

export interface FalVideoResponse {
    output?: string | { content_type?: string; url: string };
    video?: { content_type?: string; url: string };
    videos?: { content_type?: string; url: string }[];
}

export interface FalVideoResult {
    contentType: string;
    url: string;
}

/**
 * Resolve the video URL + content type from FAL's three known video shapes,
 * in priority order: `video` → `videos[0]` → `output` (string or object).
 *
 * Content-type resolution intentionally only consults `video` / `videos[0]`
 * before falling back to `video/mp4` — the same precedence the inline code
 * used before extraction, so behaviour is unchanged. Returns null when no URL
 * is present.
 */
export const resolveFalVideoUrl = (result: FalVideoResponse): FalVideoResult | null => {
    const url = result.video?.url ?? result.videos?.[0]?.url ?? (typeof result.output === "string" ? result.output : result.output?.url);

    if (!url) {
        return null;
    }

    return {
        contentType: result.video?.content_type ?? result.videos?.[0]?.content_type ?? "video/mp4",
        url,
    };
};
