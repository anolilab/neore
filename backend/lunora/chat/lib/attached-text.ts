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

        return (message.content as ReadonlyArray<{ providerOptions?: unknown; text?: unknown; type?: unknown }>).some(
            (part) => hasPageMarker(part) || (part.type === "text" && typeof part.text === "string" && isAttachedContentText(part.text)),
        );
    });
