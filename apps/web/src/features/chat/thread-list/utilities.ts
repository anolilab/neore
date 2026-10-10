import type { GroupType, ThreadGroup } from "./types";

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
