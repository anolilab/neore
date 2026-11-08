/** How often the guest page asks whether a waiting note was sent. */
export const GUEST_POLL_MS = 15_000;

/** Poll only while a note waits: a sent note is final, and no view (an ended or unbound link) has nothing to watch. */
export const guestPollInterval = (view: { messages: ReadonlyArray<{ status: "held" | "sent" }> } | null | undefined): number | false =>
    view?.messages.some((note) => note.status === "held") ? GUEST_POLL_MS : false;
