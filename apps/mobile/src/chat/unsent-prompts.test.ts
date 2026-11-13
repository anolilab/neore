import { describe, expect, it, vi } from "vitest";

import type { UnsentPrompt } from "./unsent-prompts";
import { createUnsentPrompts, giveBackOrKeep, restoreUnsentPrompt, unsentPromptKey } from "./unsent-prompts";

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

        restoreUnsentPrompt({ apply: remountedScreen, key, store });
        expect(remountedScreen).toHaveBeenCalledExactlyOnceWith(HELD);

        // Taken once: a later mount of the same chat gets nothing again.
        const later = vi.fn<(entry: UnsentPrompt) => void>();

        restoreUnsentPrompt({ apply: later, key, store });
        expect(later).not.toHaveBeenCalled();
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
