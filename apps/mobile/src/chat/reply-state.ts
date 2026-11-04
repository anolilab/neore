/** The part of a stored message the confirmation reads. */
export interface SeenMessage {
    id: string;
    role: string;
    status: string;
}

/**
 * Where the send's reply stands: `settled` when its newest reply has a final status, `pending` when the send is on the
 * pages read so far but its reply is not final (or not yet stored), and `unknown` when the send is not on them yet.
 */
export type ReplyState = "pending" | "settled" | "unknown";

const isFinal = (status: string): boolean => status === "success" || status === "failed";

/**
 * Reads the send's state from messages listed newest first, the order the server pages them in. Replies are placed by
 * that order, not by their creation times: messages can share a millisecond, and the clock is not the turn order. Only
 * a reply newer than the send counts: the list is walked from the newest message down to the send's own message.
 */
export const replyStateAfter = (newestFirst: ReadonlyArray<SeenMessage>, sentId: string): ReplyState => {
    let newestReply: SeenMessage | undefined;

    for (const message of newestFirst) {
        if (message.id === sentId) {
            if (newestReply === undefined) {
                return "pending";
            }

            return isFinal(newestReply.status) ? "settled" : "pending";
        }

        if (newestReply === undefined && message.role === "assistant") {
            newestReply = message;
        }
    }

    return "unknown";
};
