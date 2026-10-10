import type { AppEnv } from "../index.js";
import { markAiHealthy, markAiUnhealthy } from "./health-check.js";

export const NSFW_THRESHOLD = {
    combined: 0.7, // block if sexy+hentai+porn > 0.7
    porn: 0.5, // block if porn alone > 0.5
};

/** The five probability fields {@link CLASSIFY_PROMPT} asks the model to return. */
interface RawScores {
    drawing?: unknown;
    hentai?: unknown;
    neutral?: unknown;
    porn?: unknown;
    sexy?: unknown;
}

export interface NsfwScores {
    drawing: number;
    hentai: number;
    isNsfw: boolean;
    neutral: number;
    porn: number;
    sexy: number;
    topCategory: "drawing" | "hentai" | "neutral" | "porn" | "sexy";
}

const CLASSIFY_PROMPT = `You are an image content classifier. Analyze the image and return a JSON object with five probability scores that sum to 1.0.

Categories:
- neutral: safe-for-work content (people, landscapes, objects, text, etc.)
- drawing: cartoons, anime, illustrations, digital art (safe or mildly stylized)
- sexy: suggestive or mildly explicit content (partial nudity, provocative poses)
- hentai: explicit animated/drawn sexual content
- porn: explicit photographic sexual content

Return ONLY a valid JSON object in this exact format with no other text:
{"neutral":0.0,"drawing":0.0,"sexy":0.0,"hentai":0.0,"porn":0.0}`;

/**
 * Classify an image for NSFW content using Workers AI (LLaVA vision model).
 * Throws on model or parse failure — callers should treat this as a "failed" status.
 */
export const classifyImage = async (env: AppEnv, imageBytes: Uint8Array): Promise<NsfwScores> => {
    let response: unknown;

    try {
        response = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
            image: [...imageBytes],
            max_tokens: 300,
            prompt: CLASSIFY_PROMPT,
        });
        markAiHealthy();
    } catch (error) {
        markAiUnhealthy(String(error));
        throw new Error(`Workers AI inference failed: ${String(error)}`, { cause: error });
    }

    const text =
        typeof response === "object" && response !== null && "description" in response ? String((response as { description: unknown }).description) : "";

    // Try direct parse first (model may return pure JSON), then scan for embedded JSON object.
    // Uses matchAll with a non-nested pattern; the expected payload has no nested braces.
    let parsed: RawScores | null = null;
    const trimmed = text.trim();

    if (trimmed.startsWith("{")) {
        try {
            parsed = JSON.parse(trimmed) as RawScores;
        } catch {
            // fall through to extraction below
        }
    }

    if (!parsed) {
        const matches = text.matchAll(/\{[^{}]*\}/g).toArray();
        const lastMatch = matches.at(-1);

        if (!lastMatch) {
            throw new Error(`NSFW model returned unparseable response: ${text.slice(0, 200)}`);
        }

        try {
            parsed = JSON.parse(lastMatch[0]) as RawScores;
        } catch (error) {
            throw new Error(`NSFW model returned invalid JSON: ${String(error)}`, { cause: error });
        }
    }

    const rawNeutral = typeof parsed["neutral"] === "number" ? parsed["neutral"] : 0;
    const rawDrawing = typeof parsed["drawing"] === "number" ? parsed["drawing"] : 0;
    const rawSexy = typeof parsed["sexy"] === "number" ? parsed["sexy"] : 0;
    const rawHentai = typeof parsed["hentai"] === "number" ? parsed["hentai"] : 0;
    const rawPorn = typeof parsed["porn"] === "number" ? parsed["porn"] : 0;

    // Normalize so scores sum to 1.0 (model may return un-normalized values)
    const sum = rawNeutral + rawDrawing + rawSexy + rawHentai + rawPorn;
    const factor = sum > 0 ? 1 / sum : 1;
    const neutral = rawNeutral * factor;
    const drawing = rawDrawing * factor;
    const sexy = rawSexy * factor;
    const hentai = rawHentai * factor;
    const porn = rawPorn * factor;

    const combined = sexy + hentai + porn;
    const isNsfw = porn > NSFW_THRESHOLD.porn || combined > NSFW_THRESHOLD.combined;

    // Deterministic topCategory: highest score wins; ties broken alphabetically (categories sorted below)
    const categories: { key: NsfwScores["topCategory"]; value: number }[] = [
        { key: "drawing", value: drawing },
        { key: "hentai", value: hentai },
        { key: "neutral", value: neutral },
        { key: "porn", value: porn },
        { key: "sexy", value: sexy },
    ];
    let top = { key: "drawing" as NsfwScores["topCategory"], value: drawing };

    for (const category of categories) {
        if (category.value > top.value) {
            top = category;
        }
    }

    const { key: topCategory } = top;

    return { drawing, hentai, isNsfw, neutral, porn, sexy, topCategory };
};
