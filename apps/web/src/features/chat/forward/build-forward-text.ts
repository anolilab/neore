/**
 * The first message of a forwarded chat: the picked messages as markdown
 * quotes, each under its author ("You", or the assistant / agent name), after
 * an optional `/<skill>` command and a note.
 *
 * Built in the BROWSER from messages it already shows, with no server check,
 * deliberately: the result is text the user sends as their OWN message into
 * their OWN new chat, through the ordinary composer. Nothing is copied
 * server-side and no message id crosses the wire, so there is no id to forge —
 * the user could have pasted exactly this text by hand. The caps below keep one
 * forward to a sane prompt size, not an access boundary.
 */

/** The most characters of quoted content one forward carries. */
export const MAX_FORWARD_CHARS = 20_000;

export interface ForwardableMessage {
    /** Display name of the author: "You" for the user, the agent/assistant name otherwise. */
    author: string;
    text: string;
}

export interface ForwardTextOptions {
    maxChars?: number;
    note?: string;
    /** A skill slug; the text then starts `/<slug>` so the chat runs with that skill. */
    skillSlug?: string;
    /** Appended when the quotes were cut at {@link MAX_FORWARD_CHARS}. */
    truncatedNotice: string;
}

const LINE_BREAK_RE = /\r?\n/u;

/** `text` as a markdown blockquote, each line prefixed — blank lines too, so the quote does not end early. */
export const toBlockquote = (text: string): string =>
    text
        .split(LINE_BREAK_RE)
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");

/** Markdown that would otherwise start bold/emphasis inside the author label. */
const LABEL_SPECIAL_RE = /[*_`[\]\\]/gu;

const escapeLabel = (label: string): string => label.replaceAll(LABEL_SPECIAL_RE, (character) => `\\${character}`);

export const buildForwardText = (messages: ReadonlyArray<ForwardableMessage>, options: ForwardTextOptions): string => {
    const maxChars = options.maxChars ?? MAX_FORWARD_CHARS;
    const quotes: string[] = [];
    let used = 0;
    let truncated = false;

    for (const message of messages) {
        const body = message.text.trim();

        if (!body) {
            continue;
        }

        const room = maxChars - used;

        if (room <= 0) {
            truncated = true;
            break;
        }

        const kept = body.length > room ? `${body.slice(0, room).trimEnd()}…` : body;

        truncated ||= kept !== body;
        used += kept.length;
        quotes.push(`> **${escapeLabel(message.author)}:**\n${toBlockquote(kept)}`);
    }

    const head = [options.skillSlug ? `/${options.skillSlug}` : "", options.note?.trim() ?? ""].filter(Boolean).join(" ");
    const sections = [head, ...quotes, truncated ? `_${options.truncatedNotice}_` : ""].filter(Boolean);

    return sections.join("\n\n");
};
