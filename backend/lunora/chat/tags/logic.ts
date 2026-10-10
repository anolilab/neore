/**
 * Pure rules for user-defined thread tags, kept apart from the procedures so
 * they are testable without a database.
 */

/** Palette keys a tag may carry. The web app maps each to its own classes. */
export const THREAD_TAG_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;

export type ThreadTagColor = (typeof THREAD_TAG_COLORS)[number];

export const THREAD_TAG_NAME_MAX_LENGTH = 32;

/** Per-user ceiling; also bounds the tag read that rides on the thread list. */
export const MAX_THREAD_TAGS_PER_USER = 50;

/** A thread carries at most this many tags. */
export const MAX_TAGS_PER_THREAD = 10;

const WHITESPACE_RUN_RE = /\s+/gu;

/** Trims and collapses internal whitespace, so "  a   b " and "a b" are the same tag. */
export const normalizeTagName = (name: string): string => name.replaceAll(WHITESPACE_RUN_RE, " ").trim();

/** Returns an error message, or `undefined` when the (already normalised) name is acceptable. */
export const validateTagName = (name: string): string | undefined => {
    if (name.length === 0) {
        return "Tag name cannot be empty";
    }

    if (name.length > THREAD_TAG_NAME_MAX_LENGTH) {
        return `Tag name cannot exceed ${THREAD_TAG_NAME_MAX_LENGTH} characters`;
    }

    return undefined;
};

/** Case-insensitive duplicate check against the caller's other tags. */
export const hasDuplicateTagName = (name: string, existing: ReadonlyArray<{ _id: string; name: string }>, ignoreId?: string): boolean => {
    const key = name.toLocaleLowerCase();

    return existing.some((tag) => tag._id !== ignoreId && tag.name.toLocaleLowerCase() === key);
};

/** Next `order` value: one past the current maximum, 0 for the first tag. */
export const nextTagOrder = (existing: ReadonlyArray<{ order: number }>): number =>
    existing.length === 0 ? 0 : Math.max(...existing.map((tag) => tag.order)) + 1;

/**
 * Returns the thread's tag ids with `tagId` added or removed. Duplicates are
 * dropped, and the input is never mutated.
 */
export const withTagAssignment = (tagIds: ReadonlyArray<string> | undefined, tagId: string, assigned: boolean): string[] => {
    const unique = tagIds ? [...new Set(tagIds)] : [];

    if (!assigned) {
        return unique.filter((id) => id !== tagId);
    }

    return unique.includes(tagId) ? unique : [...unique, tagId];
};

/**
 * Validates a full reorder request: it must name every one of the caller's
 * tags exactly once. Returns an error message, or `undefined` when valid.
 */
export const validateTagReorder = (requested: ReadonlyArray<string>, existingIds: ReadonlyArray<string>): string | undefined => {
    if (new Set(requested).size !== requested.length) {
        return "Tag order contains duplicates";
    }

    if (requested.length !== existingIds.length || existingIds.some((id) => !requested.includes(id))) {
        return "Tag order must list every tag exactly once";
    }

    return undefined;
};
