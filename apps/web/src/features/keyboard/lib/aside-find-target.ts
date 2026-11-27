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

/**
 * The desktop sidebar's root, marked `data-state="collapsed"` when it is closed. Its panel is slid off-canvas by a
 * transform, which `isShown` cannot see, so a collapsed sidebar is checked for by name.
 */
const COLLAPSED_SIDEBAR = `[data-slot="sidebar"][data-state="collapsed"]`;

/**
 * The mobile sidebar's sheet while it animates closed. It stays in the DOM until the animation ends, so a panel still
 * focused inside it is not shown, though `isShown` cannot tell.
 */
const CLOSING_MOBILE_SIDEBAR = `[data-slot="sidebar"][data-mobile="true"][data-closed]`;

export const hasAsideFindTarget = (): boolean => {
    const host = document.activeElement?.closest(`[${CSS.escape(ASIDE_FIND_HOST_ATTRIBUTE)}]`);

    return host != null && isShown(host) && host.closest(COLLAPSED_SIDEBAR) == null && host.closest(CLOSING_MOBILE_SIDEBAR) == null;
};
