export type QuickAction = "explain" | "summarize" | "translate" | "summarize-page";

export const QUICK_ACTION_LABELS: Record<QuickAction, string> = {
    explain: "Explain",
    summarize: "Summarize",
    "summarize-page": "Summarize this page",
    translate: "Translate",
};

/**
 * The typed prompt for a quick action. It names the attached context rather
 * than quoting it: the selection travels separately as `pageContext`, where the
 * backend wraps it as untrusted data — pasting it in here would put page text
 * back into the instruction channel.
 */
export const quickPrompt = (action: QuickAction, targetLanguage: string): string => {
    switch (action) {
        case "explain": {
            return "Explain the selected text from the attached page in clear, simple terms.";
        }
        case "summarize": {
            return "Summarize the selected text from the attached page in a few short bullet points.";
        }
        case "summarize-page": {
            return "Summarize the attached page: the main points first, then anything notable.";
        }
        case "translate": {
            return `Translate the selected text from the attached page into ${targetLanguage}. Reply with the translation only.`;
        }
        default: {
            // Unreachable while the switch covers every `QuickAction`; the `never`
            // makes a new action a compile error here.
            const unhandled: never = action;

            throw new Error(`Unknown quick action: ${String(unhandled)}`);
        }
    }
};

/** English name of a BCP 47 language tag, falling back to the tag itself. */
export const languageName = (tag: string): string => {
    try {
        return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
    } catch {
        return tag;
    }
};
