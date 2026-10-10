/**
 * The flat `listPageTree.owned` rows as a nested tree, and the moves the tree
 * UI offers. Pure, so the ordering and the "can this move?" rules are tested
 * without a DOM (`page-tree.test.ts`). The server re-checks every move
 * (`backend/lunora/pages/logic.ts#wouldCreateCycle`); this only keeps the UI
 * from offering one that would be refused.
 */

export interface FlatPage {
    _id: string;
    icon: string | null;
    isFavorite: boolean;
    isPublic: boolean;
    order: number;
    parentPageId: string | null;
    title: string;
    updatedAt: number;
}

export interface PageNode extends FlatPage {
    children: PageNode[];
    depth: number;
}

/**
 * Nests pages under their parents, siblings by `order`. A page whose parent is
 * missing (deleted concurrently) is shown at the top level rather than lost.
 */
export const buildPageTree = (pages: ReadonlyArray<FlatPage>): PageNode[] => {
    const ids = new Set(pages.map((page) => page._id));
    const byParent = new Map<string | null, FlatPage[]>();

    for (const page of pages) {
        const parent = page.parentPageId && ids.has(page.parentPageId) ? page.parentPageId : null;

        byParent.set(parent, [...(byParent.get(parent) ?? []), page]);
    }

    const build = (parentId: string | null, depth: number, seen: Set<string>): PageNode[] =>
        (byParent.get(parentId) ?? [])
            .toSorted((a, b) => a.order - b.order)
            .filter((page) => !seen.has(page._id))
            .map((page) => {
                const nextSeen = new Set(seen).add(page._id);

                return { ...page, children: build(page._id, depth + 1, nextSeen), depth };
            });

    return build(null, 0, new Set());
};

/** Whether `candidateId` is `pageId` itself or somewhere below it. */
export const isInSubtree = (pages: ReadonlyArray<FlatPage>, pageId: string, candidateId: string): boolean => {
    const parentOf = new Map(pages.map((page) => [page._id, page.parentPageId]));
    const seen = new Set<string>();
    let cursor: string | null | undefined = candidateId;

    while (cursor) {
        if (cursor === pageId) {
            return true;
        }

        if (seen.has(cursor)) {
            return true;
        }

        seen.add(cursor);
        cursor = parentOf.get(cursor) ?? null;
    }

    return false;
};

export interface MoveTarget {
    index: number;
    parentPageId: string | null;
}

const siblingsOf = (pages: ReadonlyArray<FlatPage>, parentPageId: string | null): FlatPage[] =>
    pages.filter((page) => page.parentPageId === parentPageId).toSorted((a, b) => a.order - b.order);

/**
 * The keyboard/menu moves for one page. Each is `null` when it does not apply
 * (first sibling cannot move up, a top-level page cannot outdent, …). Indexes
 * are among the NEW siblings with the moved page excluded — what `movePage`
 * expects.
 */
export const menuMoves = (
    pages: ReadonlyArray<FlatPage>,
    pageId: string,
): { down: MoveTarget | null; indent: MoveTarget | null; outdent: MoveTarget | null; up: MoveTarget | null } => {
    const page = pages.find((candidate) => candidate._id === pageId);

    if (!page) {
        return { down: null, indent: null, outdent: null, up: null };
    }

    const siblings = siblingsOf(pages, page.parentPageId);
    const position = siblings.findIndex((sibling) => sibling._id === pageId);
    const previous = siblings[position - 1];
    const parent = page.parentPageId ? pages.find((candidate) => candidate._id === page.parentPageId) : undefined;

    return {
        down: position < siblings.length - 1 ? { index: position + 1, parentPageId: page.parentPageId } : null,
        // Under the previous sibling, as its last child.
        indent: previous ? { index: siblingsOf(pages, previous._id).length, parentPageId: previous._id } : null,
        // Right after the parent, among the parent's siblings.
        outdent: parent
            ? {
                  index: siblingsOf(pages, parent.parentPageId).findIndex((sibling) => sibling._id === parent._id) + 1,
                  parentPageId: parent.parentPageId,
              }
            : null,
        up: position > 0 ? { index: position - 1, parentPageId: page.parentPageId } : null,
    };
};

/**
 * Dropping `pageId` relative to `targetId`: `inside` makes it the target's last
 * child; `before`/`after` place it next to the target. `null` when the drop
 * would put the page inside its own subtree.
 */
export const dropTarget = (pages: ReadonlyArray<FlatPage>, pageId: string, targetId: string, position: "after" | "before" | "inside"): MoveTarget | null => {
    const target = pages.find((candidate) => candidate._id === targetId);

    if (!target || isInSubtree(pages, pageId, targetId)) {
        return null;
    }

    if (position === "inside") {
        return { index: siblingsOf(pages, target._id).filter((sibling) => sibling._id !== pageId).length, parentPageId: target._id };
    }

    const siblings = siblingsOf(pages, target.parentPageId).filter((sibling) => sibling._id !== pageId);
    const targetIndex = siblings.findIndex((sibling) => sibling._id === targetId);

    return { index: position === "before" ? targetIndex : targetIndex + 1, parentPageId: target.parentPageId };
};
