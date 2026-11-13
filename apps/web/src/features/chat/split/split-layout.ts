/** Pure layout model of the split chat view: up to three chats side by side, exactly one of them focused. */

export const MAX_PANES = 3;
/** The narrowest a pane gets; the group scrolls sideways instead of squeezing a chat below it. */
export const MIN_PANE_PX = 360;

export type SplitLayout = {
    /** Index into `panes` of the pane that owns the live composer. */
    focus: number;
    /** Thread ids, left to right. */
    panes: string[];
    /** Width of each pane in percent, by thread id. Absent until the first resize. */
    sizes: Record<string, number>;
};

export type SplitAction =
    | { threadId: string; type: "open" }
    | { threadId: string; type: "show" }
    | { index: number; type: "focus" }
    | { index: number; type: "close" }
    | { sizes: Record<string, number>; type: "resize" }
    | { isValid: (threadId: string) => boolean; type: "prune" };

const THREAD_ID = /^[\w-]{1,128}$/;

const isPaneId = (value: unknown): value is string => typeof value === "string" && THREAD_ID.test(value);

export const initialSplitLayout = (): SplitLayout => {
    return { focus: 0, panes: [], sizes: {} };
};

const hasPane = (layout: SplitLayout, index: number): boolean => Number.isSafeInteger(index) && index >= 0 && index < layout.panes.length;

const withoutSize = (sizes: Record<string, number>, threadId: string): Record<string, number> =>
    Object.fromEntries(Object.entries(sizes).filter(([id]) => id !== threadId));

/**
 * The widths once `threadId` joins: the open panes keep their proportions and give up room for it. Without a saved width for every
 * open pane there is nothing to keep, so none is set and the panes share the space equally.
 */
const sizesWithRoom = (layout: SplitLayout, threadId: string): Record<string, number> => {
    const count = layout.panes.length;

    if (count === 0 || layout.panes.some((id) => layout.sizes[id] === undefined)) {
        return {};
    }

    const total = layout.panes.reduce((sum, id) => sum + (layout.sizes[id] ?? 0), 0);
    const share = (100 * count) / (count + 1);
    const sizes: Record<string, number> = { [threadId]: 100 / (count + 1) };

    for (const id of layout.panes) {
        sizes[id] = ((layout.sizes[id] ?? 0) / total) * share;
    }

    return sizes;
};

/** Adds the chat as a new pane and focuses it; a chat that is already open is only focused. Refuses past `MAX_PANES`. */
const open = (layout: SplitLayout, threadId: string): SplitLayout => {
    const existing = layout.panes.indexOf(threadId);

    if (existing !== -1) {
        return existing === layout.focus ? layout : { ...layout, focus: existing };
    }

    if (layout.panes.length >= MAX_PANES) {
        return layout;
    }

    return { ...layout, focus: layout.panes.length, panes: [...layout.panes, threadId], sizes: sizesWithRoom(layout, threadId) };
};

/** The chat the page is on: focused when open, else it takes the place of the focused pane (or the first pane). */
const show = (layout: SplitLayout, threadId: string): SplitLayout => {
    const existing = layout.panes.indexOf(threadId);

    if (existing !== -1) {
        return existing === layout.focus ? layout : { ...layout, focus: existing };
    }

    if (layout.panes.length === 0) {
        return { focus: 0, panes: [threadId], sizes: {} };
    }

    const replaced = layout.panes[layout.focus] as string;
    const size = layout.sizes[replaced];

    return {
        ...layout,
        panes: layout.panes.map((id, i) => (i === layout.focus ? threadId : id)),
        sizes: size === undefined ? withoutSize(layout.sizes, replaced) : { ...withoutSize(layout.sizes, replaced), [threadId]: size },
    };
};

/** Closes the pane, never the chat. The last pane stays: a split view without a chat has nothing to show. */
const close = (layout: SplitLayout, index: number): SplitLayout => {
    if (!hasPane(layout, index) || layout.panes.length <= 1) {
        return layout;
    }

    const closed = layout.panes[index] as string;
    const panes = layout.panes.filter((_, i) => i !== index);
    let { focus } = layout;

    if (index < layout.focus) {
        focus -= 1;
    } else if (index === layout.focus) {
        focus = Math.min(index, panes.length - 1);
    }

    return { focus, panes, sizes: withoutSize(layout.sizes, closed) };
};

const resize = (layout: SplitLayout, sizes: Record<string, number>): SplitLayout => {
    const next: Record<string, number> = {};

    for (const id of layout.panes) {
        const size = sizes[id];

        if (typeof size === "number" && Number.isFinite(size) && size > 0) {
            next[id] = Math.min(100, size);
        }
    }

    const unchanged = Object.keys(next).length === Object.keys(layout.sizes).length && Object.entries(next).every(([id, size]) => layout.sizes[id] === size);

    return unchanged ? layout : { ...layout, sizes: next };
};

const prune = (layout: SplitLayout, isValid: (threadId: string) => boolean): SplitLayout => {
    const panes = layout.panes.filter((id) => isValid(id));

    if (panes.length === layout.panes.length) {
        return layout;
    }

    const focused = layout.panes[layout.focus];
    const kept = focused === undefined ? -1 : panes.indexOf(focused);
    const sizes: Record<string, number> = {};

    for (const id of panes) {
        const size = layout.sizes[id];

        if (size !== undefined) {
            sizes[id] = size;
        }
    }

    return { focus: kept === -1 ? 0 : kept, panes, sizes };
};

export const splitLayoutReducer = (layout: SplitLayout, action: SplitAction): SplitLayout => {
    switch (action.type) {
        case "close": {
            return close(layout, action.index);
        }
        case "focus": {
            return hasPane(layout, action.index) && layout.focus !== action.index ? { ...layout, focus: action.index } : layout;
        }
        case "open": {
            return open(layout, action.threadId);
        }
        case "prune": {
            return prune(layout, action.isValid);
        }
        case "resize": {
            return resize(layout, action.sizes);
        }
        case "show": {
            return show(layout, action.threadId);
        }
        default: {
            return layout;
        }
    }
};

/** Validates a stored layout; anything malformed falls back to the empty layout. */
export const parseSplitLayout = (value: unknown): SplitLayout => {
    if (typeof value !== "object" || value === null) {
        return initialSplitLayout();
    }

    const raw = value as { focus?: unknown; panes?: unknown; sizes?: unknown };
    const panes = Array.isArray(raw.panes) ? [...new Set(raw.panes.filter((id) => isPaneId(id)))].slice(0, MAX_PANES) : [];

    if (panes.length === 0) {
        return initialSplitLayout();
    }

    const sizes: Record<string, number> = {};

    if (typeof raw.sizes === "object" && raw.sizes !== null) {
        for (const id of panes) {
            const size = (raw.sizes as Record<string, unknown>)[id];

            if (typeof size === "number" && Number.isFinite(size) && size > 0 && size <= 100) {
                sizes[id] = size;
            }
        }
    }

    return {
        focus: typeof raw.focus === "number" && Number.isSafeInteger(raw.focus) && raw.focus >= 0 && raw.focus < panes.length ? raw.focus : 0,
        panes,
        sizes,
    };
};
