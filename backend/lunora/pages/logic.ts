/**
 * Pure rules behind the Pages workspace — no `ctx`, so each is unit-tested
 * directly (`logic.test.ts`).
 *
 * - the page TREE: a move may not make a page its own ancestor, and siblings
 *   are ordered by a fractional `order` so a move writes one row;
 * - VERSION grouping: a page keeps one snapshot per author per
 *   {@link VERSION_WINDOW_MS} window, overwritten in place while the window is
 *   open, so an autosave every 1.5 s does not become 40 versions a minute;
 * - PERMISSIONS: read < comment < write < admin, the owner always admin.
 */

/** Pages one user may own. A tree read loads them all, so this bounds that read. */
export const MAX_PAGES_PER_USER = 2000;

/** Pages removed by one delete (a page and its subtree). A deeper tree is refused rather than half-deleted. */
export const MAX_SUBTREE_DELETE = 500;

export const PAGE_TITLE_MAX = 200;

/** Serialized TipTap JSON, in characters. Roughly a 150-page document. */
export const PAGE_CONTENT_MAX = 600_000;

/** Snapshots kept per page; the oldest beyond this are pruned on write. */
export const MAX_VERSIONS_PER_PAGE = 200;

/** Consecutive edits by one author inside one window share a snapshot. */
export const VERSION_WINDOW_MS = 10 * 60 * 1000;

export const COMMENT_BODY_MAX = 5000;

/** Comments (roots + replies) one page may carry. */
export const MAX_COMMENTS_PER_PAGE = 1000;

export type PagePermission = "admin" | "comment" | "read" | "write";

const PERMISSION_LEVELS: Record<PagePermission, number> = { admin: 4, comment: 2, read: 1, write: 3 };

export const meetsPagePermission = (granted: PagePermission, required: PagePermission): boolean => PERMISSION_LEVELS[granted] >= PERMISSION_LEVELS[required];

// ─── Tree ────────────────────────────────────────────────────────────────────

/**
 * Whether moving `pageId` under `newParentId` would put it inside its own
 * subtree. Walks the new parent's ancestor chain through `parentOf`; a chain
 * that loops on its own (corrupt data) also counts as a cycle rather than
 * hanging.
 */
export const wouldCreateCycle = (pageId: string, newParentId: string | null | undefined, parentOf: ReadonlyMap<string, string | undefined>): boolean => {
    const seen = new Set<string>();
    let cursor: string | undefined = newParentId ?? undefined;

    while (cursor !== undefined) {
        if (cursor === pageId || seen.has(cursor)) {
            return true;
        }

        seen.add(cursor);
        cursor = parentOf.get(cursor);
    }

    return false;
};

/**
 * An `order` strictly between two neighbours; `undefined` means "no neighbour
 * on that side". Integers at the ends keep the common case (append) readable.
 */
export const orderBetween = (before: number | undefined, after: number | undefined): number => {
    if (before === undefined && after === undefined) {
        return 1;
    }

    if (before === undefined) {
        return (after as number) - 1;
    }

    if (after === undefined) {
        return Math.floor(before) + 1;
    }

    return (before + after) / 2;
};

/**
 * The `order` for a page placed at `index` among `siblings` (sorted ascending,
 * the moved page itself excluded). An index past the end appends.
 */
export const orderForIndex = (siblingOrders: ReadonlyArray<number>, index: number): number => {
    const clamped = Math.max(0, Math.min(index, siblingOrders.length));

    return orderBetween(siblingOrders[clamped - 1], siblingOrders[clamped]);
};

/** `pageId` and every page below it, breadth-first, `pageId` first. */
export const collectSubtree = (pageId: string, childrenOf: ReadonlyMap<string, ReadonlyArray<string>>): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    const queue = [pageId];

    while (queue.length > 0) {
        const current = queue.shift() as string;

        if (seen.has(current)) {
            continue;
        }

        seen.add(current);
        result.push(current);
        queue.push(...(childrenOf.get(current) ?? []));
    }

    return result;
};

// ─── Versions ────────────────────────────────────────────────────────────────

export type VersionReason = "agent" | "edit" | "restore";

export interface LatestVersion {
    authorId: string;
    createdAt: number;
    reason: VersionReason;
}

/** The start of the window `timestamp` falls in. */
export const versionWindowStart = (timestamp: number): number => Math.floor(timestamp / VERSION_WINDOW_MS) * VERSION_WINDOW_MS;

/**
 * Whether a save writes a new snapshot or folds into the latest one.
 *
 * - `insert` — a new snapshot row;
 * - `update` — overwrite the latest snapshot (same author, same window, both plain edits);
 *
 * An agent edit or a restore always gets its own row, so "undo what the AI did"
 * and "undo the restore" each have a version to go back to.
 */
export const snapshotAction = (latest: LatestVersion | null, input: { authorId: string; now: number; reason: VersionReason }): "insert" | "update" => {
    if (!latest || input.reason !== "edit" || latest.reason !== "edit") {
        return "insert";
    }

    if (latest.authorId !== input.authorId) {
        return "insert";
    }

    return versionWindowStart(latest.createdAt) === versionWindowStart(input.now) ? "update" : "insert";
};

// ─── Text ────────────────────────────────────────────────────────────────────

interface JsonNode {
    content?: unknown;
    text?: unknown;
    type?: unknown;
}

const BLOCK_SEPARATOR_TYPES = new Set([
    "blockquote",
    "bulletList",
    "codeBlock",
    "heading",
    "listItem",
    "orderedList",
    "paragraph",
    "table",
    "tableRow",
    "taskItem",
    "taskList",
]);

/** Plain text of a TipTap JSON document, blocks separated by newlines — for search and snippets. */
export const extractPlainText = (json: unknown): string => {
    const parts: string[] = [];

    const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") {
            return;
        }

        const { content, text, type } = node as JsonNode;

        if (typeof text === "string") {
            parts.push(text);
        }

        if (Array.isArray(content)) {
            for (const child of content) {
                walk(child);
            }
        }

        if (typeof type === "string" && BLOCK_SEPARATOR_TYPES.has(type)) {
            parts.push("\n");
        }
    };

    walk(json);

    return parts
        .join("")
        .replaceAll(/\n{2,}/g, "\n")
        .trim();
};

/** Up to `radius` characters either side of the first match of `query` in `text`, or `null`. */
export const searchSnippet = (text: string, query: string, radius = 60): string | null => {
    const index = text.toLowerCase().indexOf(query.toLowerCase());

    if (index === -1) {
        return null;
    }

    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + query.length + radius);

    return `${start > 0 ? "…" : ""}${text.slice(start, end).replaceAll("\n", " ")}${end < text.length ? "…" : ""}`;
};

// ─── Concurrency ─────────────────────────────────────────────────────────────

/** `LunoraError` data `code` for a save based on a stale revision. */
export const PAGE_REVISION_CONFLICT = "PAGE_REVISION_CONFLICT";

/**
 * Whether a save based on `baseRevision` would overwrite someone else's work.
 *
 * `revision` moves on every write; `contentRevision` only when more than comment
 * marks changed. A save whose base is behind only by comment activity (a thread
 * opened or deleted) is NOT a conflict: `writeContent` re-anchors open threads
 * by quote and strips marks of deleted ones, so nothing is lost. A base AHEAD of
 * the page is a client bug and is refused like a conflict.
 */
export const isRevisionConflict = (page: { contentRevision: number; revision: number }, baseRevision: number): boolean => {
    if (baseRevision === page.revision) {
        return false;
    }

    return baseRevision > page.revision || page.contentRevision > baseRevision;
};
