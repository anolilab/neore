/**
 * The suggested answers of an `askUser` call, as the model supplied them:
 * only non-blank strings, each once (a duplicate would render two identical
 * buttons with the same React key), trimmed, in the model's order.
 */
export const normalizeAskUserChoices = (choices: unknown): string[] => {
    if (!Array.isArray(choices)) {
        return [];
    }

    const seen = new Set<string>();

    for (const choice of choices) {
        if (typeof choice === "string" && choice.trim().length > 0) {
            seen.add(choice.trim());
        }
    }

    return [...seen];
};
