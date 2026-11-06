import { stripHiddenText } from "@neore/ai/utils";

/**
 * A prompt link opens a new chat with a draft in the composer. It never sends: the person reads the draft and sends
 * it themselves.
 *
 * Link format: `/chat?prompt=<text>&model=<model id>`. The draft does not carry a project yet: a project is assigned
 * to a thread after it exists, so no new-chat setter takes one.
 */

/** The longest prompt a link may carry, counted in code points (what a person counts as characters). A longer one is cut, never sent whole. */
export const PROMPT_LINK_MAX_CHARS = 8000;

/**
 * The longest query a link may carry once encoded. A letter outside ASCII takes several characters in a link, so the prompt
 * cap alone does not bound the link: a long non-Latin prompt under the cap could still be too long to open.
 */
export const PROMPT_LINK_MAX_QUERY_CHARS = 8192;

/** The text a link carries: hidden characters out (as the composer does), then trimmed. */
const cleanedPrompt = (raw: string): string => stripHiddenText(raw).text.trim();

/** The first `count` code points of `text`, so a cut never splits an emoji or any other surrogate pair. */
const firstCodePoints = (text: string, count: number): string => [...text].slice(0, count).join("");

/**
 * The one place link text is cleaned before it reaches the composer: hidden characters (tag characters, bidi controls and
 * other invisible text) come out first, as they do in the composer itself, then the text is trimmed and capped.
 */
export const promptFromLink = (raw: string): string => firstCodePoints(cleanedPrompt(raw), PROMPT_LINK_MAX_CHARS).trimEnd();

/** The query a link carries for `prompt` and `model`, encoded as the link carries it. */
const linkQuery = (prompt: string, model: string | undefined): string => {
    const params = new URLSearchParams({ prompt });

    if (model) {
        params.set("model", model);
    }

    return params.toString();
};

/**
 * Whether copying `raw` on `model` would carry less than all of it, or a link too long to open. Copying such a message is
 * refused rather than cut. The encoded query is measured, not the raw text, because that is what the link carries.
 */
export const isPromptLinkTooLong = (raw: string, model?: string): boolean => {
    const prompt = cleanedPrompt(raw);

    return [...prompt].length > PROMPT_LINK_MAX_CHARS || linkQuery(prompt, model).length > PROMPT_LINK_MAX_QUERY_CHARS;
};

/** The search values a prompt link carries, trimmed and capped; absent or blank values are dropped. */
export const readPromptLinkSearch = (search: { model?: unknown; prompt?: unknown }): { model?: string; prompt?: string } => {
    const prompt = typeof search.prompt === "string" ? promptFromLink(search.prompt) : "";
    const model = typeof search.model === "string" ? search.model.trim() : "";

    return {
        ...(prompt !== "" && { prompt }),
        ...(model !== "" && { model }),
    };
};

/** A link that opens `prompt` as a draft in a new chat, on `model` when one is given. */
export const buildPromptLink = (origin: string, { model, prompt }: { model?: string; prompt: string }): string =>
    `${origin}/chat?${linkQuery(promptFromLink(prompt), model)}`;
