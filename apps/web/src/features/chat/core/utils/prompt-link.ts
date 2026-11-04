/**
 * A prompt link opens a new chat with a draft in the composer. It never sends: the person reads the draft and sends
 * it themselves.
 *
 * Link format: `/chat?prompt=<text>&model=<model id>`. The draft does not carry a project yet: a project is assigned
 * to a thread after it exists, so no new-chat setter takes one.
 */

/** The longest prompt a link may carry. A longer one is cut, never sent whole. */
export const PROMPT_LINK_MAX_CHARS = 8000;

/**
 * The one place link text is cleaned before it reaches the composer. The hidden-character filter (plan 1.1: tag
 * characters, bidi controls and other invisible text) is not on main yet, and it plugs in here.
 */
export const promptFromLink = (raw: string): string => raw.slice(0, PROMPT_LINK_MAX_CHARS).trim();

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
export const buildPromptLink = (origin: string, { model, prompt }: { model?: string; prompt: string }): string => {
    const params = new URLSearchParams({ prompt: promptFromLink(prompt) });

    if (model) {
        params.set("model", model);
    }

    return `${origin}/chat?${params.toString()}`;
};
