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

/** A Markdown blockquote line: the composer's quote action puts text from an assistant reply in this form. */
const QUOTED_LINE_RE = /^ {0,3}>(?: |$)/u;

const LEADING_NEWLINES_RE = /^\n+/u;

/** The text without its blockquote lines: quoted words came from elsewhere, not from the person's own typing. */
export const withoutQuotedLines = (text: string): string =>
    text
        .split("\n")
        .filter((line) => !QUOTED_LINE_RE.test(line))
        .join("\n")
        .replace(LEADING_NEWLINES_RE, "");

/**
 * A text part the app wrote for the person: the file-only question (`fileOnlyPromptPart`) or the image request
 * (`imagePromptPart`), known by their tags, not their wording.
 */
const isPlaceholderPart = (part: ContentPart): boolean => {
    const neore = (part as { providerOptions?: { neore?: { fileOnlyPrompt?: unknown; placeholder?: unknown } } }).providerOptions?.neore;

    return neore?.fileOnlyPrompt === true || neore?.placeholder === true;
};

/** The text with each blockquote line blanked to spaces of its length, so every other word keeps its offset. */
export const blankQuotedLines = (text: string): string =>
    text
        .split("\n")
        .map((line) => (QUOTED_LINE_RE.test(line) ? " ".repeat(line.length) : line))
        .join("\n");

/**
 * What the person TYPED into a user message: its text without attached documents, a captured page, a guest's
 * note or a quoted block. A memory quotes only this (`memory/evidence.ts`), so a sentence from an upload or a
 * quote is never shown as their words.
 */
export const typedTextOf = (message: MessageLike | undefined): string => {
    if (message?.role !== "user") {
        return "";
    }

    if (typeof message.content === "string") {
        // Typed words can come before an attachment in one string (messenger): keep them, and drop the block from its label on.
        const lines = message.content.split("\n");
        const attached = lines.findIndex((line) => isAttachedLine(line));

        return withoutQuotedLines(attached === -1 ? message.content : lines.slice(0, attached).join("\n")).trimEnd();
    }

    if (!Array.isArray(message.content)) {
        return "";
    }

    return (message.content as ReadonlyArray<ContentPart>)
        .flatMap((part) =>
            part.type === "text" &&
            typeof part.text === "string" &&
            !isAttachedPart(part) &&
            !isGuestTextPart(part) &&
            !isOutsideAgentPart(part) &&
            !isPlaceholderPart(part)
                ? [withoutQuotedLines(part.text)]
                : [],
        )
        .join("\n\n");
};

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
