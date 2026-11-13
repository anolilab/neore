import { describe, expect, it, vi } from "vitest";

import { GIVE_BACK_SEPARATOR, planSend } from "./start-send";
import type { UnsentPrompt } from "./unsent-prompts";
import { createUnsentPrompts, followUnsentPrompts, giveBackOrKeep, unsentPromptKey, withUnsentPrompt } from "./unsent-prompts";

const HELD = { held: { clientMessageId: "first-id", prompt: "hello" }, prompt: "hello" };

describe("a prompt given back after its chat screen unmounted", () => {
    it("comes back into the composer with its held id when that chat's screen mounts again", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");
        const unmountedScreen = vi.fn<(entry: UnsentPrompt) => void>();

        // The screen was left while the token mint was pending; the stopped send settles afterwards.
        giveBackOrKeep({ apply: unmountedScreen, entry: HELD, isMounted: false, key, store });
        expect(unmountedScreen).not.toHaveBeenCalled();

        const remountedScreen = vi.fn<(entry: UnsentPrompt) => void>();

        followUnsentPrompts({ apply: remountedScreen, key, store })();
        expect(remountedScreen).toHaveBeenCalledExactlyOnceWith(HELD);

        // Taken once: a later mount of the same chat gets nothing again.
        const later = vi.fn<(entry: UnsentPrompt) => void>();

        followUnsentPrompts({ apply: later, key, store })();
        expect(later).not.toHaveBeenCalled();
    });

    it("reaches a screen of the chat mounted before the left send settled, once", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");
        const reopened = vi.fn<(entry: UnsentPrompt) => void>();

        // The person leaves during the token mint and opens the chat again before the stopped send settles.
        const unmount = followUnsentPrompts({ apply: reopened, key, store });

        expect(reopened).not.toHaveBeenCalled();

        giveBackOrKeep({ apply: vi.fn(), entry: HELD, isMounted: false, key, store });
        expect(reopened).toHaveBeenCalledExactlyOnceWith(HELD);

        // Consumed: neither this screen nor a later one gets it again.
        expect(store.take(key)).toBeUndefined();
        unmount();

        const later = vi.fn<(entry: UnsentPrompt) => void>();

        followUnsentPrompts({ apply: later, key, store })();
        expect(later).not.toHaveBeenCalled();
    });

    it("stops reaching a screen once it unmounts", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");
        const screen = vi.fn<(entry: UnsentPrompt) => void>();

        followUnsentPrompts({ apply: screen, key, store })();
        store.keep(key, HELD);

        expect(screen).not.toHaveBeenCalled();
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

    it("stays with its own account and chat, and is dropped at sign-out", () => {
        const store = createUnsentPrompts();

        store.keep(unsentPromptKey("user-a", undefined), HELD);
        expect(store.take(unsentPromptKey("user-b", undefined))).toBeUndefined();
        expect(store.take(unsentPromptKey("user-a", "thread-1"))).toBeUndefined();

        store.clear();
        expect(store.take(unsentPromptKey("user-a", undefined))).toBeUndefined();
    });

    it("keeps a second prompt for the same chat after the first, which keeps its hold", () => {
        const store = createUnsentPrompts();
        const key = unsentPromptKey("user-a", "thread-1");

        store.keep(key, HELD);
        store.keep(key, { held: { clientMessageId: "second-id", prompt: "and more" }, prompt: "and more" });

        expect(store.take(key)).toStrictEqual({ held: HELD.held, prompt: "hello\n\nand more" });
    });
});

describe(withUnsentPrompt, () => {
    it("puts a late prompt back ahead of what is typed, with its held send, on a screen holding none", () => {
        expect(withUnsentPrompt({ draft: "", held: null }, HELD)).toStrictEqual({ draft: "hello", held: HELD.held });

        const merged = withUnsentPrompt({ draft: "typed since", held: null }, HELD);

        expect(merged.draft).toBe(`hello${GIVE_BACK_SEPARATOR}typed since`);
        expect(planSend(merged.held, merged.draft)).toStrictEqual({ heldId: "first-id", prompt: "hello", rest: "typed since" });
    });

    it("keeps the screen's own hold first, the late prompt after it", () => {
        const own = { clientMessageId: "own-id", prompt: "mine" };
        const next = withUnsentPrompt({ draft: "mine", held: own }, HELD);

        expect(next.draft).toBe(`mine${GIVE_BACK_SEPARATOR}hello`);
        // The screen's held prompt still goes alone first under its id; the late one waits for the next send.
        expect(planSend(next.held, next.draft)).toStrictEqual({ heldId: "own-id", prompt: "mine", rest: "hello" });
    });
});
