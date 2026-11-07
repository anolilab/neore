import { useSyncExternalStore } from "react";

/**
 * Every title save from the chat screens numbers itself here: the thread list's rename dialog and the header's title editor
 * alike, so "newest" means the same to both. The title a thread shows is the title of its newest save still in effect. A
 * header save is in effect while it is pending (it shows at once); a list rename is in effect once it has succeeded; a
 * failed save drops out, so a failure only ever removes its own title.
 *
 * Title writes to the server go one at a time per thread, in the order they were sent (`queueTitleWrite`), so the server ends
 * on the newest save. The header and the thread list both read their title through `titleOnScreen`, and re-render on every
 * change here (`useTitleSaveRevision`), so they show one title whichever of them has its server copy first.
 */

type TitleSave = {
    optimistic: boolean;
    order: number;
    saved: boolean;
    title: string;
};

type ThreadTitleSaves = {
    /** The server's title before the saves of this run. */
    baseline: string;
    saves: TitleSave[];
};

/** How long a title write waits for the one before it. A write that never answers must not hold the thread's later writes. */
const WRITE_WAIT_MS = 15_000;

const sequence = { last: 0 };
const threads = new Map<string, ThreadTitleSaves>();
const writeQueues = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const revision = { count: 0 };

const announce = (): void => {
    revision.count += 1;

    for (const listener of listeners) {
        listener();
    }
};

/** The number of changes so far: a reader compares it to re-render when a save begins or settles. */
export const titleSaveRevision = (): number => revision.count;

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

/** No saves are made while the server renders, so its snapshot is the count at that point (the first). */
const getServerRevision = (): number => 0;

/** Re-renders the caller whenever a save begins or settles, including one that writes no metadata. */
export const useTitleSaveRevision = (): number => useSyncExternalStore(subscribe, titleSaveRevision, getServerRevision);

/** The title of the newest save in effect, or the baseline when none is. */
const titleInEffect = (thread: ThreadTitleSaves): string => thread.saves.findLast((save) => save.saved || save.optimistic)?.title ?? thread.baseline;

/**
 * Numbers a save that is about to be sent, and returns its order. `shownTitle` is the title the thread shows now. It becomes the
 * baseline when no other save is pending, so a title changed outside these writers is respected. An `optimistic` save shows its
 * title before the server answers.
 */
export const beginTitleSave = (threadId: string, title: string, shownTitle: string, optimistic: boolean): number => {
    sequence.last += 1;

    const current = threads.get(threadId);
    const pending = current?.saves.some((save) => !save.saved) ?? false;
    const thread = current && pending ? current : { baseline: shownTitle, saves: [] };

    thread.saves.push({ optimistic, order: sequence.last, saved: false, title });
    threads.set(threadId, thread);
    announce();

    return sequence.last;
};

/**
 * Settles the save with `order` and returns the title the thread shows now. A save that is no longer tracked (it was superseded
 * by a newer saved one) changes nothing, so the title shown stays as it is. `undefined` for a thread with no saves at all.
 */
export const settleTitleSave = (threadId: string, order: number, outcome: "failed" | "saved"): string | undefined => {
    const thread = threads.get(threadId);

    if (!thread) {
        return undefined;
    }

    thread.saves =
        outcome === "saved"
            ? thread.saves.map((save) => (save.order === order ? { ...save, saved: true } : save))
            : thread.saves.filter((save) => save.order !== order);

    // A saved save stays on top of any older one, so saves below the newest saved one can never show again.
    const newestSaved = Math.max(0, ...thread.saves.filter((save) => save.saved).map((save) => save.order));

    thread.saves = thread.saves.filter((save) => save.order >= newestSaved);
    announce();

    return titleInEffect(thread);
};

/**
 * The title a thread shows on screen, from the server's `serverTitle`. While this client's saves are in effect their newest title
 * wins, so two overlapping renames read the same in the header and in the list whatever order the server applied them in.
 *
 * Three cases take the server's title instead: a pending save the server has already applied; a title that is none of this
 * client's (the baseline or one of its saves), changed elsewhere; and nothing in effect. Once the server shows the saved title with
 * no save pending, the thread's entry is dropped: the server is authoritative from then on, so a later title it holds (a rename
 * back to the old title, say) shows. A reader that still holds an older copy of the server title shows that copy until it refreshes.
 */
export const titleOnScreen = (threadId: string, serverTitle: string | undefined): string | undefined => {
    const thread = threads.get(threadId);

    if (!thread) {
        return serverTitle;
    }

    if (serverTitle === undefined) {
        return titleInEffect(thread);
    }

    // A pending save the server has already applied shows its title, unless a newer header edit is pending: that edit is on screen.
    const matching = thread.saves.findLast((save) => !save.saved && save.title === serverTitle);
    const newerOptimisticPending = matching !== undefined && thread.saves.some((save) => save.optimistic && !save.saved && save.order > matching.order);

    if (matching !== undefined && !newerOptimisticPending) {
        return serverTitle;
    }

    const ours = [thread.baseline, ...thread.saves.map((save) => save.title)];

    if (!ours.includes(serverTitle)) {
        return serverTitle;
    }

    const shown = titleInEffect(thread);

    if (thread.saves.every((save) => save.saved) && serverTitle === shown) {
        threads.delete(threadId);
    }

    return shown;
};

/**
 * Sends a title write once the thread's earlier writes have answered (or the wait has run out), so the server applies them in the
 * order they were sent. An earlier write that failed does not hold the later ones back.
 */
export const queueTitleWrite = <T>(threadId: string, write: () => Promise<T>): Promise<T> => {
    const previous = writeQueues.get(threadId) ?? Promise.resolve();
    const waited = new Promise<void>((resolve) => {
        setTimeout(resolve, WRITE_WAIT_MS);
    });
    const result = Promise.race([previous, waited]).then(write);

    writeQueues.set(
        threadId,
        result.catch(() => undefined).then(() => undefined),
    );

    return result;
};
