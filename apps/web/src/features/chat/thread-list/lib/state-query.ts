import type { ThreadState } from "./derived-sections";

/** The `#` tags the command palette accepts, mapped to the state they filter on. */
const STATE_TAGS: ReadonlyMap<string, ThreadState> = new Map<string, ThreadState>([
    ["idle", "idle"],
    ["needs-you", "needsYou"],
    ["snoozed", "snoozed"],
    ["working", "working"],
]);

const WHITESPACE = /\s+/;

/** Working threads sort first, then the ones waiting for the owner; everything else keeps its order. */
const STATE_RANK: Readonly<Record<ThreadState, number>> = { idle: 2, needsYou: 1, other: 2, snoozed: 2, working: 0 };

/**
 * Reads a leading state tag from the palette's input: `#working fix` filters to running threads and searches the
 * rest. An unknown tag is ordinary text, so the palette still finds a thread whose title starts with `#`.
 */
export const parseStateQuery = (query: string): { state: ThreadState | undefined; text: string } => {
    const trimmed = query.trim();
    const [head = "", ...rest] = trimmed.slice(1).split(WHITESPACE);
    const state = trimmed.startsWith("#") ? STATE_TAGS.get(head.toLowerCase()) : undefined;

    if (state === undefined) {
        return { state: undefined, text: trimmed };
    }

    return { state, text: rest.join(" ") };
};

/** Working first, then waiting for the owner, then the rest. Stable: equal ranks keep their order. */
export const compareByStateRank = (a: { state: ThreadState }, b: { state: ThreadState }): number => STATE_RANK[a.state] - STATE_RANK[b.state];
