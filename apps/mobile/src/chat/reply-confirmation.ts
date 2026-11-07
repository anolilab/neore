import { isThreadRefusal } from "../offline/message-read";
import type { ReplyState, SeenMessage } from "./reply-state";
import { replyStateAfter } from "./reply-state";

/** Unsettled checks before the history is re-read once, so the server's copy shows while the checks go on. */
const CONFIRM_REFRESH_READS = 6;
/** Unsettled checks after which a send is no longer held: the composer opens while the checks go on. */
const CONFIRM_HOLD_READS = 15;
/** Unsettled checks after which a confirmation is given up; the final status is then left to the next read. */
const CONFIRM_GIVE_UP_READS = 150;
/** Pages read per check, newest first, before the send counts as not found: other sessions can push it back. */
const CONFIRM_MAX_PAGES = 5;

/** How far apart the follow-up checks are, after a reply that the relay did not confirm as complete. */
export const CONFIRM_READ_INTERVAL_MS = 2000;

/** A send whose reply is still being checked. `holdsSend` keeps the composer shut while the checks run. */
export interface Confirmation {
    holdsSend: boolean;
    messageId: string;
    /** The steer messages this send was given: its reply runs across them, and they are user messages. */
    steers: number;
    threadId: string;
}

/** One page of messages: the server lists its pages newest first, and each page is oldest first inside. */
export interface ConfirmPage {
    continueCursor: string | null;
    isDone: boolean;
    page: ReadonlyArray<{ id: string; role: string; status: string }>;
}

/** Reads one page of a thread's messages, from the newest page when the cursor is null. */
export type ConfirmPageFetch = (threadId: string, cursor: string | null) => Promise<ConfirmPage>;

/** What one round of checks decides: the replies that end, the ones that stop holding the composer, and whether to re-read. */
export interface CheckRound {
    ended: Set<string>;
    holdEnds: Set<string>;
    isRefreshDue: boolean;
}

/** Counts one more check for each reply, and sorts the replies by what this round of checks says. */
export const tallyChecks = (outcomes: ReadonlyArray<{ confirmation: Confirmation; state: ReplyState }>, reads: Map<string, number>): CheckRound => {
    const round: CheckRound = { ended: new Set(), holdEnds: new Set(), isRefreshDue: false };

    for (const { confirmation, state } of outcomes) {
        const count = (reads.get(confirmation.messageId) ?? 0) + 1;

        reads.set(confirmation.messageId, count);

        if (state === "settled" || count >= CONFIRM_GIVE_UP_READS) {
            round.ended.add(confirmation.messageId);
            reads.delete(confirmation.messageId);
            round.isRefreshDue = true;
        } else if (count === CONFIRM_HOLD_READS) {
            round.holdEnds.add(confirmation.messageId);
        } else if (count === CONFIRM_REFRESH_READS) {
            round.isRefreshDue = true;
        }
    }

    return round;
};

/** Reads the state of one send's reply: walks the pages from the newest until the send is found, up to `CONFIRM_MAX_PAGES`. */
export const readReplyState = async (
    fetchPage: ConfirmPageFetch,
    threadId: string,
    messageId: string,
    steers: number,
    isCurrent: () => boolean,
): Promise<ReplyState> => {
    const seen: SeenMessage[] = [];
    // eslint-disable-next-line unicorn/no-null -- the query takes null for its first page
    let cursor: string | null = null;
    let state: ReplyState = "unknown";

    for (let index = 0; index < CONFIRM_MAX_PAGES && isCurrent(); index += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the cursor of the one before it
        const page = await fetchPage(threadId, cursor);

        // `replyStateAfter` reads newest first; a page is oldest first inside, so it is reversed here.
        seen.push(
            ...page.page.toReversed().map((message) => {
                return { id: message.id, role: message.role, status: message.status };
            }),
        );
        state = replyStateAfter(seen, messageId, { steers });

        if (state !== "unknown" || page.isDone) {
            break;
        }

        cursor = page.continueCursor;
    }

    return state;
};

/** The state of one pending confirmation's reply in a round of checks, or that the chat can no longer be read. */
export interface ConfirmOutcome {
    confirmation: Confirmation;
    isChatRefused: boolean;
    state: ReplyState;
}

/**
 * Checks every pending confirmation of a thread in one round. Each walk starts from the newest page, so a page is
 * requested once per round, however many confirmations need it.
 */
export const readAllReplyStates = async (
    fetchPage: ConfirmPageFetch,
    threadId: string,
    confirmations: ReadonlyArray<Confirmation>,
    isCurrent: () => boolean,
): Promise<ConfirmOutcome[]> => {
    const pages = new Map<string, Promise<ConfirmPage>>();
    const sharedFetch: ConfirmPageFetch = (id, cursor) => {
        const key = `${id}:${cursor ?? ""}`;
        const known = pages.get(key) ?? fetchPage(id, cursor);

        pages.set(key, known);

        return known;
    };

    return await Promise.all(
        confirmations.map(async (confirmation) => {
            try {
                return { confirmation, isChatRefused: false, state: await readReplyState(sharedFetch, threadId, confirmation.messageId, confirmation.steers, isCurrent) };
            } catch (error) {
                // A chat the reader can no longer open ends the checks; any other failure is tried again on the next tick.
                return { confirmation, isChatRefused: isThreadRefusal(error), state: "unknown" as ReplyState };
            }
        }),
    );
};
