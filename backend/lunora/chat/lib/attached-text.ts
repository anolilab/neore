/**
 * Text the person ATTACHED to a message rather than typed: a document's extracted text and a browser page the
 * extension captured. `/chat/start` and the edit path put both into the user message as plain text parts, so
 * nothing else marks them as content the person did not write — the quick check for low-risk tool calls
 * (`low-risk-approval.ts`) reads this to refuse a run that carries any.
 *
 * Recognised by the label each shape opens with (so history saved before this existed is covered) and, for a page,
 * by its structural marker. A person typing a label by hand is refused too, which only ever asks them.
 */
import { PAGE_CONTEXT_LABEL } from "./page-context";

const ATTACHED_DOCUMENT_LABEL = "[Attached Document]";
const DOCUMENT_LABEL_PREFIX = "[Document:";

/** The text part that carries one attached document's extracted text into the user message. */
export const documentTextPart = (filename: string | undefined, extractedText: string): { text: string; type: "text" } => {
    const label = filename ? `${DOCUMENT_LABEL_PREFIX} ${filename}]` : ATTACHED_DOCUMENT_LABEL;

    return { text: `${label}\n\n${extractedText}`, type: "text" };
};

/** A label at the start of any line: an attachment can follow typed text in the same string (messenger). */
export const isAttachedContentText = (text: string): boolean =>
    text.split("\n").some((line) => {
        const trimmed = line.trimStart();

        return trimmed.startsWith(DOCUMENT_LABEL_PREFIX) || trimmed.startsWith(ATTACHED_DOCUMENT_LABEL) || trimmed.startsWith(PAGE_CONTEXT_LABEL);
    });

interface MessageLike {
    content?: unknown;
    role?: unknown;
}

/**
 * The text part a guest's message becomes when the owner sends it on (`/chat/start` with `guestMessageId`). The
 * owner's client sends the text as an ordinary prompt, so only this server-set mark tells the quick check that the
 * owner did not write it. The mark only ever restricts: a client that sets it on its own text gets a prompt, nothing more.
 */
export const guestTextPart = (text: string): { providerOptions: { neore: { guestText: true } }; text: string; type: "text" } => {
    return { providerOptions: { neore: { guestText: true } }, text, type: "text" };
};

/** Whether a stored user message carries guest text the owner sent on, so an edit of it keeps the mark. */
export const messageCarriesGuestText = (message: MessageLike | undefined): boolean => {
    if (message?.role !== "user" || !Array.isArray(message.content)) {
        return false;
    }

    return (message.content as ReadonlyArray<{ providerOptions?: unknown }>).some(
        (part) => (part.providerOptions as { neore?: { guestText?: unknown } } | undefined)?.neore?.guestText === true,
    );
};

/** A structural mark the server put on the part: a captured page, or guest text the owner sent on. */
const hasStructuralMarker = (part: { providerOptions?: unknown }): boolean => {
    const options = part.providerOptions as { neore?: { guestText?: unknown; pageContext?: unknown } } | undefined;

    return Boolean(options?.neore?.pageContext) || options?.neore?.guestText === true;
};

/** Whether any user message carries attached document, captured page or guest text, which the person did not type. */
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
            (part) => hasStructuralMarker(part) || (part.type === "text" && typeof part.text === "string" && isAttachedContentText(part.text)),
        );
    });
