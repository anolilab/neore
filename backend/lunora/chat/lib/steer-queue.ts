/**
 * The steer queue on a `persistentStreams` row (`chat/steering.ts`), as pure
 * transitions. An entry is `queued` until the run takes it at a step boundary,
 * then `delivered` with its text dropped. A withdrawn entry keeps its id as a
 * text-free `withdrawn` marker, as does an id the client withdrew before the run
 * ever held it, so a `steerRun` that is retried or still in flight cannot queue
 * it afterwards.
 *
 * Each entry changes state exactly once, and every transition runs inside one
 * mutation on the stream's shard. So a take and a withdrawal of the same entry
 * are ordered: whichever runs first wins, and the other sees the result.
 */

export interface SteerEntry {
    id: string;
    /** The row the entry was delivered as. */
    messageId?: string;
    /** The run's pending row the delivery moved under `messageId`. */
    pendingMessageId?: string;
    status: "delivered" | "queued" | "withdrawn";
    text?: string;
}

/** Waiting at once: bounds the stream row (each text is up to `MAX_LENGTH.text`). */
export const MAX_QUEUED_STEERS = 3;

/** Over the whole run, delivered ones included, so the row stays small. */
export const MAX_STEERS_PER_RUN = 20;

/** `undefined` when the run already holds its maximum. */
export const queueSteer = (entries: ReadonlyArray<SteerEntry>, entry: { id: string; text: string }): SteerEntry[] | undefined => {
    const queued = entries.filter((item) => item.status === "queued").length;

    if (queued >= MAX_QUEUED_STEERS || entries.length >= MAX_STEERS_PER_RUN) {
        return undefined;
    }

    return [...entries, { id: entry.id, status: "queued", text: entry.text }];
};

/**
 * Every queued entry, as the ONE message the run receives (texts in the order
 * they were sent, a blank line apart), and `deliver(messageId, pendingMessageId)`: the queue with
 * them delivered as that row. `undefined` when nothing is queued.
 */
export const takeQueuedSteers = (
    entries: ReadonlyArray<SteerEntry>,
): { deliver: (messageId: string, pendingMessageId: string) => SteerEntry[]; ids: string[]; text: string } | undefined => {
    const queued = entries.filter((item) => item.status === "queued" && item.text);

    if (queued.length === 0) {
        return undefined;
    }

    return {
        deliver: (messageId, pendingMessageId) =>
            entries.map((item) => (item.status === "queued" ? { id: item.id, messageId, pendingMessageId, status: "delivered" } : item)),
        ids: queued.map((item) => item.id),
        text: queued.map((item) => item.text).join("\n\n"),
    };
};

/**
 * The row of the latest delivered steer: after it, the run's reply continues in
 * that row's order with it as the prompt. `undefined` for a run never steered.
 */
export const latestSteerMessageId = (entries: ReadonlyArray<SteerEntry> | undefined): string | undefined =>
    (entries ?? []).findLast((item) => item.status === "delivered" && item.messageId)?.messageId;

/** The pending row the latest delivery moved under its steered message (see `latestSteerMessageId`). */
export const latestSteerPendingId = (entries: ReadonlyArray<SteerEntry> | undefined): string | undefined =>
    (entries ?? []).findLast((item) => item.status === "delivered" && item.messageId)?.pendingMessageId;

/**
 * - `withdrawn`: it was still queued, and now never will be delivered.
 * - `delivered`: the run already took it.
 * - `unknown`: no such entry (the stream is gone, or the id was never queued).
 */
export type SteerWithdrawal = "delivered" | "unknown" | "withdrawn";

export const withdrawQueuedSteer = (
    entries: ReadonlyArray<SteerEntry>,
    id: string,
    { live = false }: { live?: boolean } = {},
): { changed: boolean; entries: SteerEntry[]; outcome: SteerWithdrawal } => {
    const entry = entries.find((item) => item.id === id);

    if (!entry) {
        // The call that would queue it may still be on its way (a restored chip, a request that outlived its
        // page): on a live run the id is closed for good. At the cap `queueSteer` refuses anyway.
        const marked = live && entries.length < MAX_STEERS_PER_RUN;

        return { changed: marked, entries: marked ? [...entries, { id, status: "withdrawn" }] : [...entries], outcome: "unknown" };
    }

    if (entry.status === "delivered") {
        return { changed: false, entries: [...entries], outcome: "delivered" };
    }

    if (entry.status === "withdrawn") {
        return { changed: false, entries: [...entries], outcome: "unknown" };
    }

    return { changed: true, entries: entries.map((item) => (item.id === id ? { id, status: "withdrawn" } : item)), outcome: "withdrawn" };
};

/**
 * The entries of a run that has ended, without the text of any that is still queued: nothing will take
 * it, and a message the user typed has no business staying on the row. The client still has the text and
 * sends it after `withdrawSteer` answers. `undefined` when there is nothing to drop.
 */
export const withoutQueuedText = (entries: ReadonlyArray<SteerEntry> | undefined): SteerEntry[] | undefined =>
    entries?.some((item) => item.text !== undefined) ? entries.map(({ text: _text, ...rest }) => rest) : undefined;

/** The ids the run has taken, for the client to retire their chips. */
export const deliveredSteerIds = (entries: ReadonlyArray<SteerEntry> | undefined): string[] =>
    (entries ?? []).filter((item) => item.status === "delivered").map((item) => item.id);
