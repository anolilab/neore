import { stripHiddenText } from "@neore/ai/utils";

/**
 * A prompt link, `/chat?prompt=<text>&model=<model id>`, opens a new chat with the text as a draft in the composer. It never
 * sends. This module reads the link's two parameters as the address writes them: the chat page passes the raw query, not the
 * router's parsed search. It stays free of the model registry (the model check is in `use-prompt-link-draft.ts`).
 */

/** The longest prompt a link may carry, in code points. A longer one is cut. */
export const PROMPT_LINK_MAX_CHARS = 8000;

/** Hidden characters out (as the composer does), trimmed, and capped without splitting a surrogate pair. */
export const promptFromLink = (raw: string): string => [...stripHiddenText(raw).text.trim()].slice(0, PROMPT_LINK_MAX_CHARS).join("").trimEnd();

/** The prompt and model a link carries. A link without a usable prompt carries nothing, its model included. */
export const readPromptLinkSearch = (search: { model?: string; prompt?: string }): { model?: string; prompt?: string } => {
    if (search.prompt === undefined) {
        return {};
    }

    const prompt = promptFromLink(search.prompt);

    // A link whose prompt is blank once cleaned carries nothing, not even its model; the empty prompt still says a link was
    // there, so its parameters are cleared from the address.
    if (prompt === "") {
        return { prompt: "" };
    }

    const model = search.model?.trim() ?? "";

    return model === "" ? { prompt } : { model, prompt };
};
