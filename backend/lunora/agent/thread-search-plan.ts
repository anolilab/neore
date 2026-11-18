/**
 * Palette search by meaning (plan C6): which texts of a thread are embedded, when
 * they are embedded again, and how a query's matches become threads. Pure: no
 * ctx, no I/O, so the rules are tested directly (`thread-search-plan.test.ts`).
 *
 * What is embedded. Two vectors per thread, one for its title and one for its
 * summary, in the `embeddings_1024` table that knowledge and memory share
 * (bge-m3). Their `table` is `threadTitle` / `threadSummary`, and their ids sit on
 * the thread row (`titleVectorId`, `summaryVectorId`), so the row says what is
 * stored. Both ids are internal: `publicThread` and the export leave them out.
 *
 * Who is embedded. A thread with MORE than {@link MIN_TURNS_TO_EMBED} user turns,
 * that is not locked, deleted or temporary. A locked thread's title is its
 * content, so it never reaches the index.
 *
 * When it is embedded again. Only a kind whose text moved is embedded again. A
 * lock, delete, restore or temporary flip re-checks both kinds. A reply re-checks
 * a thread still missing a vector, since it may only now have crossed the turn gate.
 */
import { omit } from "../lib/collections";
import { getVectorIndexName } from "./vector/tables";

export const SEARCH_MODEL = "bge-m3";
/** bge-m3 is 1024-dimensional: the table is `embeddings_1024`, its index `embeddings-1024`. */
export const SEARCH_DIMENSION = 1024 as const;
export const SEARCH_INDEX = getVectorIndexName(SEARCH_DIMENSION);

/** The `table` field of each vector row, which the search filters on together with the owner. */
export const SEARCH_TABLE = { summary: "threadSummary", title: "threadTitle" } as const;
/** The thread field holding each kind's vector id. */
export const SEARCH_VECTOR_FIELD = { summary: "summaryVectorId", title: "titleVectorId" } as const;

export type SearchKind = keyof typeof SEARCH_TABLE;
export const SEARCH_KINDS: ReadonlyArray<SearchKind> = ["title", "summary"];

/** A thread is embedded only once it has MORE than this many user turns (plan section 7, decision 3). */
export const MIN_TURNS_TO_EMBED = 3;
/** Messages read at most when counting a thread's turns. */
export const TURN_SCAN_LIMIT = 400;

/** Nearest vectors read per kind for one query. */
export const MEANING_TOP_K = 10;
/** Threads the palette takes from a meaning query. */
export const MEANING_RESULT_LIMIT = 10;
/**
 * Cosine score a vector must reach to count as a meaning match. Not calibrated on
 * production data yet; the acceptance test uses a fixed fake embedder.
 */
export const MEANING_MIN_SCORE = 0.5;
/** Shorter queries are too vague to embed usefully. */
export const MEANING_MIN_CHARS = 3;

/** The thread fields this module reads. A `threads` row satisfies it. */
export interface SearchRow {
    deleted?: boolean;
    isTemporary?: boolean;
    lastReplyAt?: number;
    lockedAt?: number | null;
    summary?: string;
    summaryVectorId?: string;
    title?: string;
    titleVectorId?: string;
    userId?: string;
}

/** A stored text and the vector embedded from it, if any. */
export interface SearchSlot {
    text?: string;
    vectorId?: string;
}

/** The text as it is embedded: trimmed, and absent when empty. */
export const searchText = (value: string | null | undefined): string | undefined => {
    const trimmed = value?.trim();

    return trimmed || undefined;
};

/** Whether the thread may be in the index at all (the turn gate is checked separately). */
export const isSearchEligible = (row: SearchRow): boolean =>
    row.userId !== undefined && !row.deleted && !row.isTemporary && (row.lockedAt === undefined || row.lockedAt === null);

/** Whether a thread has MORE than {@link MIN_TURNS_TO_EMBED} user turns. */
export const hasEnoughTurns = (userTurns: number): boolean => userTurns > MIN_TURNS_TO_EMBED;

/** The user turns among a thread's message rows; a row's `message` is the AI SDK message. */
export const countUserTurns = (rows: ReadonlyArray<{ message?: unknown }>): number =>
    rows.filter((row) => (row.message as { role?: unknown } | undefined)?.role === "user").length;

const kindTexts = (row: SearchRow): Record<SearchKind, string | undefined> => {
    return {
        summary: searchText(row.summary),
        title: searchText(row.title),
    };
};

/**
 * Which kinds a write changed, so the sync re-embeds only those. An empty list
 * means the write needs no sync. Called from the threads triggers.
 *
 * - An insert: each kind that has text.
 * - Eligibility flipping (lock, delete, restore, temporary): both kinds, so the
 *   sync adds or removes the vectors.
 * - A reply on an eligible thread: each kind with text but no vector yet, so a
 *   thread that just crossed the turn gate gets its vectors. Bounded: a kind with
 *   a vector is never named by a reply.
 */
export const searchKindsChanged = (previous: SearchRow | undefined, next: SearchRow): SearchKind[] => {
    const changed = new Set<SearchKind>();
    const nextTexts = kindTexts(next);

    if (previous === undefined) {
        for (const kind of SEARCH_KINDS) {
            if (nextTexts[kind] !== undefined) {
                changed.add(kind);
            }
        }

        return SEARCH_KINDS.filter((kind) => changed.has(kind));
    }

    const previousTexts = kindTexts(previous);

    if (isSearchEligible(previous) !== isSearchEligible(next)) {
        for (const kind of SEARCH_KINDS) {
            changed.add(kind);
        }
    }

    for (const kind of SEARCH_KINDS) {
        if (previousTexts[kind] !== nextTexts[kind]) {
            changed.add(kind);
        }
    }

    if (previous.lastReplyAt !== next.lastReplyAt && isSearchEligible(next)) {
        for (const kind of SEARCH_KINDS) {
            if (nextTexts[kind] !== undefined && next[SEARCH_VECTOR_FIELD[kind]] === undefined) {
                changed.add(kind);
            }
        }
    }

    return SEARCH_KINDS.filter((kind) => changed.has(kind));
};

export interface SearchState {
    eligible: boolean;
    slots: Record<SearchKind, SearchSlot>;
}

export interface SearchPlan {
    /** Stored vectors to delete. The commit deletes one only while it is still the stored one. */
    clear: { kind: SearchKind; vectorId: string }[];
    /** Kinds to embed now. Each has text in the state. */
    embed: SearchKind[];
}

/**
 * What a sync does for a thread. `changed` are the kinds whose text moved since
 * the last sync. A stored vector is kept only while its text is unchanged and the
 * thread is still wanted.
 */
export const planThreadSearch = (state: SearchState, changed: ReadonlyArray<SearchKind>, enoughTurns: boolean): SearchPlan => {
    const embed: SearchKind[] = [];
    const clear: SearchPlan["clear"] = [];

    for (const kind of SEARCH_KINDS) {
        const { text, vectorId } = state.slots[kind];
        const wanted = state.eligible && enoughTurns && text !== undefined;
        const moved = changed.includes(kind);

        if (wanted && (moved || vectorId === undefined)) {
            embed.push(kind);
        }

        if (vectorId !== undefined && (!wanted || moved)) {
            clear.push({ kind, vectorId });
        }
    }

    return { clear, embed };
};

/** A vector the sync just wrote, with the text it embeds. */
export interface EmbeddedVector {
    kind: SearchKind;
    text: string;
    vectorId: string;
}

export interface CommitDecision {
    /** Vector ids now stored on the thread. */
    accepted: string[];
    /** Vector ids to delete: superseded, or cleared. */
    replaced: string[];
    /** The thread's vector id per kind after the commit; `undefined` removes it. */
    set: Partial<Record<SearchKind, string | undefined>>;
}

/**
 * The commit's decision, against the thread as it is now. A vector whose text no
 * longer matches the thread is not accepted (a newer write queued its own sync).
 * A stored vector is cleared only while it is still the one the plan read.
 */
export const decideCommit = (stored: Record<SearchKind, SearchSlot>, embedded: ReadonlyArray<EmbeddedVector>, clear: SearchPlan["clear"]): CommitDecision => {
    const accepted: string[] = [];
    const replaced: string[] = [];
    const set: CommitDecision["set"] = {};

    for (const vector of embedded) {
        const current = stored[vector.kind];

        if (searchText(current.text) !== vector.text) {
            continue;
        }

        if (current.vectorId !== undefined && current.vectorId !== vector.vectorId) {
            replaced.push(current.vectorId);
        }

        set[vector.kind] = vector.vectorId;
        accepted.push(vector.vectorId);
    }

    for (const { kind, vectorId } of clear) {
        if (set[kind] !== undefined) {
            continue;
        }

        if (stored[kind].vectorId === vectorId) {
            replaced.push(vectorId);
            set[kind] = undefined;
        }
    }

    return { accepted, replaced, set };
};

/**
 * The threads the meaning matches point at, best first. A thread keeps its best
 * score over its title and summary matches; matches below `minScore` are dropped.
 */
export const bestMeaningThreadIds = (
    matches: ReadonlyArray<{ score: number; threadId: string }>,
    minScore: number,
    limit: number,
): { score: number; threadId: string }[] => {
    const best = new Map<string, number>();

    for (const match of matches) {
        if (match.score < minScore) {
            continue;
        }

        best.set(match.threadId, Math.max(best.get(match.threadId) ?? -Infinity, match.score));
    }

    return [...best]
        .map(([threadId, score]) => {
            return { score, threadId };
        })
        .toSorted((a, b) => b.score - a.score || a.threadId.localeCompare(b.threadId))
        .slice(0, limit);
};

/** The vector ids are derived data: an export of the thread carries none of them. */
export const withoutSearchVectors = <T extends object>(thread: T): Omit<T, "summaryVectorId" | "titleVectorId"> =>
    omit(thread as Record<string, unknown>, ["summaryVectorId", "titleVectorId"]) as Omit<T, "summaryVectorId" | "titleVectorId">;
