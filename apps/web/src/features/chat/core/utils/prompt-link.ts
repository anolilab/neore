import { stripHiddenText } from "@neore/ai/utils";

/**
 * A prompt link, `/chat?prompt=<text>&model=<model id>`, opens a new chat with the text as a draft in the composer. It never
 * sends. This module is the chat route's search parser, so it stays free of the model registry (the model check is in
 * `use-prompt-link-draft.ts`).
 */

/** The longest prompt a link may carry, in code points. A longer one is cut. */
export const PROMPT_LINK_MAX_CHARS = 8000;

/**
 * The router reads a query value that looks like JSON as that JSON, so a hand-written `?prompt=42` or `?prompt=true` arrives
 * as a number or a boolean. Those are read back as their text; anything else that is not a string is no prompt.
 */
const textOf = (value: unknown): string | undefined => {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    return undefined;
};

/** Hidden characters out (as the composer does), trimmed, and capped without splitting a surrogate pair. */
export const promptFromLink = (raw: string): string => [...stripHiddenText(raw).text.trim()].slice(0, PROMPT_LINK_MAX_CHARS).join("").trimEnd();

/** The prompt and model a link carries. A link without a usable prompt carries nothing, its model included. */
export const readPromptLinkSearch = (search: { model?: unknown; prompt?: unknown }): { model?: string; prompt?: string } => {
    const raw = textOf(search.prompt);
    const prompt = raw === undefined ? "" : promptFromLink(raw);

    if (prompt === "") {
        return {};
    }

    const model = typeof search.model === "string" ? search.model.trim() : "";

    return model === "" ? { prompt } : { model, prompt };
};
