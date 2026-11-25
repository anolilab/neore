/**
 * The side-question panel's find bar, as the Find shortcut reaches it. The panel marks its section with this
 * attribute. The shortcut takes the panel's find only while focus is inside that section, so the thread's find
 * keeps its meaning everywhere else (the panel is hidden, not unmounted, when another sidebar tab is open).
 */
export const ASIDE_FIND_HOST_ATTRIBUTE = "data-aside-find-host";

/** Window event the side-question panel's find bar listens for. */
export const ASIDE_FIND_EVENT = "findInAside";

/**
 * Whether the element and each of its ancestors is shown. Focus can stay in a panel that a collapse then hides (the
 * sidebar closed by its shortcut, say), and a find opened there would be out of sight.
 */
const isShown = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);

        if (style.display === "none" || style.visibility === "hidden") {
            return false;
        }
    }

    return true;
};

export const hasAsideFindTarget = (): boolean => {
    const host = document.activeElement?.closest(`[${CSS.escape(ASIDE_FIND_HOST_ATTRIBUTE)}]`);

    return host != null && isShown(host);
};
