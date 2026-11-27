import type { View } from "@/features/types";

/** What the panel shows, and the account it was opened under. */
export interface AccountPanel {
    activeOrgId: string | null;
    userId: string | undefined;
    view: View;
}

export const THREADS_VIEW: View = { type: "threads" };

/**
 * What `userId` sees. A panel opened under another account (a sign-in from
 * another panel) is not theirs: its chat, the page context and quick prompt it
 * was seeded with, and the organization picked. They get the thread list
 * instead. A new grant for the same user keeps it all, and an open chat stays
 * mounted.
 */
export const panelFor = (panel: AccountPanel, userId: string | undefined): AccountPanel => {
    if (panel.userId === userId) {
        return panel;
    }

    return { activeOrgId: null, userId, view: THREADS_VIEW };
};

/**
 * The thread a new chat's first send created, for the chat `chatKey` that
 * sent it. A reply that lands after another chat opened leaves that chat alone.
 */
export const withCreatedThread = (panel: AccountPanel, chatKey: string, threadId: string): AccountPanel => {
    if (panel.view.type !== "chat" || panel.view.key !== chatKey) {
        return panel;
    }

    return { ...panel, view: { ...panel.view, threadId } };
};

/**
 * `subscribe`, applying what each request resolves to only while still
 * subscribed: a request answered after sign-out or another account's sign-in
 * (a settings read for a quick prompt) neither opens its chat nor touches the
 * notice for the next account.
 */
export const subscribeWhileCurrent = <T>(
    subscribe: (onRequest: (request: T) => void) => () => void,
    resolve: (request: T) => Promise<() => void>,
): (() => void) => {
    let current = true;
    const unsubscribe = subscribe((request) => {
        const apply = async () => {
            const update = await resolve(request);

            if (current) {
                update();
            }
        };

        void apply();
    });

    return () => {
        current = false;
        unsubscribe();
    };
};
