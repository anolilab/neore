/**
 * The text the system share sheet receives for one message. `undefined` when the
 * message has no text (a reply that has not started yet), so there is nothing
 * to offer.
 */
export const shareableMessageText = (message: { text: string }): string | undefined => {
    const text = message.text.trim();

    return text.length > 0 ? text : undefined;
};
