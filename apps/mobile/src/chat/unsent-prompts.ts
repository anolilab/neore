import type { HeldSend } from "./start-send";

/** A prompt given back after its chat screen was gone, with the send it holds (`null` when its id was dropped). */
export interface UnsentPrompt {
    held: HeldSend | null;
    prompt: string;
}

/** The chat a prompt belongs to, per account: a new chat's screen is `new` until its start answers. */
export const unsentPromptKey = (accountId: string, threadId: string | undefined): string => `${accountId}:${threadId ?? "new"}`;

/**
 * Prompts given back while their chat's screen was unmounted (left during a token mint or a retry), kept in memory until
 * that chat's screen takes them. Without it the prompt and its held `clientMessageId` would land in the state of a
 * component that is gone. Each prompt is its own entry with its own held send, in order; none is merged into another.
 * Closed for the whole of a sign-out (`close`): nothing is kept for the departing account, and it is emptied.
 */
export const createUnsentPrompts = () => {
    const entries = new Map<string, UnsentPrompt[]>();
    const watchers = new Map<string, Set<() => void>>();
    let isClosed = false;
    const take = (key: string): UnsentPrompt | undefined => {
        const list = entries.get(key);
        const entry = list?.shift();

        if (list?.length === 0) {
            entries.delete(key);
        }

        return entry;
    };

    return {
        clear: (): void => {
            entries.clear();
        },
        /** From the start of a sign-out until the next sign-in: empties the store and keeps nothing more. */
        close: (): void => {
            isClosed = true;
            entries.clear();
        },

        /** A chat screen watching the key (`watch`) is offered the prompt at once, so one kept after it mounted is not left waiting. */
        keep: (key: string, entry: UnsentPrompt): void => {
            if (isClosed) {
                return;
            }

            const list = entries.get(key) ?? [];
            const keyWatchers = watchers.get(key) ?? new Set<() => void>();

            entries.set(key, [...list, entry]);

            for (const offer of keyWatchers) {
                offer();
            }
        },
        /** At a sign-in: the store keeps prompts again. */
        open: (): void => {
            isClosed = false;
        },
        take,

        /**
         * Offers `key`'s prompts to `didTake` one at a time, oldest first: now, on each `keep`, and on `offer` (the screen can
         * take one again). A prompt is taken only when `didTake` takes it, so each reaches one screen once, and one the
         * screen cannot take yet (it holds a send) waits its turn.
         */
        watch: (key: string, didTake: (entry: UnsentPrompt) => boolean): { offer: () => void; stop: () => void } => {
            const offer = (): void => {
                let next = entries.get(key)?.[0];

                while (next !== undefined && didTake(next)) {
                    take(key);
                    next = entries.get(key)?.[0];
                }
            };
            const keyWatchers = watchers.get(key) ?? new Set<() => void>();

            keyWatchers.add(offer);
            watchers.set(key, keyWatchers);
            offer();

            return {
                offer,
                stop: () => {
                    keyWatchers.delete(offer);

                    if (keyWatchers.size === 0) {
                        watchers.delete(key);
                    }
                },
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
 * For as long as a chat screen is mounted: the prompts kept while it was gone, and any kept later (a send the person left
 * that settles after they came back), offered one at a time (`didTake` takes one only into an empty composer, `takeUnsentPrompt`).
 * `offer` offers again once the screen can take one; `stop` is for its unmount.
 */
export const followUnsentPrompts = ({
    didTake,
    key,
    store,
}: {
    didTake: (entry: UnsentPrompt) => boolean;
    key: string;
    store: UnsentPrompts;
}): { offer: () => void; stop: () => void } => store.watch(key, didTake);

/**
 * Whether a chat screen takes a kept prompt now, and its composer and hold if it does. Only into an empty composer with
 * no send going: the prompt becomes the draft as it is, with its own held send (or none), and is never merged into text
 * already there, which may be another prompt given back (held or not) or the person's own. The next is offered when the
 * composer is empty again (sent, or cleared).
 */
export const takeUnsentPrompt = (
    { draft, isSending }: { draft: string; isSending: boolean },
    entry: UnsentPrompt,
): { draft: string; held: HeldSend | null } | undefined => {
    if (isSending || draft.trim() !== "") {
        return undefined;
    }

    return { draft: entry.prompt, held: entry.held };
};
