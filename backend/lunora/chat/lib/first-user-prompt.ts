import { isAttachedLine } from "./attached-text";

/** The longest prompt text a title is generated from; the title needs its subject, not the whole message. */
const MAX_PROMPT_CHARS = 2000;

/**
 * The most code units of a message's text that are read once its first non-whitespace character is found. Four code units per
 * character leaves room for surrogate pairs; past it, nothing of the message can reach a title. Whitespace before that character
 * does not count against it.
 */
const READ_LIMIT = MAX_PROMPT_CHARS * 4;

/** The first character that is not whitespace. */
const NON_SPACE = /\S/u;

export interface ContextRow {
    _id?: string;
    message?: { content: unknown; role: string };
}

/** One piece of a message's text: a text part, or a plain string. `whole` marks a part that is attached page context. */
interface Piece {
    text: string;
    whole: boolean;
}

const isTextPart = (part: unknown): part is { text: string; type: "text" } =>
    typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string";

/** Whether a text part is the placeholder sent for a file with no question ({@link fileOnlyPromptPart}), known by its tag, not its wording. */
const isFileOnlyPlaceholder = (part: unknown): boolean => {
    // A stored part may be anything, null included: only an object can carry the tag.
    if (typeof part !== "object" || part === null) {
        return false;
    }

    const options = (part as { providerOptions?: { neore?: { fileOnlyPrompt?: unknown } } }).providerOptions;

    return options?.neore?.fileOnlyPrompt === true;
};

/** A browser page the extension attached carries its structural marker; the marker is what says it is not typed. */
const hasPageMarker = (part: unknown): boolean => {
    const options = (part as { providerOptions?: { neore?: { pageContext?: unknown } } }).providerOptions;

    return Boolean(options?.neore?.pageContext);
};

/** The text pieces of a message in stored order, read lazily so a reader that stops early does not walk the rest. */
function* pieces(content: unknown): Generator<Piece> {
    if (typeof content === "string") {
        yield { text: content, whole: false };

        return;
    }

    if (!Array.isArray(content)) {
        return;
    }

    for (const part of content) {
        // The placeholder sent for a file with no question is neither typed nor attached text.
        if (isTextPart(part) && !isFileOnlyPlaceholder(part)) {
            yield { text: part.text, whole: hasPageMarker(part) };
        }
    }
}

/**
 * Splits text at its first line that opens with an attachment's label: what is typed before it, and what is attached from it on.
 * A document's part opens with its label, so all of it is attached; a question followed by an attachment in one string is split.
 */
const splitAttached = (text: string): { attached: string; typed: string } => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => isAttachedLine(line));

    if (at === -1) {
        return { attached: "", typed: text };
    }

    return { attached: lines.slice(at).join("\n"), typed: lines.slice(0, at).join("\n") };
};

/** What a piece contributes to the want: its typed text, or its attached text. Whitespace before its text is skipped without counting. */
const contribution = (piece: Piece, want: "attached" | "typed"): string => {
    const start = piece.text.search(NON_SPACE);

    if (start === -1) {
        return "";
    }

    const body = piece.text.slice(start, start + READ_LIMIT);

    if (piece.whole) {
        return want === "attached" ? body.trimEnd() : "";
    }

    const split = splitAttached(body);

    return (want === "typed" ? split.typed : split.attached).trimEnd();
};

/** `out` followed by as much of `piece` as keeps the result within `limit` code units. */
const appendCapped = (out: string, piece: string, limit: number): string => out + piece.slice(0, Math.max(0, limit - out.length));

/** The text of a message that is `want`: its typed pieces joined by a space, or its attached pieces, read to the limit. */
const textWanted = (content: unknown, want: "attached" | "typed"): string => {
    let out = "";

    for (const piece of pieces(content)) {
        if (out.length >= READ_LIMIT) {
            break;
        }

        const chunk = contribution(piece, want);

        if (chunk) {
            out = appendCapped(out ? appendCapped(out, " ", READ_LIMIT) : out, chunk, READ_LIMIT);
        }
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

/** The text a message carries when a file is sent with no question (`chat/http.ts`). */
export const FILE_ONLY_PROMPT = "Please analyze the uploaded file.";

/**
 * The text part a message carries when a file is sent with no question: {@link FILE_ONLY_PROMPT}, tagged so the title reader knows it
 * for the placeholder it is. A person who types the same words gets an untagged part, read as their question.
 */
export const fileOnlyPromptPart = (): { providerOptions: { neore: { fileOnlyPrompt: true } }; text: string; type: "text" } => {
    return { providerOptions: { neore: { fileOnlyPrompt: true } }, text: FILE_ONLY_PROMPT, type: "text" };
};

/** Whether a message's content holds the file-only placeholder. */
const hasFileOnlyPlaceholder = (content: unknown): boolean => Array.isArray(content) && content.some((part) => isFileOnlyPlaceholder(part));

/**
 * The first user message on a context window that has any text: its text, trimmed and capped, and the id of the message it came
 * from. The person's typed question is the title's subject; attached document or page text is used only when the message has no
 * question. Returns `undefined` when the window holds no user text (a thread that only has tool output, nothing yet, or whitespace).
 */
export const firstUserPrompt = (rows: ReadonlyArray<ContextRow>): { id: string | undefined; text: string } | undefined => {
    for (const row of rows) {
        if (row.message?.role !== "user") {
            continue;
        }

        // The placeholder sent for a file with no question is not a question: the attached text is the subject, and the placeholder is
        // used only when the message has nothing else.
        const text =
            textWanted(row.message.content, "typed") ||
            textWanted(row.message.content, "attached") ||
            (hasFileOnlyPlaceholder(row.message.content) ? FILE_ONLY_PROMPT : "");

        if (text) {
            return { id: row._id, text: capTitlePrompt(text) };
        }
    }

    return undefined;
};

/** The text of {@link firstUserPrompt}, for a caller that does not need where it came from. */
export const firstUserPromptText = (rows: ReadonlyArray<ContextRow>): string | undefined => firstUserPrompt(rows)?.text;
