/** The one reader of the guest mark (`chat/lib/attached-text.ts#guestTextPart`) for taint, memory and skill commands. */

/** The mark: the held note's id (`/chat/start`), or `true`. */
const guestMarkOf = (part: { providerOptions?: unknown }): unknown =>
    (part.providerOptions as { neore?: { guestText?: unknown } } | undefined)?.neore?.guestText;

/** Whether a part is guest text. */
export const isGuestTextPart = (part: { providerOptions?: unknown }): boolean => {
    const mark = guestMarkOf(part);

    return mark === true || (typeof mark === "string" && mark.length > 0);
};

/** The id of the held note a part was sent from, when it carries one. */
export const guestNoteIdOf = (part: { providerOptions?: unknown }): string | undefined => {
    const mark = guestMarkOf(part);

    return typeof mark === "string" ? mark : undefined;
};
