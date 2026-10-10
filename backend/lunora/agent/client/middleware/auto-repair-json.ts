import type { LanguageModelV4Content } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";
import { jsonrepair } from "jsonrepair";

/**
 * The outermost `{…}` or `[…]` span in a string, or `undefined`.
 *
 * This was two regexes — `/^[^[]*(\{.*\})/s` and `/^[^{]*(\[.*\])/s`. Both pair
 * an unbounded prefix with an unbounded `.*` under the `s` flag, which is a
 * backtracking hazard on exactly the input this sees: raw model output, arbitrary
 * length, frequently containing braces that never balance.
 *
 * Index arithmetic does the same job in one linear pass and cannot backtrack.
 */
const outermostSpan = (text: string, open: string, close: string): string | undefined => {
    const start = text.indexOf(open);

    if (start === -1) {
        return undefined;
    }

    const end = text.lastIndexOf(close);

    return end > start ? text.slice(start, end + 1) : undefined;
};

/**
 * Tries to fix invalid JSON by attempting various repair strategies.
 * @param text The text to repair as JSON
 * @returns The repaired JSON string, or null if repair failed
 */
export const safeRepairJson = (text: string): string | null => {
    // Check for already valid JSON
    try {
        JSON.parse(text);

        return text;
    } catch {
        /* fall through */
    }

    // Only use jsonrepair on the full text when it already looks like JSON
    if (text.startsWith("{") || text.startsWith("[")) {
        try {
            return jsonrepair(text);
        } catch {
            /* fall through */
        }
    }

    // Try extracting JSON between the outermost matching braces: {} or []
    const extracted = outermostSpan(text, "{", "}") ?? outermostSpan(text, "[", "]");

    if (extracted) {
        try {
            JSON.parse(extracted);

            return extracted;
        } catch {
            /* fall through */
        }

        // Try repairing the extracted JSON
        try {
            return jsonrepair(extracted);
        } catch {
            /* fall through */
        }
    }

    return null;
};

/**
 * Language model middleware that automatically repairs invalid JSON in responses.
 *
 * This middleware intercepts the response from the language model and attempts
 * to repair any malformed JSON in text content. This is useful when using
 * structured output with models that occasionally produce invalid JSON.
 * @example
 * ```ts
 * import { wrapLanguageModel, generateText, Output } from "ai";
 * import { autoRepairJsonMiddleware } from "./agent/client/middleware";
 * import { z } from "zod";
 *
 * const wrappedModel = wrapLanguageModel({
 *   model: yourModel,
 *   middleware: [autoRepairJsonMiddleware],
 * });
 *
 * const result = await generateText({
 *   model: wrappedModel,
 *   prompt: "Return a person object",
 *   output: Output.object({
 *     schema: z.object({
 *       name: z.string(),
 *       age: z.number(),
 *     }),
 *   }),
 * });
 * ```
 */
export const autoRepairJsonMiddleware: LanguageModelMiddleware = {
    // `"v4"`. ai@7's `LanguageModelMiddleware` types this loosely
    // (`specificationVersion?: string`), so `"v3"` compiled while naming a
    // contract the runtime no longer speaks — the real error surfaced on
    // `LanguageModelV3Content` a few lines down instead.
    specificationVersion: "v4",

    wrapGenerate: async ({ doGenerate }) => {
        const { content, ...rest } = await doGenerate();

        const transformedContent: LanguageModelV4Content[] = [];

        for (const part of content) {
            if (part.type !== "text") {
                transformedContent.push(part);
                continue;
            }

            const repaired = safeRepairJson(part.text);

            transformedContent.push({ ...part, text: repaired ?? part.text });
        }

        return { content: transformedContent, ...rest };
    },
};
