/**
 * Pure derivation for the thread minimap: one tick per user prompt, with a short
 * preview for its tooltip and accessible name.
 */

/** Below this many prompts the rail adds nothing and is not rendered. */
export const MINIMAP_MIN_PROMPTS = 3;

/** Longest preview kept, in characters, before it is cut with an ellipsis. */
export const MINIMAP_PREVIEW_CHARS = 80;

export interface MinimapItem {
    /** When the prompt was sent. Absent for outline entries (the server outline carries no time) and for rows without one. */
    createdAt?: number;
    id: string;
    /** Single-line prompt text, cut to {@link MINIMAP_PREVIEW_CHARS}. Empty for an attachment-only prompt. */
    preview: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The gap before a prompt, `3h` or (from a day up) `2d`. Only gaps of an hour or more get a label. */
export const minimapGapLabel = (previousAt: number | undefined, at: number | undefined): string | undefined => {
    if (previousAt === undefined || at === undefined) {
        return undefined;
    }

    const gap = at - previousAt;

    if (gap < HOUR_MS) {
        return undefined;
    }

    return gap >= DAY_MS ? `${Math.floor(gap / DAY_MS)}d` : `${Math.floor(gap / HOUR_MS)}h`;
};

const WHITESPACE_RE = /\s+/g;
// `[label](target)`: a prompt's attachment links keep their label and drop the target, which is markup to a reader.
// Each class excludes the delimiter after it, so the match cannot backtrack.
// eslint-disable-next-line sonarjs/super-linear-regex -- linear: see the comment above
const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\([^()\s]*\)/g;

export const toMinimapPreview = (text: string, maxChars: number = MINIMAP_PREVIEW_CHARS): string => {
    const flat = text.replaceAll(MARKDOWN_LINK_RE, "$1").replaceAll(WHITESPACE_RE, " ").trim();

    return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat;
};

/** The user prompts of a message list, in order. Callers pass the active branch path, so each prompt appears once. */
export const buildMinimapItems = (messages: ReadonlyArray<{ _creationTime?: number; id: string; role: string; text: string }>): MinimapItem[] =>
    messages
        .filter((message) => message.role === "user")
        .map((message) => {
            // Seeded and local rows can lack a creation time (see MessageTimestamp); formatting NaN would print "Invalid Date".
            const hasTime = Number.isFinite(message._creationTime) && (message._creationTime ?? 0) > 0;

            return { id: message.id, preview: toMinimapPreview(message.text), createdAt: hasTime ? message._creationTime : undefined };
        });

/**
 * Ids a prompt carries before the server names it. Sending replaces them, so they are
 * not a prompt that went missing.
 */
export const isProvisionalId = (id: string): boolean => id.startsWith("optimistic-") || id.startsWith("transitioning-");

/**
 * The loaded prompts, merged with the server outline. The outline is the newest run of
 * prompts, and the loaded window is a contiguous run too, so: loaded prompts before the
 * first one the outline shares are older than it and go ahead; loaded prompts after the
 * outline's own are prompts sent since it was read and go at the end. The outline is
 * `undefined` until it loads, and while the whole chat is loaded it is not asked for at all.
 */
export const mergeOutline = (outline: ReadonlyArray<{ id: string; text: string }> | undefined, loaded: ReadonlyArray<MinimapItem>): MinimapItem[] => {
    if (!outline || outline.length === 0) {
        return [...loaded];
    }

    const known = new Set(outline.map((entry) => entry.id));
    // The outline carries no times, so a prompt that is also loaded keeps the time the loaded copy has.
    const loadedTimes = new Map(loaded.map((item) => [item.id, item.createdAt]));
    const older = outline.map((entry) => {
        return { id: entry.id, preview: toMinimapPreview(entry.text), createdAt: loadedTimes.get(entry.id) };
    });
    const cut = loaded.findIndex((item) => known.has(item.id));

    if (cut === -1) {
        return [...older, ...loaded];
    }

    return [...loaded.slice(0, cut), ...older, ...loaded.slice(cut).filter((item) => !known.has(item.id))];
};

/**
 * Whether a prompt that was loaded is gone from the loaded list. Loading older pages and
 * sending a prompt only ADD ids; switching branch, editing a prompt or deleting one
 * REMOVES some, and the server outline (read once) then lists prompts that are off the path.
 */
export const promptsDropped = (previous: ReadonlySet<string>, current: ReadonlySet<string>): boolean => [...previous].some((id) => !current.has(id));

export const shouldShowMinimap = (items: ReadonlyArray<MinimapItem>): boolean => items.length >= MINIMAP_MIN_PROMPTS;
