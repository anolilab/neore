import { api } from "@neore/backend/api";

import { DAY, HOUR, STORY_NOW as NOW } from "../clock";
import { lunora, onStoryReset } from "../lunora";
import type { LunoraFixture } from "../lunora";

/** A thread's guest notes as the owner's `getGuestLink` reads them. */
export const GUEST_NOTES = [
    { createdAt: NOW - 2 * HOUR, id: "note-held", status: "held" as const, text: "Could you check the deploy tonight? The staging build is red." },
    { createdAt: NOW - 5 * HOUR, id: "note-sent", status: "sent" as const, text: "Thanks for the summary yesterday." },
];

/** A thread's live link's id: one per thread, so a link made in one chat never matches another's. */
const linkIdOf = (threadId: string): string => `guest-link-${threadId}`;

/**
 * The owner's guest-link procedures (`chat/guest-links.ts`). `link: false` is a thread with no live link. Create makes the link live, a revoke ends it and its notes, and both start over before
 * each story and each visit to one. A waiting note's Send hands out its text and reads as sent from then on (the backend marks it once `/chat/start` saved it); Dismiss deletes it.
 */
export const guestLinksFixtures = ({
    link = true,
    messages = GUEST_NOTES,
}: {
    link?: boolean;
    messages?: typeof GUEST_NOTES;
} = {}): LunoraFixture[] => {
    let live = link;
    let notes = messages;
    const reset = () => {
        live = link;
        notes = messages;
    };

    reset();
    onStoryReset(reset);

    return [
        lunora(api.chat.guest_links.getGuestLink, ({ threadId }) => {
            return live ? { link: { bound: true, expiresAt: NOW + DAY, id: linkIdOf(threadId) }, messages: notes } : { link: null, messages: [] };
        }),
        lunora(api.chat.guest_links.createGuestLink, ({ threadId }) => {
            live = true;
            notes = [];

            // An obviously fake token of the minted shape (64 hex characters).
            return { expiresAt: NOW + DAY, id: linkIdOf(threadId), linkToken: "ab".repeat(32) };
        }),
        lunora(api.chat.guest_links.sendHeldGuestMessage, ({ messageId }) => {
            const note = notes.find(({ id }) => id === messageId);

            if (!note || note.status === "sent") {
                return { status: "sent" as const };
            }

            notes = notes.map((row) => (row.id === messageId ? { ...row, status: "sent" as const } : row));

            return { status: "ready" as const, text: note.text, threadId: "thread" };
        }),
        lunora(api.chat.guest_links.dismissHeldGuestMessage, ({ messageId }) => {
            notes = notes.filter(({ id }) => id !== messageId);

            return { status: "dismissed" as const };
        }),
        lunora(api.chat.guest_links.revokeGuestLink, () => {
            live = false;
            notes = [];

            return null;
        }),
    ];
};
