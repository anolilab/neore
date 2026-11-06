/** The longest prompt text a title is generated from; the title needs its subject, not the whole message. */
const MAX_PROMPT_CHARS = 2000;

/**
 * The most code units read from a message before its text is cut. Four code units per character leaves room for a run of
 * whitespace before the text (which is trimmed) and for surrogate pairs; past it, nothing of the message can reach a title.
 */
const READ_LIMIT = MAX_PROMPT_CHARS * 4;

/** The first character that is not whitespace. */
const NON_SPACE = /\S/u;

interface ContextRow {
    _id?: string;
    message?: { content: unknown; role: string };
}

const isTextPart = (part: unknown): part is { text: string; type: "text" } =>
    typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string";

/** `out` followed by as much of `piece` as keeps the result within `limit` code units. */
const appendCapped = (out: string, piece: string, limit: number): string => out + piece.slice(0, Math.max(0, limit - out.length));

/**
 * The text of one message's content, read no further than `limit` code units: a plain string, or the text parts of a structured one
 * joined by a space. The parts are read in order and reading stops once the limit is reached, so a message with many or large parts
 * is not read to its end.
 */
const textOf = (content: unknown, limit: number): string => {
    if (typeof content === "string") {
        return content.slice(0, limit);
    }

    if (!Array.isArray(content)) {
        return "";
    }

    let out = "";
    let first = true;

    for (const part of content) {
        if (out.length >= limit) {
            break;
        }

        if (!isTextPart(part)) {
            continue;
        }

        if (!first) {
            out = appendCapped(out, " ", limit);
        }

        out = appendCapped(out, part.text, limit);
        first = false;
    }

    return out;
};

/**
 * The first `MAX_PROMPT_CHARS` characters of `text`, by code point, so a cut never splits a surrogate pair. It stops at the limit: a
 * long prompt (extracted document text, say) is not split into an array of every character first.
 */
export const capTitlePrompt = (text: string): string => {
    const kept: string[] = [];

    for (const character of text) {
        if (kept.length === MAX_PROMPT_CHARS) {
            break;
        }

        kept.push(character);
    }

    return kept.join("");
};

/**
 * The first user message on a context window that has any text: its text, trimmed and capped, and the id of the message it came
 * from. Returns `undefined` when the window holds no user text (a thread that only has tool output or nothing yet).
 */
export const firstUserPrompt = (rows: ReadonlyArray<ContextRow>): { id: string | undefined; text: string } | undefined => {
    for (const row of rows) {
        if (row.message?.role !== "user") {
            continue;
        }

        const read = textOf(row.message.content, READ_LIMIT);
        const start = read.search(NON_SPACE);

        if (start !== -1) {
            return { id: row._id, text: capTitlePrompt(read.slice(start).trimEnd()) };
        }
    }

    return undefined;
};

/** The text of {@link firstUserPrompt}, for a caller that does not need where it came from. */
export const firstUserPromptText = (rows: ReadonlyArray<ContextRow>): string | undefined => firstUserPrompt(rows)?.text;
