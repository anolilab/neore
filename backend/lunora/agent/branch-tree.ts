/**
 * In-thread branching: alternate replies and edited prompts, ChatGPT-style.
 *
 * A thread's messages form a tree, stored without a migration:
 *
 * - A row's parent is `parentMessageId` when that is set (`BRANCH_ROOT` = no
 *   parent), and otherwise the row immediately before it in `(order, stepOrder)`.
 *   Every row written before branching existed has no `parentMessageId`, so an
 *   old thread reads as one straight line — exactly what it displayed before.
 * - Only the FIRST row of a new branch carries an explicit parent: the first
 *   row of a regenerated reply (parent: the prompt), an edited user message
 *   (parent: the original's parent), and a user message sent while the thread
 *   is branched (parent: the active leaf). The rest of a reply's steps follow
 *   their predecessor implicitly.
 * - `threads.activeLeafMessageId` records where the user last pointed the
 *   switcher. The displayed path descends from it by LATEST child, so a reply
 *   that arrives after the switch is on the path without another write.
 *
 * Pure functions only. Requests are served by the incremental walk in
 * `branch-rows.ts`; `buildBranchTree` here is the whole-thread form, for a fork
 * and for a stored leaf that no longer exists. Both must agree on the parent
 * rule above.
 */

/** Stored in `parentMessageId` for a top-level sibling: an edit of the first prompt. */
export const BRANCH_ROOT = "root";

export interface BranchRow {
    _id: string;
    order: number;
    parentMessageId?: string | null;
    stepOrder: number;
}

/** Sibling position of a message that has alternatives, for the switcher UI. */
export interface MessageBranch {
    count: number;
    /** Zero-based position of this message among its siblings. */
    index: number;
    siblingIds: string[];
}

export interface BranchTree {
    /** Children in storage order, so the last one is the latest. `null` = top level. */
    childrenOf: (id: string | null) => ReadonlyArray<string>;
    has: (id: string) => boolean;
    /** `null` for a top-level row, `undefined` for an id not in the thread. */
    parentOf: (id: string) => string | null | undefined;
}

/** Storage position: `(order, stepOrder)`, ties broken by id. */
export const compareBranchRows = (a: BranchRow, b: BranchRow): number => a.order - b.order || a.stepOrder - b.stepOrder || a._id.localeCompare(b._id);

export const buildBranchTree = (rows: ReadonlyArray<BranchRow>): BranchTree => {
    const sortedRows = rows.toSorted(compareBranchRows);
    const position = new Map<string, number>();

    for (const [index, row] of sortedRows.entries()) {
        position.set(row._id, index);
    }

    const parents = new Map<string, string | null>();
    const children = new Map<string | null, string[]>();

    let previousId: string | null = null;

    for (const [index, row] of sortedRows.entries()) {
        const implicitParent = previousId;
        const explicit = row.parentMessageId;
        let parent: string | null;

        if (explicit === BRANCH_ROOT) {
            parent = null;
        } else if (explicit && (position.get(explicit) ?? Infinity) < index) {
            parent = explicit;
        } else {
            // Unset, deleted, or pointing forward (which could only form a
            // cycle): fall back to the previous row.
            parent = implicitParent;
        }

        parents.set(row._id, parent);
        previousId = row._id;

        const siblings = children.get(parent);

        if (siblings) {
            siblings.push(row._id);
        } else {
            children.set(parent, [row._id]);
        }
    }

    return {
        childrenOf: (id) => children.get(id) ?? [],
        has: (id) => parents.has(id),
        parentOf: (id) => parents.get(id),
    };
};

/** Follows the latest child from `fromId` (or from the top level, for `null`) down to a leaf. */
const descendToLeaf = (tree: BranchTree, fromId: string | null): string | null => {
    let current = fromId;

    for (;;) {
        const next = tree.childrenOf(current).at(-1);

        if (next === undefined) {
            return current;
        }

        current = next;
    }
};

/**
 * The displayed path, top first. A stored leaf that no longer exists (its
 * message was deleted) degrades to the latest path from the top, which for an
 * unbranched thread is simply every row.
 */
export const resolveActivePath = (tree: BranchTree, storedLeafId?: string | null): string[] => {
    const path: string[] = [];
    let current = descendToLeaf(tree, storedLeafId && tree.has(storedLeafId) ? storedLeafId : null);

    while (current !== null) {
        path.push(current);
        current = tree.parentOf(current) ?? null;
    }

    return path.toReversed();
};

/**
 * The `order` a tool-approval continuation writes into: a fresh one past every
 * row in the thread. `promptOrder + 1` alone collides when the paused reply is
 * on an older branch and a sibling branch already used that order.
 */
export const continuationOrder = (promptOrder: number, maxOrder: number | undefined): number => Math.max(promptOrder, maxOrder ?? -1) + 1;

export interface BranchParentInput {
    /** `threads.activeLeafMessageId`; unset for a thread that never branched. */
    activeLeafId?: string;
    /** Whether earlier saves already wrote into `overrideOrder`. */
    continuationHasRows: boolean;
    /** A parent the caller named — `saveEditedSibling`, a continuation's first save. */
    explicitParentId?: string;
    failPendingSteps?: boolean;
    firstRole?: string;
    /** Set for a continuation (tool approval), which owns a fresh `order`. */
    overrideOrder?: number;
    /** The first row patches an existing pending row instead of inserting one. */
    patchesPending: boolean;
    /** The prompt row, when `promptMessageId` resolved to one. */
    prompt?: { _id: string; role?: string } | null;
    promptMessageId?: string;
}

/**
 * The explicit `parentMessageId` for the first row `addMessagesHandler`
 * inserts, or `undefined` to follow the previous row. `loadLeafId` is only
 * called for a new prompt in a branched thread.
 */
export const resolveBranchParent = async (input: BranchParentInput, loadLeafId: () => Promise<string | undefined>): Promise<string | undefined> => {
    // A pending row's place in the tree was settled when it was inserted, and
    // only the FIRST row of a continuation carries its parent.
    if (input.patchesPending || (input.overrideOrder !== undefined && input.continuationHasRows)) {
        return undefined;
    }

    if (input.explicitParentId !== undefined) {
        return input.explicitParentId;
    }

    const { prompt } = input;

    if (prompt && (input.failPendingSteps || (input.overrideOrder === undefined && prompt.role !== "user"))) {
        // Either a fresh reply to an existing prompt (`failPendingSteps`) —
        // identical to the implicit parent when the prompt has no reply yet,
        // and what makes two replies siblings when it has one (regenerate) —
        // or a tool result answering an approval request, appended at the end
        // of an `order` that may already hold a sibling reply's rows.
        return prompt._id;
    }

    if (!input.promptMessageId && input.overrideOrder === undefined && input.firstRole === "user" && input.activeLeafId) {
        // A branched thread: the previous row may sit on another branch, so a
        // new prompt hangs off the leaf the user is looking at.
        return (await loadLeafId()) ?? BRANCH_ROOT;
    }

    return undefined;
};

export interface ForkPathRow {
    _id: string;
    order: number;
    role?: string;
}

/**
 * Where a fork at `target` ends, given the active path top first: the last
 * row it copies, and that message's position in the displayed list — what
 * `threadRelationships.branchPoint` records.
 *
 * `target` names a message as the UI shows it: an assistant message groups
 * every non-user row of one `order` (`toUIMessages`), so a fork at it keeps all
 * of its steps, not just the first row. `index` is the legacy form — a
 * position in the displayed message list. No target forks the whole path.
 * `undefined` when the target is not on the path, or the path is empty.
 */
export const forkEnd = (
    pathRows: ReadonlyArray<ForkPathRow>,
    target?: { index: number } | { messageId: string },
): { endId: string; index: number } | undefined => {
    const groups: ForkPathRow[][] = [];
    let previous: ForkPathRow | undefined;

    for (const row of pathRows) {
        const standalone = row.role === "user" || row.role === "system";
        const current = groups.at(-1);

        if (current && previous && !standalone && previous.role !== "user" && previous.role !== "system" && previous.order === row.order) {
            current.push(row);
        } else {
            groups.push([row]);
        }

        previous = row;
    }

    let index = groups.length - 1;

    if (target && "messageId" in target) {
        index = groups.findIndex((rows) => rows.some((row) => row._id === target.messageId));
    } else if (target) {
        ({ index } = target);
    }

    const endId = groups[index]?.at(-1)?._id;

    return endId === undefined ? undefined : { endId, index };
};
