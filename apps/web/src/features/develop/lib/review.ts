import type { HostCapabilityKey } from "@neore/backend/source-control/capabilities";
import type { DiffSide, ReviewThread, ReviewVerdict, ViewedState } from "@neore/backend/source-control/types";

/** The verdicts a person may give, each behind the capability that offers it: one the host lacks is not shown. */
export const VERDICT_CAPABILITIES: Record<ReviewVerdict, HostCapabilityKey> = {
    approve: "review.verdictApprove",
    comment: "review.verdictComment",
    request_changes: "review.verdictRequestChanges",
};

export const lineKey = (side: DiffSide, line: number): string => `${side}:${line}`;

/** Where a thread sits in its file's diff; `null` for one that no longer points at a line of it. */
export const threadLineKey = (thread: Pick<ReviewThread, "line" | "side">): string | null => (thread.line === null ? null : lineKey(thread.side, thread.line));

/** `items` by the line they belong to; an item with no line is left out. */
export const groupByLine = <T>(items: ReadonlyArray<T>, keyOf: (item: T) => string | null): Map<string, T[]> => {
    const groups = new Map<string, T[]>();

    for (const item of items) {
        const key = keyOf(item);

        if (key !== null) {
            groups.set(key, [...(groups.get(key) ?? []), item]);
        }
    }

    return groups;
};

/** The threads of a file that sit on no line of the diff shown: outdated by a newer commit, or on a line the patch cut off. */
export const unplacedThreads = (threads: ReadonlyArray<ReviewThread>, placed: ReadonlySet<string>): ReviewThread[] =>
    threads.filter((thread) => {
        const key = threadLineKey(thread);

        return key === null || !placed.has(key);
    });

export const countViewed = (paths: ReadonlyArray<string>, states: ReadonlyMap<string, ViewedState>): number =>
    paths.filter((path) => states.get(path) === "viewed").length;

interface ViewedPage {
    files?: ReadonlyArray<{ path: string; state: ViewedState }>;
    status: string;
}

/** The viewed state of every file the pages that loaded name, by path. A page that failed names none. */
export const viewedStatesOf = (pages: ReadonlyArray<ViewedPage>): Map<string, ViewedState> =>
    new Map(pages.flatMap((page) => (page.status === "ok" ? (page.files ?? []).map((file) => [file.path, file.state] as const) : [])));
