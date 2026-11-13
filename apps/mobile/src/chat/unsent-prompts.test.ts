import { describe, expect, it, vi } from "vitest";

import { createSendSessions } from "./send-sessions";
import type { HeldSend } from "./start-send";
import { planSend } from "./start-send";
import type { UnsentPrompt } from "./unsent-prompts";
import { createUnsentPrompts, followUnsentPrompts, giveBackOrKeep, takeUnsentPrompt, unsentPromptKey } from "./unsent-prompts";

const HELD = { held: { clientMessageId: "first-id", prompt: "hello" }, prompt: "hello" };
const SECOND = { held: { clientMessageId: "second-id", prompt: "and more" }, prompt: "and more" };

/**
 * A chat screen as `followUnsentPrompts` sees it: its composer and its one hold, taking a kept prompt only into an empty
 * composer (`takeUnsentPrompt`), and offered the next one whenever its composer empties, as the screen's `setDraft` does.
 */
const fakeScreen = () => {
    const screen = {
        /** Wires the re-offer the screen's effect stores (`offerUnsent`). */
        bindOffer: (offer: () => void) => {
            screen.offer = offer;
        },
        didTake: (entry: UnsentPrompt): boolean => {
            const next = takeUnsentPrompt({ draft: screen.draft, isSending: false }, entry);

            if (next === undefined) {
                return false;
            }

            screen.draft = next.draft;
            screen.held = next.held;

            return true;
        },
        draft: "",
        held: null as HeldSend | null,
        offer: () => {},
        /** A press of Send that goes through: it uses the hold, and what `planSend` left stays in the composer. */
        send: () => {
            const plan = planSend(screen.held, screen.draft);

            screen.held = null;
            screen.setDraft(plan.rest);

            return plan;
        },
        /** The person edits the composer; emptied, it is offered the next kept prompt. */
        setDraft: (draft: string) => {
            screen.draft = draft;

            if (draft.trim() === "") {
                screen.offer();
            }
        },
    };

    return screen;
};

/** Mounts `screen` on `key`, wiring its re-offer as the screen's effect does. */
const mount = (screen: ReturnType<typeof fakeScreen>, key: string, store: ReturnType<typeof createUnsentPrompts>) => {
    const follow = followUnsentPrompts({ didTake: screen.didTake, key, store });

    screen.bindOffer(follow.offer);

    return follow;
};

describe("a prompt given back after its chat screen unmounted", () => {
    it("comes back into the composer with its held id when that chat's screen mounts again, once", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");
        const unmountedScreen = vi.fn<(entry: UnsentPrompt) => void>();

        // The screen was left while the token mint was pending; the stopped send settles afterwards.
        giveBackOrKeep({ apply: unmountedScreen, entry: HELD, isMounted: false, key, store });
        expect(unmountedScreen).not.toHaveBeenCalled();

        const remounted = fakeScreen();

        followUnsentPrompts({ didTake: remounted.didTake, key, store }).stop();
        expect(remounted).toMatchObject({ draft: "hello", held: HELD.held });

        // Taken once: a later mount of the same chat gets nothing again.
        const later = fakeScreen();

        followUnsentPrompts({ didTake: later.didTake, key, store }).stop();
        expect(later.draft).toBe("");
    });

    it("reaches a screen of the chat mounted before the left send settled, once", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");
        const reopened = fakeScreen();

        // The person leaves during the token mint and opens the chat again before the stopped send settles.
        const follow = followUnsentPrompts({ didTake: reopened.didTake, key, store });

        expect(reopened.draft).toBe("");

        giveBackOrKeep({ apply: vi.fn(), entry: HELD, isMounted: false, key, store });
        expect(reopened).toMatchObject({ draft: "hello", held: HELD.held });

        // Consumed: neither this screen nor a later one gets it again.
        expect(store.take(key)).toBeUndefined();
        follow.stop();
    });

    it("stops reaching a screen once it unmounts", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");
        const screen = fakeScreen();

        followUnsentPrompts({ didTake: screen.didTake, key, store }).stop();
        store.keep(key, HELD);

        expect(screen.draft).toBe("");
        expect(store.take(key)).toStrictEqual(HELD);
    });

    it("goes to the screen itself while it is mounted, and keeps nothing", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");
        const screen = vi.fn<(entry: UnsentPrompt) => void>();

        giveBackOrKeep({ apply: screen, entry: HELD, isMounted: true, key, store });
        expect(screen).toHaveBeenCalledExactlyOnceWith(HELD);
        expect(store.take(key)).toBeUndefined();
    });

    it("stays with its own account and chat", () => {
        const store = createUnsentPrompts();

        store.keep(unsentPromptKey("user-a", undefined), HELD);
        expect(store.take(unsentPromptKey("user-b", undefined))).toBeUndefined();
        expect(store.take(unsentPromptKey("user-a", "thread-1"))).toBeUndefined();
        expect(store.take(unsentPromptKey("user-a", undefined))).toStrictEqual(HELD);
    });
});

describe("two prompts given back for the same chat", () => {
    it("come back one at a time, each resent under its own id", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");

        // Two failed sends for the same chat, both after its screen unmounted.
        giveBackOrKeep({ apply: vi.fn(), entry: HELD, isMounted: false, key, store });
        giveBackOrKeep({ apply: vi.fn(), entry: SECOND, isMounted: false, key, store });

        const screen = fakeScreen();
        const follow = mount(screen, key, store);

        // The first, with its hold; the second waits while the composer holds the first.
        expect(screen).toMatchObject({ draft: "hello", held: HELD.held });
        // Sent, the composer empties and the next comes in, under its own id.
        expect(screen.send()).toStrictEqual({ heldId: "first-id", prompt: "hello", rest: "" });
        expect(screen).toMatchObject({ draft: "and more", held: SECOND.held });
        expect(screen.send()).toStrictEqual({ heldId: "second-id", prompt: "and more", rest: "" });
        expect(screen.draft).toBe("");
        follow.stop();
    });

    it("never merges the next one into a refused prompt without a hold that sits in the composer", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");

        store.keep(key, { held: null, prompt: "refused" });
        store.keep(key, SECOND);

        const screen = fakeScreen();
        const follow = mount(screen, key, store);

        expect(screen).toMatchObject({ draft: "refused", held: null });

        // Offered again (a send ended elsewhere): the composer still holds the refused prompt, so the next waits.
        follow.offer();
        expect(screen).toMatchObject({ draft: "refused", held: null });
        expect(store.take(key)).toStrictEqual(SECOND);
        follow.stop();
    });

    it("offers the next one when the person clears the composer holding the first", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");

        store.keep(key, HELD);
        store.keep(key, SECOND);

        const screen = fakeScreen();
        const follow = mount(screen, key, store);

        expect(screen.draft).toBe("hello");

        screen.setDraft("");
        expect(screen).toMatchObject({ draft: "and more", held: SECOND.held });
        follow.stop();
    });

    it("keeps a prompt without a hold, and the one after it keeps its own", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");

        store.keep(key, { held: null, prompt: "reused id" });
        store.keep(key, SECOND);

        expect(store.take(key)).toStrictEqual({ held: null, prompt: "reused id" });
        expect(store.take(key)).toStrictEqual(SECOND);
    });
});

describe("a sign-out with a send still going", () => {
    it("keeps nothing for anyone, even from a send begun during its teardown", () => {
        const store = createUnsentPrompts();
        const sessions = createSendSessions();
        const key = unsentPromptKey("user-a", "thread-1");

        store.keep(key, HELD);

        // Sign-out starts: sends stop and the store closes.
        sessions.signOut();
        store.close();
        expect(store.take(key)).toBeUndefined();

        // The account still reads as signed in while the cache is emptied: a send begins, is stopped at once, and fails
        // after its screen unmounted. It is the departing account's, and the store keeps nothing.
        const controller = new AbortController();
        const midTeardown = sessions.begin(controller);

        expect(controller.signal.aborted).toBe(true);
        expect(midTeardown.isSignedOut()).toBe(true);
        giveBackOrKeep({ apply: vi.fn(), entry: SECOND, isMounted: false, key, store });

        // Sign-out completes.
        store.clear();
        expect(store.take(key)).toBeUndefined();

        // The next sign-in opens both again.
        sessions.open();
        store.open();

        const later = new AbortController();

        expect(sessions.begin(later).isSignedOut()).toBe(false);
        expect(later.signal.aborted).toBe(false);
        store.keep(key, HELD);
        expect(store.take(key)).toStrictEqual(HELD);
    });
});

describe(takeUnsentPrompt, () => {
    it("takes a kept prompt only into an empty composer with no send going, as it is, with its own hold", () => {
        expect(takeUnsentPrompt({ draft: "", isSending: false }, HELD)).toStrictEqual({ draft: "hello", held: HELD.held });
        expect(takeUnsentPrompt({ draft: "  \n", isSending: false }, { held: null, prompt: "refused" })).toStrictEqual({ draft: "refused", held: null });
        expect(takeUnsentPrompt({ draft: "typed since", isSending: false }, HELD)).toBeUndefined();
        expect(takeUnsentPrompt({ draft: "", isSending: true }, HELD)).toBeUndefined();
    });
});
