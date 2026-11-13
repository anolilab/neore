import type { HeldSend } from "./start-send";
import { holdFor } from "./start-send";
import { draftAfterUnsent, giveBackDraft } from "./unsent-send";

/** A prompt given back after its chat screen was gone, with the send it holds (`null` when its id was dropped). */
export interface UnsentPrompt {
    held: HeldSend | null;
    prompt: string;
}

/** The chat a prompt belongs to, per account: a new chat's screen is `new` until its start answers. */
export const unsentPromptKey = (accountId: string, threadId: string | undefined): string => `${accountId}:${threadId ?? "new"}`;

/**
 * Prompts given back while their chat's screen was unmounted (left during a token mint or a retry), kept in memory until
 * that screen mounts again. Without it the prompt and its held `clientMessageId` would land in the state of a component
 * that is gone. Emptied at sign-out.
 */
export const createUnsentPrompts = () => {
    const entries = new Map<string, UnsentPrompt>();
    const watchers = new Map<string, Set<() => void>>();
    const take = (key: string): UnsentPrompt | undefined => {
        const entry = entries.get(key);

        entries.delete(key);

        return entry;
    };

    return {
        clear: (): void => {
            entries.clear();
        },

        /**
         * A second prompt for the same chat goes after the first, which keeps its hold (`planSend` sends the held one first).
         * A chat screen mounted meanwhile (`watch`) is told at once, so a prompt kept after it mounted is not left waiting.
         */
        keep: (key: string, entry: UnsentPrompt): void => {
            const earlier = entries.get(key);

            entries.set(key, earlier ? { held: earlier.held, prompt: draftAfterUnsent(entry.prompt, earlier.prompt) } : entry);

            const keyWatchers = watchers.get(key) ?? new Set<() => void>();

            for (const notify of keyWatchers) {
                notify();
            }
        },
        take,

        /**
         * Hands `key`'s prompt to `onEntry` now, and each one kept later until unwatched. Each is taken, so it is handed over
         * once: to the first watcher, never again on a later mount.
         */
        watch: (key: string, onEntry: (entry: UnsentPrompt) => void): () => void => {
            const deliver = (): void => {
                const entry = take(key);

                if (entry) {
                    onEntry(entry);
                }
            };
            const keyWatchers = watchers.get(key) ?? new Set<() => void>();

            keyWatchers.add(deliver);
            watchers.set(key, keyWatchers);
            deliver();

            return () => {
                keyWatchers.delete(deliver);

                if (keyWatchers.size === 0) {
                    watchers.delete(key);
                }
            };
        },
    };
};

export type UnsentPrompts = ReturnType<typeof createUnsentPrompts>;

/** The app's one store: a screen keeps here what it can no longer show, and takes it back when it mounts. */
export const unsentPrompts = createUnsentPrompts();

/**
 * Gives a failed send's prompt back: to the screen (`apply`) while it is mounted, otherwise into `store` for the chat's
 * next mount ({@link followUnsentPrompts}).
 */
export const giveBackOrKeep = ({
    apply,
    entry,
    isMounted,
    key,
    store,
}: {
    apply: (entry: UnsentPrompt) => void;
    entry: UnsentPrompt;
    isMounted: boolean;
    key: string | undefined;
    store: UnsentPrompts;
}): void => {
    if (isMounted) {
        apply(entry);
    } else if (key !== undefined) {
        store.keep(key, entry);
    }
};

/**
 * For as long as a chat screen is mounted: the prompt kept while it was gone, and any kept later (a send the person left
 * that settles after they came back), into its composer with its held send. Returns the stop for its unmount.
 */
export const followUnsentPrompts = ({ apply, key, store }: { apply: (entry: UnsentPrompt) => void; key: string; store: UnsentPrompts }): () => void =>
    store.watch(key, apply);

/**
 * A chat screen's composer and hold after a kept prompt reaches it. With no hold of its own, the prompt goes back as any
 * failed send's does: ahead of what is typed, with its held send (`holdFor`, so the app's merge is recorded). With a hold
 * of its own, the prompt goes after the composer's text, and the screen's hold now records that text as the app's merge,
 * so its held prompt is still sent alone first under its id. One hold at a time: the late prompt then goes as a new message.
 */
export const withUnsentPrompt = (
    { draft, held }: { draft: string; held: HeldSend | null },
    entry: UnsentPrompt,
): { draft: string; held: HeldSend | null } => {
    if (held === null) {
        const given = giveBackDraft(draft, entry.prompt);

        // eslint-disable-next-line unicorn/no-null -- a hold is `HeldSend | null` across the screen and `planSend`
        return { draft: given.draft, held: entry.held ? holdFor(entry.held, given.draft) : null };
    }

    const next = draftAfterUnsent(entry.prompt, draft);

    return { draft: next, held: holdFor(held, next) };
};
