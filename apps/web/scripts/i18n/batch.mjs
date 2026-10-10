// Pure pieces of the translation run: which entries need work, how they are
// batched and prompted, and how a model reply is checked. No I/O here, so all
// of it is unit-tested without a network.

import { parseMessage, validateTranslation } from "./icu.mjs";

/** Target-language names and register, as the prompt states them. */
export const LOCALES = {
    de: { name: "German", register: 'Address the user informally ("du"), matching the existing catalog.' },
    es: { name: "Spanish", register: 'Address the user informally ("tú"). Use neutral international Spanish.' },
    fr: { name: "French", register: 'Address the user formally ("vous").' },
    it: { name: "Italian", register: 'Address the user informally ("tu").' },
    ja: { name: "Japanese", register: "Use polite desu/masu form, as is standard for app UI." },
    pl: { name: "Polish", register: "Use a neutral, friendly register, as is standard for Polish app UI." },
    pt: { name: "Portuguese (Brazil)", register: 'Address the user as "você".' },
    zh: { name: "Simplified Chinese", register: "Use concise, neutral Simplified Chinese as is standard for app UI." },
};

/** Never translated. Model and provider names are covered by the prompt's general rule. */
export const PRODUCT_NAMES = ["Neore", "Neore Chat", "Pro", "MCP", "API", "BYOK"];

/**
 * @typedef {object} PendingItem
 * @property {string} key catalog entry key
 * @property {string} source English text to translate
 * @property {object} context what the model sees besides the text
 */

/**
 * Picks the entries of `target` that need translating.
 *
 * @param {import("./po.mjs").PoEntry[]} target entries of the target catalog
 * @param {Map<string, string>} sourceText entry key → English text (the `en` catalog's msgstr)
 * @param {{ force?: boolean, limit?: number }} [options]
 * @returns {{ pending: PendingItem[], skipped: { key: string, reason: string }[] }}
 */
export const collectPending = (target, sourceText, { force = false, limit = Number.POSITIVE_INFINITY } = {}) => {
    const pending = [];
    const skipped = [];

    for (const entry of target) {
        if (pending.length >= limit) {
            break;
        }

        if (entry.plural || (!force && entry.msgstr.trim() !== "")) {
            continue;
        }

        const source = sourceText.get(entry.key) || entry.msgid;

        try {
            parseMessage(source);
        } catch (error) {
            // Without a parseable source there is nothing to validate against.
            skipped.push({ key: entry.key, reason: `source is not valid ICU: ${error.message}` });
            continue;
        }

        pending.push({
            context: {
                ...(entry.msgctxt === undefined ? {} : { msgctxt: entry.msgctxt }),
                ...(entry.extracted.length > 0 ? { notes: entry.extracted } : {}),
                ...(entry.references.length > 0 ? { files: entry.references.map((reference) => reference.replace(/:\d+$/u, "")) } : {}),
            },
            key: entry.key,
            source,
        });
    }

    return { pending, skipped };
};

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
export const chunk = (items, size) => {
    if (!Number.isInteger(size) || size < 1) {
        throw new RangeError(`batch size must be a positive integer, got ${size}`);
    }

    const batches = [];

    for (let index = 0; index < items.length; index += size) {
        batches.push(items.slice(index, index + size));
    }

    return batches;
};

/**
 * Up to `count` existing translations, shortest first, as a style reference.
 *
 * @param {import("./po.mjs").PoEntry[]} target
 * @param {Map<string, string>} sourceText
 * @param {number} [count]
 */
export const styleExamples = (target, sourceText, count = 12) =>
    target
        .filter((entry) => !entry.plural && entry.msgstr.trim() !== "")
        .map((entry) => ({ source: sourceText.get(entry.key) || entry.msgid, translation: entry.msgstr }))
        .filter(({ source }) => source.length >= 12)
        .toSorted((a, b) => a.source.length - b.source.length || a.source.localeCompare(b.source))
        .slice(0, count);

export const buildSystemPrompt = (locale, examples = []) => {
    const language = LOCALES[locale]?.name ?? locale;
    const register = LOCALES[locale]?.register ?? "";

    return [
        `You translate the user interface of "Neore", an AI chat web app, from English into ${language} (locale "${locale}").`,
        register,
        "",
        "Every message is ICU MessageFormat as compiled by Lingui. Rules — a reply that breaks one is rejected:",
        "- Keep every placeholder exactly as written: `{0}`, `{userName}`. Never translate, rename, add or drop one. Reorder them freely to fit the grammar.",
        "- Keep every numbered tag exactly: `<0>…</0>`, `<1/>`. Translate the text between tags, keep tags balanced.",
        "- In `{n, plural, …}` / `{n, selectordinal, …}` keep the argument name and keyword; translate only the text inside each case. Use the CLDR plural categories this language needs (e.g. Polish one/few/many/other, Japanese and Chinese other only); `other` is always required. Keep `#` where the count belongs.",
        "- In `{x, select, …}` keep every case key unchanged; translate only the case text.",
        "- An apostrophe immediately before `{`, `}` or `#` escapes it in ICU. Never write `'` directly before a placeholder: use the typographic apostrophe ’ instead (e.g. French l’{0}).",
        `- Do not translate product, brand, model or provider names (${PRODUCT_NAMES.join(", ")}, OpenAI, Anthropic, Claude, GPT, Gemini, etc.) or code, URLs, file extensions and keyboard keys.`,
        "- Preserve leading/trailing whitespace, punctuation style and ellipses (… or ...) of the source.",
        "- Keep UI strings concise; button and menu labels stay short.",
        "",
        "Each item has an `id`, the English `text`, and optional `context`: `notes` (what each placeholder holds), `files` (where the string is used) and `msgctxt`. Use context to pick the right meaning; never translate it.",
        'Reply with a single JSON object and nothing else: {"translations": {"<id>": "<translated text>", …}} with one entry for every id.',
        ...(examples.length > 0
            ? [
                  "",
                  `Existing ${language} translations in this app, for terminology and tone:`,
                  ...examples.map(({ source, translation }) => `- ${JSON.stringify(source)} → ${JSON.stringify(translation)}`),
              ]
            : []),
    ].join("\n");
};

/**
 * Builds the chat messages for one batch. Batch-local ids ("1", "2", …) key the
 * reply rather than the message ids themselves — long English sentences with
 * quotes and braces are exactly what a model mangles when echoing a JSON key.
 *
 * @param {string} locale
 * @param {PendingItem[]} batch
 * @param {{ examples?: object[], feedback?: Map<string, { translation: unknown, problems: string[] }> }} [options]
 *   feedback: previous rejected attempts, by entry key, for the retry pass.
 */
export const buildMessages = (locale, batch, { examples = [], feedback } = {}) => {
    const items = batch.map((item, index) => {
        const previous = feedback?.get(item.key);

        return {
            id: String(index + 1),
            text: item.source,
            ...(Object.keys(item.context).length > 0 ? { context: item.context } : {}),
            ...(previous ? { rejectedAttempt: previous.translation, problems: previous.problems } : {}),
        };
    });

    const instruction = feedback
        ? "Your previous translations of these items were rejected for the listed problems. Translate them again, fixing every problem."
        : "Translate these items.";

    return [
        { content: buildSystemPrompt(locale, examples), role: "system" },
        { content: `${instruction}\n\n${JSON.stringify({ items }, undefined, 2)}`, role: "user" },
    ];
};

/**
 * Extracts `{ translations: { id: text } }` from a model reply, tolerating
 * code fences and prose around the JSON object.
 *
 * @param {string} content
 * @returns {Record<string, unknown>}
 */
export const parseModelReply = (content) => {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");

    if (start === -1 || end < start) {
        throw new SyntaxError("reply contains no JSON object");
    }

    const parsed = JSON.parse(content.slice(start, end + 1));
    const translations = parsed?.translations ?? parsed;

    if (translations === null || typeof translations !== "object" || Array.isArray(translations)) {
        throw new SyntaxError('reply has no "translations" object');
    }

    return translations;
};

/**
 * Validates every item of a batch against the model's reply.
 *
 * @param {PendingItem[]} batch
 * @param {Record<string, unknown>} translations reply keyed by batch-local id
 * @returns {{ accepted: Map<string, string>, rejected: Map<string, { translation: unknown, problems: string[] }> }}
 */
export const checkBatch = (batch, translations) => {
    const accepted = new Map();
    const rejected = new Map();

    for (const [index, item] of batch.entries()) {
        const translation = translations[String(index + 1)];
        const problems = typeof translation === "string" ? validateTranslation(item.source, translation) : ["no translation returned"];

        if (problems.length === 0) {
            accepted.set(item.key, translation);
        } else {
            rejected.set(item.key, { problems, translation: translation ?? null });
        }
    }

    return { accepted, rejected };
};
