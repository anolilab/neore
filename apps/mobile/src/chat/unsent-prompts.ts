import type { HeldSend } from "./start-send";
import { draftAfterUnsent } from "./unsent-send";

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

    return {
        clear: (): void => {
            entries.clear();
        },
        /** A second prompt for the same chat goes after the first, which keeps its hold (`planSend` sends the held one first). */
        keep: (key: string, entry: UnsentPrompt): void => {
            const earlier = entries.get(key);

            entries.set(key, earlier ? { held: earlier.held, prompt: draftAfterUnsent(entry.prompt, earlier.prompt) } : entry);
        },
        take: (key: string): UnsentPrompt | undefined => {
            const entry = entries.get(key);

            entries.delete(key);

            return entry;
        },
    };
};

export type UnsentPrompts = ReturnType<typeof createUnsentPrompts>;

/** The app's one store: a screen keeps here what it can no longer show, and takes it back when it mounts. */
export const unsentPrompts = createUnsentPrompts();

/**
 * Gives a failed send's prompt back: to the screen (`apply`) while it is mounted, otherwise into `store` for the chat's
 * next mount ({@link restoreUnsentPrompt}).
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

/** On a chat screen's mount: the prompt kept while it was gone, back into its composer with its held send. */
export const restoreUnsentPrompt = ({ apply, key, store }: { apply: (entry: UnsentPrompt) => void; key: string; store: UnsentPrompts }): void => {
    const entry = store.take(key);

    if (entry) {
        apply(entry);
    }
};
