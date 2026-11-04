/**
 * The text the system share sheet receives for one message. `undefined` when the
 * message has no text (a reply that has not started yet), so there is nothing
 * to offer.
 */
export const shareableMessageText = (message: { text: string }): string | undefined => {
    const text = message.text.trim();

    return text.length > 0 ? text : undefined;
};

const PREVIEW_LENGTH = 40;

/**
 * The button's accessible name. Every row has its own, so a screen-reader user can
 * tell the buttons apart: the role plus the start of the message, collapsed onto one line.
 */
export const shareLabel = (message: { role: string; text: string }): string => {
    const oneLine = message.text.replaceAll(/\s+/g, " ").trim();
    const preview = oneLine.length > PREVIEW_LENGTH ? `${oneLine.slice(0, PREVIEW_LENGTH)}…` : oneLine;
    const who = message.role === "user" ? "your message" : "reply";

    return `Share ${who}: ${preview}`;
};
