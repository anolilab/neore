import { api } from "@neore/backend/api";

import { HOUR, STORY_NOW as NOW } from "../clock";
import { lunora, lunoraError } from "../lunora";
import type { LunoraFixture } from "../lunora";

/** The link a guest page story opens: a fake token of the minted shape, in the URL fragment. */
export const GUEST_LINK_TOKEN = "cd".repeat(32);

type GuestPost = { guestToken?: string; linkToken: string; requestId?: string; text: string };

/** What the guest page posted and the shard stored, in order, for a story's `play` to read. */
export const guestPosts: GuestPost[] = [];

/** Every post the page sent, a failed one too. */
export const guestAttempts: GuestPost[] = [];

/** Forgets what earlier stories posted; fixtures are built when a story module loads, so each story resets here. */
export const resetGuestPosts = (): void => {
    guestPosts.length = 0;
    guestAttempts.length = 0;
};

/** A fixture whose first call goes through but loses its reply (answers `failure`), as a dropped connection does. */
const failingOnce = (fixture: LunoraFixture, failure: LunoraFixture): LunoraFixture => {
    return {
        answer: async (args) => {
            guestAttempts.push(args as GuestPost);

            const answer = await fixture.answer(args);

            return guestAttempts.length > 1 ? answer : await failure.answer(args);
        },
        functionPath: fixture.functionPath,
    };
};

/**
 * The guest's two public actions (`chat/guest-links.ts`). Posts are kept and listed back as held, after `notes` (the
 * notes from earlier visits); `failFirstPost` stores the first post but loses its reply, as a dropped connection does.
 */
export const guestPageFixtures = ({
    endAfterPost = false,
    failFirstPost = false,
    failViewAfterPost = false,
    notes = [] as { createdAt: number; status: "held" | "sent"; text: string }[],
    postRefusal,
    slowViewAfterPost = false,
}: {
    /** The owner revokes the link right after the post: the view then answers nothing. */
    endAfterPost?: boolean;
    failFirstPost?: boolean;
    /** The view after a post fails, as a dropped connection or a rate limit does: that is no answer about the link. */
    failViewAfterPost?: boolean;
    notes?: { createdAt: number; status: "held" | "sent"; text: string }[];
    /** Every post is refused with this backend code. */
    postRefusal?: string;
    /** The view after a post answers late, as a slow connection does: the page must not call the link ended meanwhile. */
    slowViewAfterPost?: boolean;
} = {}): LunoraFixture[] => {
    const post = lunora(api.chat.guest_links.postGuestMessage, (args) => {
        // A request id already stored is answered without a second note, as the shard does (`guest-post` claims).
        if (args.requestId !== undefined && guestPosts.some((posted) => posted.requestId === args.requestId)) {
            return {};
        }

        guestPosts.push(args);

        return guestPosts.length === 1 ? { guestToken: args.guestToken } : {};
    });

    const refused = postRefusal === undefined ? undefined : lunoraError(api.chat.guest_links.postGuestMessage, postRefusal, "The server's own words");

    return [
        refused ??
            (failFirstPost ? failingOnce(post, lunoraError(api.chat.guest_links.postGuestMessage, "UNAVAILABLE", "The connection was lost.", 503)) : post),
        lunora(api.chat.guest_links.getGuestView, async () => {
            if (slowViewAfterPost && guestPosts.length > 0) {
                await new Promise((resolve) => {
                    setTimeout(resolve, 1500);
                });
            }

            if (endAfterPost && guestPosts.length > 0) {
                return null;
            }

            if (failViewAfterPost && guestPosts.length > 0) {
                throw new Error("The connection was lost.");
            }

            return {
                expiresAt: NOW + HOUR,
                messages: [...notes, ...guestPosts.map((posted) => ({ createdAt: NOW, status: "held" as const, text: posted.text }))],
            };
        }),
    ];
};
