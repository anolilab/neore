/**
 * Text the person ATTACHED to a message rather than typed: a document's extracted text and a browser page the
 * extension captured. `/chat/start` and the edit path put both into the user message as plain text parts, so
 * nothing else marks them as content the person did not write — the quick check for low-risk tool calls
 * (`low-risk-approval.ts`) reads this to refuse a run that carries any.
 *
 * Recognised by the label each shape opens with (so history saved before this existed is covered) and, for a page,
 * by its structural marker. A person typing a label by hand is refused too, which only ever asks them.
 */
import { guestNoteIdOf, isGuestTextPart } from "../../lib/guest-text";
import { PAGE_CONTEXT_LABEL } from "./page-context";

const ATTACHED_DOCUMENT_LABEL = "[Attached Document]";
const DOCUMENT_LABEL_PREFIX = "[Document:";

/** The text part that carries one attached document's extracted text into the user message. */
export const documentTextPart = (filename: string | undefined, extractedText: string): { text: string; type: "text" } => {
    const label = filename ? `${DOCUMENT_LABEL_PREFIX} ${filename}]` : ATTACHED_DOCUMENT_LABEL;

    return { text: `${label}\n\n${extractedText}`, type: "text" };
};

/** Whether one line opens with an attachment's label. */
export const isAttachedLine = (line: string): boolean => {
    const trimmed = line.trimStart();

    return trimmed.startsWith(DOCUMENT_LABEL_PREFIX) || trimmed.startsWith(ATTACHED_DOCUMENT_LABEL) || trimmed.startsWith(PAGE_CONTEXT_LABEL);
};

/** A label at the start of any line: an attachment can follow typed text in the same string (messenger). */
export const isAttachedContentText = (text: string): boolean => text.split("\n").some((line) => isAttachedLine(line));

interface MessageLike {
    content?: unknown;
    role?: unknown;
}

/** A guest's note the owner sent on, marked as not the owner's words (`lib/guest-text.ts`); the mark only ever restricts. */
export const guestTextPart = (
    text: string,
    noteId: string | true,
): { providerOptions: { neore: { guestText: string | true } }; text: string; type: "text" } => {
    return { providerOptions: { neore: { guestText: noteId } }, text, type: "text" };
};

/** The note id a stored user message's guest text carries, so an edit of it keeps the mark; `undefined` for the owner's own. */
export const guestNoteIdOfMessage = (message: MessageLike | undefined): string | true | undefined => {
    if (message?.role !== "user" || !Array.isArray(message.content)) {
        return undefined;
    }

    const parts = message.content as ReadonlyArray<{ providerOptions?: unknown }>;

    // A mark without an id (`true`) is kept as it is.
    return parts.map((part) => guestNoteIdOf(part)).find((id) => id !== undefined) ?? (parts.some((part) => isGuestTextPart(part)) ? true : undefined);
};

/** Whether a stored user message carries guest text the owner sent on (memory never mines it). */
export const messageCarriesGuestText = (message: MessageLike | undefined): boolean => {
    if (message?.role !== "user" || !Array.isArray(message.content)) {
        return false;
    }

    return (message.content as ReadonlyArray<{ providerOptions?: unknown }>).some((part) => isGuestTextPart(part));
};

const hasPageMarker = (part: { providerOptions?: unknown }): boolean => {
    const options = part.providerOptions as { neore?: { pageContext?: unknown } } | undefined;

    return Boolean(options?.neore?.pageContext);
};

type ContentPart = { providerOptions?: unknown; text?: unknown; type?: unknown };

/** Whether a part is attached document or page text rather than something the person typed. */
const isAttachedPart = (part: ContentPart): boolean =>
    hasPageMarker(part) || (part.type === "text" && typeof part.text === "string" && isAttachedContentText(part.text));

/** Whether any user message carries attached document or page text. */
export const messagesCarryAttachedText = (messages: ReadonlyArray<MessageLike>): boolean =>
    messages.some((message) => {
        if (message.role !== "user") {
            return false;
        }

        if (typeof message.content === "string") {
            return isAttachedContentText(message.content);
        }

        if (!Array.isArray(message.content)) {
            return false;
        }

        return (message.content as ReadonlyArray<ContentPart>).some((part) => isAttachedPart(part));
    });

/** A Markdown blockquote line: the composer's quote action puts text from an assistant reply in this form. A space after the
 * marker is optional in Markdown, so `>I prefer trains` is quoted too. */
const QUOTED_LINE_RE = /^ {0,3}>/u;

const BLANK_LINE_RE = /^\s*$/u;

/** Any line that opens like a quote, read loosely so a check that fails closed misses none: any leading space (a tab, a
 * no-break space), an escaped `\>` (how a pasted `&gt;` line comes through the composer) or a full-width `＞`. */
const LOOSE_QUOTED_LINE_RE = /^\s*\\?[>＞]/u;

/**
 * Whether the text holds a blockquote: a forward (`features/chat/forward`), the composer's quote of a reply and a rich
 * paste of a quote all reach the user row as `>` lines with no mark, so a quote is never read as the person's own words.
 * A plain-text paste carries no marker and is not seen here.
 */
export const carriesQuotedLines = (text: string): boolean => text.split("\n").some((line) => LOOSE_QUOTED_LINE_RE.test(line));

/**
 * Which lines are part of a blockquote: those with the marker, and the lines that run on from them without one (a quoted
 * paragraph's lazy continuation in Markdown) until a blank line ends it.
 */
const quotedLines = (lines: ReadonlyArray<string>): boolean[] => {
    let inQuote = false;

    return lines.map((line) => {
        if (QUOTED_LINE_RE.test(line)) {
            inQuote = true;
        } else if (BLANK_LINE_RE.test(line)) {
            inQuote = false;
        }

        return inQuote;
    });
};

const LEADING_NEWLINES_RE = /^\n+/u;

/** The text without its blockquote lines: quoted words came from elsewhere, not from the person's own typing. */
export const withoutQuotedLines = (text: string): string => {
    const lines = text.split("\n");
    const quoted = quotedLines(lines);

    return lines
        .filter((_, index) => !quoted[index])
        .join("\n")
        .replace(LEADING_NEWLINES_RE, "");
};

/**
 * A text part the app wrote for the person: the file-only question (`fileOnlyPromptPart`) or the image request
 * (`imagePromptPart`), known by their tags, not their wording.
 */
const isPlaceholderPart = (part: ContentPart): boolean => {
    const neore = (part as { providerOptions?: { neore?: { fileOnlyPrompt?: unknown; placeholder?: unknown } } }).providerOptions?.neore;

    return neore?.fileOnlyPrompt === true || neore?.placeholder === true;
};

/** The text with each blockquote line blanked to spaces of its length, so every other word keeps its offset. */
export const blankQuotedLines = (text: string): string => {
    const lines = text.split("\n");
    const quoted = quotedLines(lines);

    return lines.map((line, index) => (quoted[index] ? " ".repeat(line.length) : line)).join("\n");
};

/**
 * The lines messenger writes about a received attachment into the caption's part (`messenger/media.ts`): a voice
 * transcript's label, a voice message or file it could not read, a file it cannot show the model.
 */
const MESSENGER_ATTACHMENT_LINE_RE = /^\s*\[(?:Voice message[ :\]]|Attached file: |Attachment(?: "[^"\n]*")? not read: )/u;

/** The typed lines of one text: up to the first attachment label or messenger's attachment line, without quoted lines. */
const typedLinesOf = (text: string): string => {
    const lines = text.split("\n");
    const end = lines.findIndex((line) => isAttachedLine(line) || MESSENGER_ATTACHMENT_LINE_RE.test(line));

    return withoutQuotedLines(end === -1 ? text : lines.slice(0, end).join("\n")).trimEnd();
};

/**
 * What the person TYPED into a user message: its text without attached documents, a captured page, a guest's
 * note, an outside agent's text, the app's placeholders or a quoted block, each typed part kept as its own paragraph.
 * Typed words can come before an attachment in one text (messenger puts the caption and its attachment lines in one
 * part): they are kept, and the rest is dropped from the first label on.
 * A memory quotes only this (`memory/evidence.ts`), and the composer's prompt search indexes, lists and matches only this
 * (stored as `messages.typedText` by `agent/shared.ts#typedTextColumn`), so a sentence from an upload or a quote is never
 * shown as their words.
 */
export const typedTextOf = (message: MessageLike | undefined): string => {
    if (message?.role !== "user") {
        return "";
    }

    if (typeof message.content === "string") {
        return typedLinesOf(message.content);
    }

    if (!Array.isArray(message.content)) {
        return "";
    }

    return (message.content as ReadonlyArray<ContentPart>)
        .flatMap((part) => {
            const typed = isTypedPart(part) ? typedLinesOf(part.text) : "";

            return typed.trim() === "" ? [] : [typed];
        })
        .join("\n\n");
};

/**
 * Whether one stored part of a user message may hold the person's typing: a text part that is no captured page, no
 * guest's note, no outside agent's text and no placeholder the app wrote. {@link typedTextOf}, the one reader of typed words,
 * reads only these parts, and only up to an attachment label in them.
 */
const isTypedPart = (part: ContentPart): part is ContentPart & { text: string } =>
    part.type === "text" &&
    typeof part.text === "string" &&
    !hasPageMarker(part) &&
    !isGuestTextPart(part) &&
    !isOutsideAgentPart(part) &&
    !isPlaceholderPart(part);

/**
 * A text part an outside agent (the public API) sent: the person did not write it, so no quote may name it as their words.
 * Stored on the part itself (`providerOptions.neore.outsideAgent`), so the saved prompt carries the mark with no column.
 */
export const outsideAgentTextPart = (text: string): { providerOptions: { neore: { outsideAgent: true } }; text: string; type: "text" } => {
    return { providerOptions: { neore: { outsideAgent: true } }, text, type: "text" };
};

/** Whether one stored part is an outside agent's text (`outsideAgentTextPart`). */
const isOutsideAgentPart = (part: ContentPart): boolean => {
    const options = part.providerOptions as { neore?: { outsideAgent?: unknown } } | undefined;

    return options?.neore?.outsideAgent === true;
};

/** Whether a stored user message carries an outside agent's text (`outsideAgentTextPart`). */
export const messageCarriesOutsideAgentText = (message: MessageLike | undefined): boolean => {
    if (message?.role !== "user" || !Array.isArray(message.content)) {
        return false;
    }

    return (message.content as ReadonlyArray<ContentPart>).some((part) => isOutsideAgentPart(part));
};
