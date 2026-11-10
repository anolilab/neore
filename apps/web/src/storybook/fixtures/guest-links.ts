import { api } from "@neore/backend/api";

import { DAY, HOUR, STORY_NOW as NOW } from "../clock";
import { lunora } from "../lunora";
import type { LunoraFixture } from "../lunora";

/** A thread's guest notes as the owner's `getGuestLink` reads them. */
export const GUEST_NOTES = [
    { createdAt: NOW - 2 * HOUR, id: "note-held", status: "held" as const, text: "Could you check the deploy tonight? The staging build is red." },
    { createdAt: NOW - 5 * HOUR, id: "note-sent", status: "sent" as const, text: "Thanks for the summary yesterday." },
];

/**
 * The owner's guest-link procedures (`chat/guest-links.ts`). `link: false` is a thread with no live link; `createDelayMs`
 * holds the new link's answer back.
 */
export const guestLinksFixtures = ({
    link = true,
    messages = GUEST_NOTES,
    createDelayMs,
}: {
    createDelayMs?: number;
    link?: boolean;
    messages?: typeof GUEST_NOTES;
} = {}): LunoraFixture[] => {
    // A revoke ends the link and withdraws its notes, as the backend does; the live read then shows "Create guest link".
    let live = link;

    return [
        lunora(api.chat.guest_links.getGuestLink, () => {
            return live ? { link: { bound: true, expiresAt: NOW + DAY }, messages } : { link: null, messages: [] };
        }),
        lunora(
            api.chat.guest_links.createGuestLink,
            () => {
                // An obviously fake token of the minted shape (64 hex characters).
                return { expiresAt: NOW + DAY, linkToken: "ab".repeat(32) };
            },
            { delayMs: createDelayMs },
        ),
        lunora(api.chat.guest_links.revokeGuestLink, () => {
            live = false;

            return null;
        }),
    ];
};
