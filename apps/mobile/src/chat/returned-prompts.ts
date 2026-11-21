import { useCallback, useSyncExternalStore } from "react";

/**
 * A prompt whose send did not go through, kept on the device until its person resends or discards it. It is its own item,
 * never merged into the composer. `clientMessageId` is the id the send used: a resend reuses it, so the server saves the
 * message once. It is `null` when the server said that id belongs to another request, so a resend takes a new one.
 */
export interface ReturnedPrompt {
    clientMessageId: string | null;
    id: string;
    prompt: string;
    /** Why the send failed, and whether it may have reached the server. */
    reason: string;
}

export interface ReturnedPrompts {
    /** Adds an item to the end of the chat's list, and returns its id. */
    add: (chat: string, item: Omit<ReturnedPrompt, "id">) => string;
    /** Drops every item: sign-out. */
    clear: () => void;
    /** The chat's items, oldest first. The same array until the chat's items change. */
    list: (chat: string) => ReadonlyArray<ReturnedPrompt>;
    remove: (chat: string, id: string) => void;
    subscribe: (listener: () => void) => () => void;
    update: (chat: string, id: string, patch: Partial<Omit<ReturnedPrompt, "id">>) => void;
    /** The item holding exactly this prompt: sending that text is a resend of it. */
    withPrompt: (chat: string, prompt: string) => ReturnedPrompt | undefined;
}

const NONE: ReadonlyArray<ReturnedPrompt> = [];

/**
 * The app's returned prompts, per chat key. They live outside any screen, so a prompt whose send failed while its chat was
 * left is still there when the chat is opened again. They do not outlive the app: nothing is written to storage.
 */
export const createReturnedPrompts = (): ReturnedPrompts => {
    const chats = new Map<string, ReadonlyArray<ReturnedPrompt>>();
    const listeners = new Set<() => void>();
    let counter = 0;

    const notify = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };
    const itemsOf = (chat: string): ReadonlyArray<ReturnedPrompt> => chats.get(chat) ?? NONE;
    const replace = (chat: string, items: ReadonlyArray<ReturnedPrompt>): void => {
        if (items.length === 0) {
            chats.delete(chat);
        } else {
            chats.set(chat, items);
        }

        notify();
    };

    return {
        add: (chat, item) => {
            counter += 1;

            const id = `returned-${counter}`;

            replace(chat, [...itemsOf(chat), { ...item, id }]);

            return id;
        },
        clear: () => {
            chats.clear();
            notify();
        },
        list: itemsOf,
        remove: (chat, id) => {
            replace(chat, itemsOf(chat).filter((item) => item.id !== id));
        },
        subscribe: (listener) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        update: (chat, id, patch) => {
            replace(
                chat,
                itemsOf(chat).map((item) => {
                    if (item.id !== id) {
                        return item;
                    }

                    return { ...item, ...patch };
                }),
            );
        },
        withPrompt: (chat, prompt) => itemsOf(chat).find((item) => item.prompt === prompt),
    };
};

/** The app's one store: the chat screen writes to it, and sign-out clears it. */
export const returnedPrompts = createReturnedPrompts();

/** The chat's returned prompts, as the screen shows them; it re-renders when they change. */
export const useReturnedPrompts = (store: ReturnedPrompts, chat: string): ReadonlyArray<ReturnedPrompt> => {
    const read = useCallback(() => store.list(chat), [store, chat]);

    return useSyncExternalStore(store.subscribe, read, read);
};
