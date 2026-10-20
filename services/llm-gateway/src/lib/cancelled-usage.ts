/**
 * Token estimate for a stream the client cancelled before the provider sent its
 * usage ("Stop generating"). The provider already billed us for the prompt and
 * every token it streamed, so recording zeros would make a stopped reply free.
 *
 * This is a LOWER-bound estimate, used ONLY when no `finish` usage arrived — never
 * when real usage exists. It uses the same chars/4 heuristic as `token-estimator.ts`
 * and counts text only: tool calls, tool results and files in the prompt are left
 * out, so the estimate stays below what the provider charged.
 */

const toTokens = (chars: number): number => Math.ceil(chars / 4);

/** Characters of text in a prompt: string contents and the `text` of each part. */
export const countPromptTextChars = (messages: { content: unknown }[], system?: string): number => {
    let total = system?.length ?? 0;

    for (const { content } of messages) {
        if (typeof content === "string") {
            total += content.length;
        } else if (Array.isArray(content)) {
            for (const part of content as ({ text?: unknown } | null)[]) {
                if (typeof part?.text === "string") {
                    total += part.text.length;
                }
            }
        }
    }

    return total;
};

export const estimateCancelledUsage = ({
    emittedChars,
    promptChars,
    reasoningChars,
}: {
    emittedChars: number;
    promptChars: number;
    reasoningChars: number;
}): { cachedTokens: 0; completionTokens: number; promptTokens: number; reasoningTokens: number } => {
    return {
        cachedTokens: 0,
        completionTokens: toTokens(emittedChars),
        promptTokens: toTokens(promptChars),
        reasoningTokens: toTokens(reasoningChars),
    };
};
