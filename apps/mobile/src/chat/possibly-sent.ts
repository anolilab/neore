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

/**
 * What one check found: the chat holding the prompt, proof that it is not there (every read answered and covered the
 * whole range the prompt could be in), or no proof either way (no answer, an error, or more pages than a check reads).
 */
export type CheckResult = { kind: "absent" } | { kind: "found"; threadId: string } | { kind: "inconclusive" };

/** A page of a paginated server read, newest first. */
export interface ReadPage<T> {
    continueCursor: string | null;
    isDone: boolean;
    page: T[];
}

/** Pages read per list in one check. A list longer than that proves nothing, so the check is inconclusive. */
export const MAX_CHECK_PAGES = 10;

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

export interface CheckReads {
    messages: (threadId: string, cursor: string | null) => Promise<ReadPage<SentMessage>>;
    threads: (cursor: string | null) => Promise<ReadPage<{ createdAt: number; id: string }>>;
}

/** Whether a chat holds the prompt, reading its messages newest first back to the send; `undefined` when the pages ran out first. */
const chatHoldsPrompt = async (entry: PossiblySent, threadId: string, read: CheckReads["messages"]): Promise<boolean | undefined> => {
    const since = entry.sentAt - CLOCK_SKEW_MS;
    // eslint-disable-next-line unicorn/no-null -- the server's pagination takes `null` for "from the start"
    let cursor: string | null = null;

    for (let pages = 0; pages < MAX_CHECK_PAGES; pages += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page continues the one before it
        const page = await read(threadId, cursor);

        if (hasPrompt(page.page, entry)) {
            return true;
        }

        // Newest first: a message from before the send means every later page is older still.
        if (page.isDone || page.page.some((message) => message.createdAt < since)) {
            return false;
        }

        cursor = page.continueCursor;
    }

    return undefined;
};

/** The first of the chats that holds the prompt, or a chat that ran out of pages; `undefined` when none holds it. */
const searchCandidates = async (entry: PossiblySent, threads: ReadonlyArray<{ id: string }>, read: CheckReads["messages"]): Promise<CheckResult | undefined> => {
    for (const thread of threads) {
        // eslint-disable-next-line no-await-in-loop -- rarely more than one candidate; one read at a time keeps the load low
        const holds = await chatHoldsPrompt(entry, thread.id, read);

        if (holds !== false) {
            return holds ? { kind: "found", threadId: thread.id } : { kind: "inconclusive" };
        }
    }

    return undefined;
};

/** The chat a first message started: every page of the list, since it is not ordered by creation time alone. */
const findNewChat = async (entry: PossiblySent, read: CheckReads): Promise<CheckResult> => {
    const since = entry.sentAt - CLOCK_SKEW_MS;
    // eslint-disable-next-line unicorn/no-null -- see `chatHoldsPrompt`
    let cursor: string | null = null;

    for (let pages = 0; pages < MAX_CHECK_PAGES; pages += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page continues the one before it
        const page = await read.threads(cursor);

        // eslint-disable-next-line no-await-in-loop -- each page continues the one before it
        const result = await searchCandidates(entry, page.page.filter((thread) => thread.createdAt >= since), read.messages);

        if (result !== undefined) {
            return result;
        }

        if (page.isDone) {
            return { kind: "absent" };
        }

        cursor = page.continueCursor;
    }

    return { kind: "inconclusive" };
};

/**
 * One check of the server. A send to an existing chat reads that chat's messages back to the send; a first message
 * reads the chat list and the messages of each chat created since the send (titles come from a model, so only the
 * prompt identifies the chat). Only reads that all answered and covered their range prove the prompt is absent; any
 * error proves nothing.
 */
export const checkPossiblySent = async (entry: PossiblySent, read: CheckReads): Promise<CheckResult> => {
    try {
        if (entry.threadId === undefined) {
            return await findNewChat(entry, read);
        }

        const holds = await chatHoldsPrompt(entry, entry.threadId, read.messages);

        if (holds === undefined) {
            return { kind: "inconclusive" };
        }

        return holds ? { kind: "found", threadId: entry.threadId } : { kind: "absent" };
    } catch {
        return { kind: "inconclusive" };
    }
};

/**
 * What a chat's screen does when a check found a prompt: nothing when the prompt is not this screen's, re-read an
 * existing chat, open the started chat when this new-chat screen is the one on screen, or, when it is not, leave the
 * chat to the list rather than change the route of the screen that is.
 */
export const foundAction = (
    entry: Pick<PossiblySent, "accountId" | "threadId">,
    screen: { accountId: string | undefined; isFocused: boolean; threadId: string | undefined },
): "ignore" | "leave-to-list" | "open" | "reload" => {
    if (entry.accountId !== screen.accountId || entry.threadId !== screen.threadId) {
        return "ignore";
    }

    if (entry.threadId !== undefined) {
        return "reload";
    }

    return screen.isFocused ? "open" : "leave-to-list";
};

const keyOf = (threadId: string | undefined): string => threadId ?? NEW_CHAT_KEY;

/** The entries a chat's screen shows, or takes back, oldest first: for a new chat, `threadId` is `undefined`. */
export const entriesFor = (entries: ReadonlyArray<PossiblySentEntry>, accountId: string | undefined, threadId: string | undefined): PossiblySentEntry[] =>
    entries.filter((entry) => entry.accountId === accountId && keyOf(entry.threadId) === keyOf(threadId));

/**
 * The possibly-sent prompts of the signed-in account, in memory. Each is checked until the server shows it (the screen
 * of that chat, if open, opens or re-reads it) or until a check that answered after the window finds nothing: then it
 * waits as `unsent` for that chat's screen to put it back in the composer. A check without proof never ends it, so an
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
    // Bumped at each sign-out: a send started before it must not hold its prompt after it.
    let session = 0;
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
        clear: (): void => {
            session += 1;
            set([]);
        },
        onFound: (listener: (entry: PossiblySent, threadId: string) => void): () => void => {
            foundListeners.add(listener);

            return () => foundListeners.delete(listener);
        },
        /** The sign-in a send starts in: pass it to `track` when the send settles. */
        session: (): number => session,
        /** The current list, unchanged until something is added, resolved or taken (for `useSyncExternalStore`). */
        snapshot: (): ReadonlyArray<PossiblySentEntry> => entries,
        subscribe: (listener: () => void): () => void => {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
        /** Holds a prompt and starts checking for it, unless the sign-in the send started in has ended since. */
        track: async (entry: PossiblySent, sentInSession: number): Promise<void> => {
            if (sentInSession !== session) {
                return;
            }

            set([...entries, { ...entry, state: "pending" }]);

            await run(entry);
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
