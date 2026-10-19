import type { BranchNode, GroupType, ThreadGroup } from "./types";

/**
 * Determines the group type based on the thread group properties.
 */
export const getGroupType = (group: ThreadGroup): GroupType => {
    // Use groupType if available (preferred for i18n compatibility)
    if (group.groupType) {
        return group.groupType;
    }

    // Fallback: check projectId
    if (group.projectId) {
        return "project";
    }

    // Fallback: match against title (for backwards compatibility)
    // Note: This won't work correctly for non-English locales
    switch (group.title) {
        case "Archived": {
            return "archived";
        }
        case "Last 7 days": {
            return "last7days";
        }
        case "Last month": {
            return "lastMonth";
        }
        case "Pinned": {
            return "pinned";
        }
        case "Temporary": {
            return "temporary";
        }
        case "Today": {
            return "today";
        }
        default: {
            return "older";
        }
    }
};

/**
 * Checks if all threads in a group are selected.
 */
export const isGroupFullySelected = (groupThreadIds: string[], selectedThreadIds: Set<string>): boolean =>
    groupThreadIds.length > 0 && groupThreadIds.every((id) => selectedThreadIds.has(id));

/**
 * A one-line excerpt of `text` centred on the first case-insensitive match of
 * `query`, with ellipses where it was cut. Falls back to the text's start when
 * the query does not appear verbatim (full-text search matches on tokens).
 */
export const buildMatchSnippet = (text: string, query: string, radius: number = 40): string => {
    const flat = text.replaceAll(/\s+/g, " ").trim();
    const needle = query.trim().toLowerCase();
    const at = needle ? flat.toLowerCase().indexOf(needle) : -1;
    const start = at > radius ? at - radius : 0;
    const end = Math.min(flat.length, (at === -1 ? 0 : at + needle.length) + radius + (at === -1 ? radius : 0));

    return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
};

/** The `from` / `to` of the select-by-date control: `YYYY-MM-DD` from a native date input, or `""` when unset. */
export interface ThreadDateRange {
    from: string;
    to: string;
}

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` value as local midnight. `new Date("YYYY-MM-DD")` is UTC, a day off west of Greenwich. */
const parseLocalDay = (value: string): Date | undefined => {
    const match = ISO_DAY_RE.exec(value);

    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
};

/**
 * Threads whose last activity (`updatedAt`, else `createdAt`) falls on or between
 * the two calendar days, in local time. An unset bound is open, so `to` alone
 * means "before". With neither bound the result is empty: an empty range must
 * never select the whole list. Pinned threads are skipped; they are picked by hand.
 */
export const selectThreadIdsByDate = (
    threads: ReadonlyArray<Pick<BranchNode, "createdAt" | "isPinned" | "threadId" | "updatedAt">>,
    range: ThreadDateRange,
): string[] => {
    const from = parseLocalDay(range.from);
    const to = parseLocalDay(range.to);

    if (!from && !to) {
        return [];
    }

    // The `to` day is included whole: the bound is the start of the day after it.
    const toExclusive = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime() : undefined;

    return threads
        .filter((thread) => {
            if (thread.isPinned) {
                return false;
            }

            const lastActive = thread.updatedAt ?? thread.createdAt;

            return (from === undefined || lastActive >= from.getTime()) && (toExclusive === undefined || lastActive < toExclusive);
        })
        .map((thread) => thread.threadId);
};
