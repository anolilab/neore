import type { InboundAttachment } from "./media";

/**
 * The shape every platform adapter's parser reduces an inbound webhook to, so
 * the shared pipeline (`messenger/webhooks.ts#acceptInbound`) can dedupe, authorize, rate-limit
 * and persist without knowing which platform it came from.
 */
export interface InboundMessage {
    /** Images, files and voice notes, when `kind === "media"` — handles only, fetched later (`lib/media.ts`). */
    attachments?: InboundAttachment[];
    /** Chat to reply into (DM partner, group, channel or conversation id). */
    chatId: string;
    /**
     * The platform says this is a one-to-one chat with the sender (no group, channel or room). Only then may a reply
     * show what is remembered about the owner (`/memory`); absent or false is treated as a group.
     */
    direct?: boolean;
    /** Platform-unique id of this message or event — the dedupe key. */
    eventId: string;
    /**
     * `"media"` carries `attachments` (and `text` as its caption, if any).
     * `"unsupported"` for stickers, locations, contacts… — acknowledged with a
     * notice instead of being sent to the model.
     */
    kind: "media" | "text" | "unsupported";
    senderId: string;
    senderName?: string;
    /** Handle (`@name`), where the platform has one; recorded when the sender pairs. */
    senderUsername?: string;
    /** Present when `kind === "text"`; the caption, if any, when `kind === "media"`. */
    text?: string;
    /** When the platform says the message was sent (ms). */
    timestampMs: number;
}

/**
 * The text without a leading bot mention: Slack's `<@U123>` (or `<@U123|name>`) and Discord's `<@123>` / `<@!123>`, so
 * a command typed after one (`<@U123> /memory`) still matches. Teams' `<at>` and Feishu's `@_user_1` are dropped by
 * their parsers already.
 */
const LEADING_MENTION = /^\s*<@!?[\w.|-]+>\s*/u;

export const withoutLeadingMention = (text: string): string => text.replace(LEADING_MENTION, "");

/** Reply sent for stickers, locations, contacts and the like, which the bot does not read. */
export const UNSUPPORTED_CONTENT_NOTICE =
    "I can read text, images, documents and voice messages — stickers, locations and similar messages are ignored. Please send your message in one of those forms.";

/** Split a message into chunks of at most `maxLength` characters, preferring word boundaries. */
export const splitMessage = (text: string, maxLength: number): string[] => {
    if (text.length <= maxLength) {
        return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
        let splitIndex = remaining.lastIndexOf(" ", maxLength);

        if (splitIndex <= 0) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex).trimStart();
    }

    if (remaining.length > 0) {
        chunks.push(remaining);
    }

    return chunks;
};

/**
 * Whether a parsed message is inside its platform's replay window. Older (or
 * undated, or id-less) messages are dropped: a legitimate platform redelivery
 * never arrives that late, so what does is a replay.
 */
export const isFreshInbound = (message: Pick<InboundMessage, "eventId" | "timestampMs">, maxAgeMs: number, nowMs: number = Date.now()): boolean =>
    Boolean(message.eventId) && Number.isFinite(message.timestampMs) && nowMs - message.timestampMs <= maxAgeMs;

/** A parsed message's `kind`: anything attached makes it media (its text the caption); else text, or nothing we read. */
export const inboundKind = (text: string | undefined, attachments: ReadonlyArray<unknown> = []): InboundMessage["kind"] => {
    if (attachments.length > 0) {
        return "media";
    }

    return text ? "text" : "unsupported";
};
