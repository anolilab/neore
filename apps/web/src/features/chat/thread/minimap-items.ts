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

const defaultGapUnit = (value: number, unit: "day" | "hour"): string => `${value}${unit === "day" ? "d" : "h"}`;

/**
 * The gap before a prompt, `3h` or (from a day up) `2d`. Only gaps of an hour or more get a label.
 * `formatUnit` writes the number and its unit, so the rail can use the reader's language.
 */
export const minimapGapLabel = (
    previousAt: number | undefined,
    at: number | undefined,
    formatUnit: (value: number, unit: "day" | "hour") => string = defaultGapUnit,
): string | undefined => {
    if (previousAt === undefined || at === undefined) {
        return undefined;
    }

    const gap = at - previousAt;

    if (gap < HOUR_MS) {
        return undefined;
    }

    return gap >= DAY_MS ? formatUnit(Math.floor(gap / DAY_MS), "day") : formatUnit(Math.floor(gap / HOUR_MS), "hour");
};

const WHITESPACE_RE = /\s+/g;
// `[label](target)`: a prompt's attachment links keep their label and drop the target, which is markup to a reader.
// The label excludes `[` as well as `]`, so a failed match ends at the next opening bracket and a run of
// unmatched brackets is scanned once, not once per bracket.
// A target may hold balanced parentheses (`Function_(mathematics)`). Each alternative starts on a different character,
// so the target scan has no overlapping paths.
const MARKDOWN_LINK_RE = /\[((?:\\.|[^[\]\\\n])+)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+["'][^"'\n]*["'])?\)/g;
// A label may escape its brackets (`[report \[v2\].pdf]`); the preview shows the character, not the escape.
const LABEL_ESCAPE_RE = /\\(.)/g;

export const toMinimapPreview = (text: string, maxChars: number = MINIMAP_PREVIEW_CHARS): string => {
    const flat = text
        .replaceAll(MARKDOWN_LINK_RE, (_match, label: string) => label.replaceAll(LABEL_ESCAPE_RE, "$1"))
        .replaceAll(WHITESPACE_RE, " ")
        .trim();

    return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat;
};

/**
 * Ids a prompt carries before the server names it. Sending replaces them, so they are
 * not a prompt that went missing.
 */
export const isProvisionalId = (id: string): boolean => id.startsWith("optimistic-") || id.startsWith("transitioning-");

/** The newest prompt of a message list that the server has stored, or undefined. A provisional one cannot be scrolled to yet. */
export const lastPromptId = (messages: ReadonlyArray<{ id: string; role: string }>): string | undefined =>
    messages.findLast((message) => message.role === "user" && !isProvisionalId(message.id))?.id;

/** The user prompts of a message list, in order. Callers pass the active branch path, so each prompt appears once. */
export const buildMinimapItems = (messages: ReadonlyArray<{ _creationTime?: number; id: string; role: string; text: string }>): MinimapItem[] =>
    messages
        .filter((message) => message.role === "user")
        .map((message) => {
            // Seeded and local rows can lack a creation time (see MessageTimestamp); formatting NaN would print "Invalid Date".
            // A prompt still sending carries this device's clock; its time is the server's once it is stored, so it shows none until then.
            const hasTime = !isProvisionalId(message.id) && Number.isFinite(message._creationTime) && (message._creationTime ?? 0) > 0;

            return { id: message.id, preview: toMinimapPreview(message.text), createdAt: hasTime ? message._creationTime : undefined };
        });

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
    const loadedById = new Map(loaded.map((item) => [item.id, item]));
    // A prompt that is also loaded keeps its loaded copy: the outline text is cut short, and the copy has the send time.
    const older = outline.map((entry) => loadedById.get(entry.id) ?? { id: entry.id, preview: toMinimapPreview(entry.text), createdAt: undefined });
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
