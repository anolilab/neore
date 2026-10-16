import type { JSONValue } from "@ai-sdk/provider";

/**
 * Asks for PNG where a provider's image API takes an output format.
 *
 * The image marker (`markAiGeneratedImage`) can only write into PNG and JPEG, so a
 * WebP result would leave the file unmarked. Providers choose their own default,
 * so asking for PNG keeps the output markable.
 *
 * Keys are the AI SDK's own `providerOptions` names, checked against the installed
 * SDKs: `@ai-sdk/fal` reads `fal` (`outputFormat` maps to `output_format`),
 * `@ai-sdk/black-forest-labs` reads `blackForestLabs`, and `@ai-sdk/openai` reads
 * `openai`. OpenAI only takes the format on the `gpt-image` family, so the
 * DALL·E models are left alone.
 */
const SDK_OPTIONS_KEY: Record<string, string> = { bfl: "blackForestLabs", fal: "fal", openai: "openai" };

export const withPngOutput = (
    providerOptions: Record<string, Record<string, JSONValue>>,
    provider: string,
    modelApiId: string,
): Record<string, Record<string, JSONValue>> => {
    const key = SDK_OPTIONS_KEY[provider];

    if (!key || (provider === "openai" && !modelApiId.startsWith("gpt-image"))) {
        return providerOptions;
    }

    return { ...providerOptions, [key]: { ...providerOptions[key], outputFormat: "png" } };
};
