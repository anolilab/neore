/**
 * Build the `providerOptions` bag for a reasoning-capable model.
 *
 * Three things were wrong with the two hand-rolled copies this replaces, and
 * together they meant a user's reasoning-effort choice never reached any
 * provider:
 *
 *  1. **The bag was flat** — `{ reasoningEffort }` — while the AI SDK and the
 *     gateway's `filterProviderOptions` both index it by provider name. That
 *     filter does `options[provider]`, so a flat bag resolved to `undefined`
 *     and the whole option was dropped before the request was built.
 *  2. **The keys were wrong per provider.** The gateway allowlists
 *     `reasoningEffort` for `openai`/`xai` and `reasoning` for `openrouter`;
 *     `anthropic` takes `thinking` and `google` takes `thinkingConfig`. The old
 *     code wrote `reasoningEffort` for anthropic and google, which the
 *     allowlist would have stripped even had the nesting been right.
 *  3. **The scales disagreed.** The composer's slider emits 0/25/50/75/100
 *     (five stops), while the mapping assumed 1–3: `effortMap[100]` missed and
 *     fell through to "medium", and google got `Math.min(effort, 3)` — so every
 *     value above 3 collapsed to the same request.
 *
 * The anthropic and google branches were effectively dead regardless: in
 * `MODEL_REGISTRY` reasoning models are served through `openrouter` (the large
 * majority), `xai` and `openai`, and the Anthropic and Google ones are reached
 * via* openrouter rather than as a primary provider. So this maps only the
 * providers that actually host reasoning models, and invents no token budgets
 * for the ones that would need them.
 */

/** The composer slider's five stops, collapsed onto the three levels every provider accepts. */
export type ReasoningLevel = "high" | "low" | "medium";

/**
 * Map the 0–100 slider onto a level.
 *
 * The slider's own labels are Low / Medium-Low / Medium / Medium-High / High,
 * so the two below the midpoint read as low and the two above as high.
 */
export const toReasoningLevel = (effort: number): ReasoningLevel => {
    if (effort < 40) {
        return "low";
    }

    if (effort < 70) {
        return "medium";
    }

    return "high";
};

/**
 * Returns a provider-keyed `providerOptions` bag, or `undefined` when there is
 * nothing to send — which is the signal to omit the parameter entirely rather
 * than pass an empty object.
 */
export const buildReasoningProviderOptions = (
    effort: number | undefined,
    provider: string,
    // `undefined` because both call sites derive this from an optional
    // `filterCapabilities?.includes(...)`; absent means unsupported.
    supportsReasoningEffort: boolean | undefined,
): Record<string, Record<string, unknown>> | undefined => {
    if (effort === undefined || !supportsReasoningEffort) {
        return undefined;
    }

    const level = toReasoningLevel(effort);

    switch (provider) {
        case "openai": {
            return { openai: { reasoningEffort: level } };
        }

        case "openrouter": {
            return { openrouter: { reasoning: { effort: level } } };
        }

        case "xai": {
            // xAI's `reasoning_effort` accepts only "low" and "high"; sending
            // "medium" is a 400, so the midpoint resolves upward.
            return { xai: { reasoningEffort: level === "low" ? "low" : "high" } };
        }

        default: {
            // Every other provider either has no reasoning-effort control or
            // needs a token budget we have no basis to invent. Sending an
            // unknown key risks a 400 that the health tracker would read as the
            // provider being unhealthy.
            return undefined;
        }
    }
};
