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
 * Reads the send's state from messages listed newest first, the order the server pages them in. The send's reply is
 * the assistant messages between the send and the next user message above it: a newer turn, from this session or
 * another, starts a new group. Within that group the newest step decides the state. Creation times play no part.
 */
export const replyStateAfter = (newestFirst: ReadonlyArray<SeenMessage>, sentId: string): ReplyState => {
    const sentIndex = newestFirst.findIndex((message) => message.id === sentId);

    if (sentIndex === -1) {
        return "unknown";
    }

    let newestStep: SeenMessage | undefined;

    // Walked from the send upward, so each assistant message read later is a newer step.
    for (const message of newestFirst.slice(0, sentIndex).toReversed()) {
        if (message.role === "user") {
            break;
        }

        if (message.role === "assistant") {
            newestStep = message;
        }
    }

    if (newestStep === undefined) {
        return "pending";
    }

    return isFinal(newestStep.status) ? "settled" : "pending";
};
