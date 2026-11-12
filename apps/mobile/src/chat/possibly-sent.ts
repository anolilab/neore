import { isNetworkFailure } from "../offline/connectivity";

/** How long after a send with no answer its prompt may still show up on the server. The gateway itself waits 15 s. */
export const POSSIBLY_SENT_WINDOW_MS = 60_000;

/** The waits between checks. The last one repeats until a check answers. */
export const CHECK_DELAYS_MS: ReadonlyArray<number> = [2000, 5000, 10_000, 20_000, 30_000];

/** How far the server's clock may run behind the phone's when a message's creation time is compared with the send. */
const CLOCK_SKEW_MS = 120_000;

/** Key of a send to a chat that had not started yet. */
export const NEW_CHAT_KEY = "new";

/**
 * A prompt that went out with no answer saying whether the server took it (a timeout, a dropped connection, a body that
 * would not parse). It stays here, not in the composer and not in the screen's rows, until a check of the server finds
 * it or the window passes without it.
 */
export interface PossiblySent {
    accountId: string;
    /** When the send failed: the window counts from here. */
    failedAt: number;
    id: string;
    /** Messages of the chat that were on screen before the send: none of them can be this prompt. */
    knownMessageIds: ReadonlySet<string>;
    prompt: string;
    /** When the send started: a message created before it (allowing for the clock skew) cannot be this prompt. */
    sentAt: number;
    /** `undefined` for the first message of a new chat. */
    threadId: string | undefined;
}

/** `pending` while the checks run; `unsent` once the window passed without the prompt, for the composer to take back. */
export type PossiblySentEntry = PossiblySent & { state: "pending" | "unsent" };

/** What one check found: the chat holding the prompt, no sign of it, or no answer from the server. */
export type CheckResult = { kind: "absent" } | { kind: "found"; threadId: string } | { kind: "unreachable" };

export interface SentMessage {
    createdAt: number;
    id: string;
    role: string;
    text: string;
}

/** Whether `messages` hold this prompt as a message created by this send. */
export const hasPrompt = (messages: ReadonlyArray<SentMessage>, entry: Pick<PossiblySent, "knownMessageIds" | "prompt" | "sentAt">): boolean =>
    messages.some(
        (message) =>
            message.role === "user"
            && message.text.trim() === entry.prompt
            && message.createdAt >= entry.sentAt - CLOCK_SKEW_MS
            && !entry.knownMessageIds.has(message.id),
    );

/**
 * One check of the server. A send to an existing chat reads that chat's newest messages. A first message reads the
 * newest chats in the list, and the newest messages of each one created since the send. Titles come from a model, so
 * only the prompt itself identifies the chat. A refusal is an answer (the prompt is not there); only a network failure
 * is no answer.
 */
export const checkPossiblySent = async (
    entry: PossiblySent,
    read: {
        newestMessages: (threadId: string) => Promise<SentMessage[]>;
        newestThreads: () => Promise<{ createdAt: number; id: string }[]>;
    },
): Promise<CheckResult> => {
    try {
        if (entry.threadId !== undefined) {
            return hasPrompt(await read.newestMessages(entry.threadId), entry) ? { kind: "found", threadId: entry.threadId } : { kind: "absent" };
        }

        const threads = await read.newestThreads();
        const candidates = threads.filter((thread) => thread.createdAt >= entry.sentAt - CLOCK_SKEW_MS);

        for (const thread of candidates) {
            // eslint-disable-next-line no-await-in-loop -- rarely more than one candidate; one read at a time keeps the load low
            if (hasPrompt(await read.newestMessages(thread.id), entry)) {
                return { kind: "found", threadId: thread.id };
            }
        }

        return { kind: "absent" };
    } catch (error) {
        return isNetworkFailure(error) ? { kind: "unreachable" } : { kind: "absent" };
    }
};

const keyOf = (threadId: string | undefined): string => threadId ?? NEW_CHAT_KEY;

/** The entries a chat's screen shows, or takes back, oldest first: for a new chat, `threadId` is `undefined`. */
export const entriesFor = (entries: ReadonlyArray<PossiblySentEntry>, accountId: string | undefined, threadId: string | undefined): PossiblySentEntry[] =>
    entries.filter((entry) => entry.accountId === accountId && keyOf(entry.threadId) === keyOf(threadId));

/**
 * The possibly-sent prompts of the signed-in account, in memory. Each is checked until the server shows it (the screen
 * of that chat, if open, opens or re-reads it) or until a check that answered after the window finds nothing: then it
 * waits as `unsent` for that chat's screen to put it back in the composer. A check with no answer never ends it, so an
 * offline phone keeps the prompt instead of giving back one that may have been sent.
 */
export const createPossiblySentStore = (options: {
    check: (entry: PossiblySent) => Promise<CheckResult>;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
}) => {
    const now = options.now ?? Date.now;
    const wait
        = options.wait
            ?? (async (ms: number) =>
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, ms);
                }));
    let entries: PossiblySentEntry[] = [];
    const listeners = new Set<() => void>();
    const foundListeners = new Set<(entry: PossiblySent, threadId: string) => void>();

    const set = (next: PossiblySentEntry[]): void => {
        entries = next;

        for (const listener of listeners) {
            listener();
        }
    };

    const isTracked = (id: string): boolean => entries.some((entry) => entry.id === id && entry.state === "pending");

    const run = async (entry: PossiblySent): Promise<void> => {
        let attempt = 0;

        while (isTracked(entry.id)) {
            // eslint-disable-next-line no-await-in-loop -- each check waits for the one before it
            await wait(CHECK_DELAYS_MS[Math.min(attempt, CHECK_DELAYS_MS.length - 1)] ?? 0);

            if (!isTracked(entry.id)) {
                return;
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            const result = await options.check(entry);

            if (!isTracked(entry.id)) {
                return;
            }

            if (result.kind === "found") {
                set(entries.filter((held) => held.id !== entry.id));

                for (const listener of foundListeners) {
                    listener(entry, result.threadId);
                }

                return;
            }

            attempt += 1;

            if (result.kind === "absent" && now() - entry.failedAt >= POSSIBLY_SENT_WINDOW_MS) {
                set(
                    entries.map((held) => {
                        if (held.id !== entry.id) {
                            return held;
                        }

                        return { ...held, state: "unsent" };
                    }),
                );

                return;
            }
        }
    };

    return {
        /** Everything is dropped at sign-out: the prompts are the account's. */
        clear: (): void => set([]),
        onFound: (listener: (entry: PossiblySent, threadId: string) => void): () => void => {
            foundListeners.add(listener);

            return () => foundListeners.delete(listener);
        },
        /** The current list, unchanged until something is added, resolved or taken (for `useSyncExternalStore`). */
        snapshot: (): ReadonlyArray<PossiblySentEntry> => entries,
        subscribe: (listener: () => void): () => void => {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
        /** Holds a prompt and starts checking for it. */
        track: (entry: PossiblySent): Promise<void> => {
            set([...entries, { ...entry, state: "pending" }]);

            return run(entry);
        },

        /**
         * Hands the chat's screen its prompts the checks did not find, oldest first, and drops them: now, and whenever
         * more come while it watches. A prompt of a screen that is not open waits for the screen to open.
         */
        watchUnsent: (accountId: string | undefined, threadId: string | undefined, onUnsent: (prompts: string[]) => void): () => void => {
            const hand = (): void => {
                const unsent = entriesFor(entries, accountId, threadId).filter((entry) => entry.state === "unsent");

                if (unsent.length > 0) {
                    const ids = new Set(unsent.map((entry) => entry.id));

                    set(entries.filter((entry) => !ids.has(entry.id)));
                    onUnsent(unsent.map((entry) => entry.prompt));
                }
            };

            listeners.add(hand);
            hand();

            return () => listeners.delete(hand);
        },
    };
};

export type PossiblySentStore = ReturnType<typeof createPossiblySentStore>;
