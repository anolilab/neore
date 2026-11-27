import type { MessageRow } from "../offline/types";

/** A row on the chat screen; `finished` marks a local row whose send completed, which no server read has confirmed yet. */
export type ShownRow = MessageRow & { finished?: boolean };

/**
 * Adds each row's text from `texts` to the end of that row. Rows with no text in `texts` keep their identity, so a
 * memoised row component skips them; the array is only copied when some row changed.
 */
export const appendTexts = <R extends ShownRow>(rows: R[], texts: ReadonlyMap<string, string>): R[] => {
    if (texts.size === 0 || rows.every((row) => !texts.has(row.id))) {
        return rows;
    }

    return rows.map((row) => {
        const text = texts.get(row.id);

        if (text === undefined) {
            return row;
        }

        return { ...row, shareText: row.shareText + text, text: row.text + text };
    });
};

export interface ChunkBatcher {
    /** Queues `text` for the row `id`; the first chunk after a flush schedules the next one. */
    add: (id: string, text: string) => void;
    /** Stops listening to the send's abort signal: called once the reply has settled. */
    detach: () => void;
    /** Drops what is queued and the scheduled flush: for a send that was stopped. */
    discard: () => void;
    /** Applies what is queued now, in one update: before a steer starts a new row and when the reply ends. */
    flush: () => void;
}

/**
 * Collects streamed chunks and applies them at most once per frame. A reply arrives in many small deltas, often several
 * between two frames; each applied on its own would render the screen once per delta.
 */
export const createChunkBatcher = ({
    apply,
    cancelFrame,
    requestFrame,
    signal,
}: {
    apply: (texts: ReadonlyMap<string, string>) => void;
    cancelFrame: (handle: number) => void;
    requestFrame: (callback: () => void) => number;

    /**
     * The send's signal. A stopped send (leaving, sign-out, a refusal) writes nothing more: what is queued is dropped the
     * moment it stops, not at the next delta or when the stream settles, so a frame already scheduled applies nothing.
     */
    signal?: AbortSignal;
}): ChunkBatcher => {
    let pending = new Map<string, string>();
    let frame: number | undefined;

    const cancelScheduled = () => {
        if (frame === undefined) {
            return;
        }

        cancelFrame(frame);
        frame = undefined;
    };

    const flush = () => {
        cancelScheduled();

        if (pending.size === 0) {
            return;
        }

        const texts = pending;

        pending = new Map();
        apply(texts);
    };

    const discard = () => {
        cancelScheduled();
        pending = new Map();
    };

    signal?.addEventListener("abort", discard, { once: true });

    return {
        add: (id, text) => {
            if (text === "" || signal?.aborted === true) {
                return;
            }

            pending.set(id, (pending.get(id) ?? "") + text);
            frame ??= requestFrame(() => {
                frame = undefined;
                flush();
            });
        },
        detach: () => {
            signal?.removeEventListener("abort", discard);
        },
        discard,
        flush,
    };
};
