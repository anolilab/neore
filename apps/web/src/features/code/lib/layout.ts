/** Pure layout model of the Code workspace: one or two panes, each with ordered tabs and one active tab. */

export const MAX_PANES = 2;
export const MIN_SPLIT = 20;
export const MAX_SPLIT = 80;

export type Pane = { active: string | undefined; tabs: string[] };

export type Layout = {
    activePane: number;
    panes: Pane[];
    /** Width of the first pane in percent, used while two panes are open. */
    split: number;
};

export type LayoutAction =
    | { tabId: string; type: "open" }
    | { paneIndex: number; tabId: string; type: "activate" }
    | { paneIndex: number; tabId: string; type: "close" }
    | { paneIndex: number; type: "focus" }
    | { paneIndex: number; type: "split" }
    | { paneIndex: number; type: "closePane" }
    | { split: number; type: "resize" }
    | { isValid: (tabId: string) => boolean; type: "prune" };

/** Tab ids are `host:<id>`, `pr:<id>` or `run:<id>`. */
const TAB_ID = /^(?:host|pr|run):[\w-]{1,128}$/;

export const hostTabId = (deviceId: string): string => `host:${deviceId}`;

export const isTabId = (value: unknown): value is string => typeof value === "string" && TAB_ID.test(value);

export const initialLayout = (): Layout => {
    return { activePane: 0, panes: [{ active: undefined, tabs: [] }], split: 50 };
};

const clampSplit = (split: number): number => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, Number.isFinite(split) ? split : 50));

const replacePane = (layout: Layout, index: number, pane: Pane): Layout => {
    return { ...layout, panes: layout.panes.map((current, i) => (i === index ? pane : current)) };
};

const hasPane = (layout: Layout, index: number): boolean => index >= 0 && index < layout.panes.length;

/** The tab to show after `tabId` leaves `tabs`: the one that slides into its place, else the previous one. */
const neighbour = (tabs: string[], tabId: string): string | undefined => {
    const index = tabs.indexOf(tabId);
    const rest = tabs.filter((id) => id !== tabId);

    return rest[Math.min(index, rest.length - 1)];
};

const open = (layout: Layout, tabId: string): Layout => {
    const active = layout.panes[layout.activePane];

    if (active?.tabs.includes(tabId)) {
        return replacePane(layout, layout.activePane, { ...active, active: tabId });
    }

    const holder = layout.panes.findIndex((pane) => pane.tabs.includes(tabId));

    if (holder !== -1) {
        return { ...replacePane(layout, holder, { ...layout.panes[holder]!, active: tabId }), activePane: holder };
    }

    const target = active ?? layout.panes[0]!;

    return replacePane(layout, layout.activePane, { active: tabId, tabs: [...target.tabs, tabId] });
};

const close = (layout: Layout, paneIndex: number, tabId: string): Layout => {
    const pane = layout.panes[paneIndex];

    if (!pane?.tabs.includes(tabId)) {
        return layout;
    }

    const tabs = pane.tabs.filter((id) => id !== tabId);

    return replacePane(layout, paneIndex, { active: pane.active === tabId ? neighbour(pane.tabs, tabId) : pane.active, tabs });
};

const split = (layout: Layout, paneIndex: number): Layout => {
    const pane = layout.panes[paneIndex];

    if (layout.panes.length >= MAX_PANES || !pane?.active) {
        return layout;
    }

    return { ...layout, activePane: layout.panes.length, panes: [...layout.panes, { active: pane.active, tabs: [pane.active] }] };
};

const closePane = (layout: Layout, paneIndex: number): Layout => {
    if (!hasPane(layout, paneIndex)) {
        return layout;
    }

    if (layout.panes.length === 1) {
        return { ...layout, panes: [{ active: undefined, tabs: [] }] };
    }

    return { ...layout, activePane: 0, panes: layout.panes.filter((_, i) => i !== paneIndex) };
};

const prune = (layout: Layout, isValid: (tabId: string) => boolean): Layout => {
    const panes = layout.panes.map((pane) => {
        const tabs = pane.tabs.filter((id) => isValid(id));
        const active = pane.active !== undefined && tabs.includes(pane.active) ? pane.active : tabs[0];

        return { active, tabs };
    });

    const unchanged = panes.every((pane, i) => pane.active === layout.panes[i]!.active && pane.tabs.length === layout.panes[i]!.tabs.length);

    if (unchanged) {
        return layout;
    }

    // The pane in focus lost its last tab: move to one that still has tabs, or the phone shows an empty pane alone.
    const activePane = panes[layout.activePane]?.tabs.length
        ? layout.activePane
        : Math.max(
              0,
              panes.findIndex((pane) => pane.tabs.length > 0),
          );

    return { ...layout, activePane, panes };
};

export const layoutReducer = (layout: Layout, action: LayoutAction): Layout => {
    switch (action.type) {
        case "activate": {
            const pane = layout.panes[action.paneIndex];

            return pane?.tabs.includes(action.tabId)
                ? { ...replacePane(layout, action.paneIndex, { ...pane, active: action.tabId }), activePane: action.paneIndex }
                : layout;
        }
        case "close": {
            return close(layout, action.paneIndex, action.tabId);
        }
        case "closePane": {
            return closePane(layout, action.paneIndex);
        }
        case "focus": {
            return hasPane(layout, action.paneIndex) && layout.activePane !== action.paneIndex ? { ...layout, activePane: action.paneIndex } : layout;
        }
        case "open": {
            return open(layout, action.tabId);
        }
        case "prune": {
            return prune(layout, action.isValid);
        }
        case "resize": {
            return { ...layout, split: clampSplit(action.split) };
        }
        case "split": {
            return split(layout, action.paneIndex);
        }
        default: {
            return layout;
        }
    }
};

const parsePane = (value: unknown): Pane | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const { active, tabs } = value as { active?: unknown; tabs?: unknown };

    if (!Array.isArray(tabs)) {
        return undefined;
    }

    const clean = [...new Set(tabs.filter((id) => isTabId(id)))];

    return { active: typeof active === "string" && clean.includes(active) ? active : clean[0], tabs: clean };
};

/** Validates a stored layout; anything malformed falls back to the empty layout, unknown tab ids are dropped. */
export const parseLayout = (value: unknown): Layout => {
    if (typeof value !== "object" || value === null) {
        return initialLayout();
    }

    const raw = value as { activePane?: unknown; panes?: unknown; split?: unknown };
    const panes = Array.isArray(raw.panes)
        ? raw.panes
              .slice(0, MAX_PANES)
              .map((pane) => parsePane(pane))
              .filter((pane): pane is Pane => pane !== undefined)
        : [];

    if (panes.length === 0) {
        return initialLayout();
    }

    return {
        activePane:
            typeof raw.activePane === "number" && Number.isSafeInteger(raw.activePane) && raw.activePane >= 0 && raw.activePane < panes.length
                ? raw.activePane
                : 0,
        panes,
        split: typeof raw.split === "number" ? clampSplit(raw.split) : 50,
    };
};
