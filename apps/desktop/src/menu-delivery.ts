/**
 * Delivers application-menu commands to a site window only once its page listens. The deployed site is updated apart
 * from the shell, so a page may never listen (an older site): the page says it listens through `menuCommandsReady`,
 * and a page that has not said so `MENU_READY_GRACE_MS` after its load gets the shell's own fallback instead.
 * Readiness belongs to a document, so every committed main-frame navigation starts over.
 */
import type { MenuCommand } from "./app-menu.js";

/** How long a loaded page has to start listening before its commands take the fallback. */
export const MENU_READY_GRACE_MS = 2000;

interface WindowState {
    /** `loading` queues, `ready` sends, `absent` (loaded, never listened) takes the fallback. */
    phase: "absent" | "loading" | "ready";
    queue: MenuCommand[];
    timer?: ReturnType<typeof setTimeout>;
    /** The current document is not the site (the recovery page): nothing is queued for it. */
    toSite: boolean;
}

export interface MenuDeliveryOptions<W> {
    /** The page did not listen: New Chat can still be loaded by URL; the rest is dropped. */
    fallback: (win: W, command: MenuCommand) => void;
    isShowingSite: (win: W) => boolean;
    send: (win: W, command: MenuCommand) => void;
}

export interface MenuDelivery<W> {
    deliver: (win: W, command: MenuCommand) => void;
    /** The window is gone: its queue and timer with it. */
    forget: (win: W) => void;
    /** The page finished loading (or stopped): the grace period starts. */
    loaded: (win: W) => void;
    /** A main-frame document was committed; `toSite` is whether it is the site. */
    navigated: (win: W, toSite: boolean) => void;
    /** The page subscribed to menu commands: what was queued is sent now. */
    ready: (win: W) => void;
}

export const createMenuDelivery = <W>({ fallback, isShowingSite, send }: MenuDeliveryOptions<W>): MenuDelivery<W> => {
    const states = new Map<W, WindowState>();

    const stateOf = (win: W): WindowState => {
        let state = states.get(win);

        if (state === undefined) {
            state = { phase: "loading", queue: [], toSite: true };
            states.set(win, state);
        }

        return state;
    };

    const deliver = (win: W, command: MenuCommand): void => {
        const state = stateOf(win);

        if (state.phase === "loading") {
            if (state.toSite) {
                // One of each, in the order last asked for: a second ⌘N while loading is still one new chat.
                state.queue = [...state.queue.filter((queued) => queued !== command), command];
            }

            return;
        }

        if (!isShowingSite(win)) {
            return;
        }

        if (state.phase === "ready") {
            send(win, command);
        } else {
            fallback(win, command);
        }
    };

    return {
        deliver,
        forget: (win) => {
            const state = states.get(win);

            if (state !== undefined) {
                clearTimeout(state.timer);
                states.delete(win);
            }
        },
        loaded: (win) => {
            const state = stateOf(win);

            if (state.phase !== "loading" || state.timer !== undefined) {
                return;
            }

            state.timer = setTimeout(() => {
                const queued = state.queue;

                state.timer = undefined;
                state.phase = "absent";
                state.queue = [];

                for (const command of queued) {
                    deliver(win, command);
                }
            }, MENU_READY_GRACE_MS);
        },
        navigated: (win, toSite) => {
            const state = stateOf(win);

            clearTimeout(state.timer);
            state.timer = undefined;
            state.phase = "loading";
            state.toSite = toSite;

            if (!toSite) {
                state.queue = [];
            }
        },
        ready: (win) => {
            const state = stateOf(win);
            const queued = state.queue;

            clearTimeout(state.timer);
            state.timer = undefined;
            state.phase = "ready";
            state.queue = [];

            for (const command of queued) {
                deliver(win, command);
            }
        },
    };
};
