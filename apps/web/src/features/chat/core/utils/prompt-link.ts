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

/**
 * The longest query a copied link may carry once encoded. A letter outside ASCII takes up to twelve characters in a link, so a
 * prompt under the cap could still give an address too long for the server to accept.
 */
export const PROMPT_LINK_MAX_QUERY_CHARS = 8192;

/** Half of a character pair (text cut inside an emoji) as the replacement character: `encodeURIComponent` throws on it. */
const LONE_SURROGATE = /\p{Cs}/gu;

/** The query of a link to `prompt` on `model`. `encodeURIComponent`, not `URLSearchParams`, so the address carries `%20`, never `+`. */
const promptLinkQuery = (prompt: string, model: string | undefined): string =>
    `prompt=${encodeURIComponent(prompt.replaceAll(LONE_SURROGATE, "\u{FFFD}"))}${model ? `&model=${encodeURIComponent(model)}` : ""}`;

/** Whether a link to `raw` would carry less than all of it, or an address too long to open: such a copy is refused, never cut. */
export const isPromptLinkTooLong = (raw: string, model?: string): boolean => {
    const prompt = stripHiddenText(raw).text.trim();

    return [...prompt].length > PROMPT_LINK_MAX_CHARS || promptLinkQuery(prompt, model).length > PROMPT_LINK_MAX_QUERY_CHARS;
};

/** A link on `origin` that `readPromptLinkSearch` reads back as `promptFromLink(prompt)` and `model`. */
export const buildPromptLink = (origin: string, { model, prompt }: { model?: string; prompt: string }): string =>
    `${origin}/chat?${promptLinkQuery(promptFromLink(prompt), model?.trim())}`;
