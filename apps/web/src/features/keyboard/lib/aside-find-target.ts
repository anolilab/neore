/**
 * The side-question panel's find bar, as the Find shortcut reaches it. The panel marks its section with this
 * attribute. The shortcut takes the panel's find only while focus is inside that section, so the thread's find
 * keeps its meaning everywhere else (the panel is hidden, not unmounted, when another sidebar tab is open).
 */
export const ASIDE_FIND_HOST_ATTRIBUTE = "data-aside-find-host";

/** Window event the side-question panel's find bar listens for. */
export const ASIDE_FIND_EVENT = "findInAside";

export const hasAsideFindTarget = (): boolean => document.activeElement?.closest(`[${CSS.escape(ASIDE_FIND_HOST_ATTRIBUTE)}]`) != null;
