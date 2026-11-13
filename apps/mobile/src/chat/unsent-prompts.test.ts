import { describe, expect, it, vi } from "vitest";

import { createSendSessions } from "./send-sessions";
import type { HeldSend } from "./start-send";
import { GIVE_BACK_SEPARATOR, planSend } from "./start-send";
import type { UnsentPrompt } from "./unsent-prompts";
import { createUnsentPrompts, followUnsentPrompts, giveBackOrKeep, unsentPromptKey, withUnsentPrompt } from "./unsent-prompts";

const HELD = { held: { clientMessageId: "first-id", prompt: "hello" }, prompt: "hello" };
const SECOND = { held: { clientMessageId: "second-id", prompt: "and more" }, prompt: "and more" };

/** A chat screen as `followUnsentPrompts` sees it: its composer and its one hold, taking a prompt only while it holds none. */
const fakeScreen = () => {
    const screen = {
        didTake: (entry: UnsentPrompt): boolean => {
            if (screen.held !== null) {
                return false;
            }

            const next = withUnsentPrompt(screen.draft, entry);

            screen.draft = next.draft;
            screen.held = next.held;

            return true;
        },
        draft: "",
        held: null as HeldSend | null,
        /** A press of Send that goes through: it uses the hold, and what `planSend` left stays in the composer. */
        send: () => {
            const plan = planSend(screen.held, screen.draft);

            screen.held = null;
            screen.draft = plan.rest;

            return plan;
        },
    };

    return screen;
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
        const follow = followUnsentPrompts({ didTake: screen.didTake, key, store });

        // The first, with its hold; the second waits while the screen holds a send.
        expect(screen).toMatchObject({ draft: "hello", held: HELD.held });
        expect(screen.send()).toStrictEqual({ heldId: "first-id", prompt: "hello", rest: "" });

        // The send ended: the screen takes the next one, under its own id.
        follow.offer();
        expect(screen).toMatchObject({ draft: "and more", held: SECOND.held });
        expect(screen.send()).toStrictEqual({ heldId: "second-id", prompt: "and more", rest: "" });

        follow.offer();
        expect(screen.draft).toBe("");
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

describe(withUnsentPrompt, () => {
    it("puts a kept prompt back ahead of what is typed, with its own held send and the app's merge recorded", () => {
        expect(withUnsentPrompt("", HELD)).toStrictEqual({ draft: "hello", held: HELD.held });

        const merged = withUnsentPrompt("typed since", HELD);

        expect(merged.draft).toBe(`hello${GIVE_BACK_SEPARATOR}typed since`);
        expect(planSend(merged.held, merged.draft)).toStrictEqual({ heldId: "first-id", prompt: "hello", rest: "typed since" });
    });
});
