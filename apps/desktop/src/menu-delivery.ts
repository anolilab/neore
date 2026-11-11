/**
 * Delivers application-menu commands to a site window only once its page listens. The deployed site is updated apart
 * from the shell, so a page may never listen (an older site): the page says it listens through `menuCommandsReady`,
 * and a page that has not said so `MENU_READY_GRACE_MS` after its load gets the shell's own fallback instead.
 * Readiness belongs to a document: from the start of a main-frame navigation the departing page gets nothing, and
 * every committed one starts over. A navigation that never commits gives the page that stayed its state back: the shell
 * cancelled it, `did-fail-provisional-load` ended it, or loading stopped with it still uncommitted.
 */
import type { MenuCommand } from "./app-menu.js";

/** How long a loaded page has to start listening before its commands take the fallback. */
export const MENU_READY_GRACE_MS = 2000;

/** `loading` queues, `ready` sends, `absent` (loaded, never listened) takes the fallback. */
type Phase = "absent" | "loading" | "ready";

interface WindowState {
    /** Navigations the shell cancelled and already counted: their `did-fail-provisional-load`, if it comes, is not counted again. */
    cancelled: number;
    /** The current document finished loading (or stopped): the grace period may run. */
    loaded: boolean;
    /** Main-frame navigations started and neither committed nor abandoned. While one is, every command queues. */
    pending: number;
    phase: Phase;
    queue: MenuCommand[];
    /** The departing document's own phase and kind while a navigation is pending, given back if none commits. */
    resume?: { phase: Phase; toSite: boolean };
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
    /** A main-frame navigation ended without a new document (cancelled, a download, a 204): the page stays. */
    navigationAbandoned: (win: W) => void;
    /** The shell cancelled a main-frame navigation after it started (`will-navigate`, `will-redirect`): the page stays. */
    navigationCancelled: (win: W) => void;
    /** A main-frame cross-document navigation started: the departing page gets nothing more. */
    navigationStarted: (win: W) => void;
    /** The page subscribed to menu commands: what was queued is sent now. */
    ready: (win: W) => void;
    /** The page's last subscriber left: commands queue again, and the grace period runs for a loaded page. */
    unready: (win: W) => void;
}

export const createMenuDelivery = <W>({ fallback, isShowingSite, send }: MenuDeliveryOptions<W>): MenuDelivery<W> => {
    const states = new Map<W, WindowState>();

    const stateOf = (win: W): WindowState => {
        let state = states.get(win);

        if (state === undefined) {
            state = { cancelled: 0, loaded: false, pending: 0, phase: "loading", queue: [], toSite: true };
            states.set(win, state);
        }

        return state;
    };

    const stopTimer = (win: W): void => {
        const state = stateOf(win);

        clearTimeout(state.timer);
        state.timer = undefined;
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

    /** Sends (or falls back for) what was held, now that the phase says where it goes. */
    const flush = (win: W): void => {
        const state = stateOf(win);
        const queued = state.queue;

        state.queue = [];

        for (const command of queued) {
            deliver(win, command);
        }
    };

    /** A loaded page that is not listening gets `MENU_READY_GRACE_MS` before its commands take the fallback. */
    const startGrace = (win: W): void => {
        const state = stateOf(win);

        if (state.phase !== "loading" || !state.loaded || state.pending > 0 || state.timer !== undefined) {
            return;
        }

        state.timer = setTimeout(() => {
            state.timer = undefined;
            state.phase = "absent";
            flush(win);
        }, MENU_READY_GRACE_MS);
    };

    /** No navigation is pending any more and none committed: the page that stayed gets its own state back. */
    const resumePage = (win: W): void => {
        const state = stateOf(win);

        state.pending = 0;

        if (state.resume === undefined) {
            return;
        }

        state.phase = state.resume.phase;
        state.toSite = state.resume.toSite;
        state.resume = undefined;

        if (!state.toSite) {
            state.queue = [];
        }

        if (state.phase === "loading") {
            startGrace(win);
        } else {
            flush(win);
        }
    };

    /** One pending navigation ended without a commit; never below zero. */
    const abandonOne = (win: W): void => {
        const state = stateOf(win);

        if (state.pending === 0) {
            return;
        }

        state.pending -= 1;

        if (state.pending === 0) {
            resumePage(win);
        }
    };

    return {
        deliver,
        forget: (win) => {
            const state = states.get(win);

            if (state !== undefined) {
                stopTimer(win);
                states.delete(win);
            }
        },
        loaded: (win) => {
            const state = stateOf(win);

            state.loaded = true;
            // Loading stopped: nothing is in flight, so a navigation still pending ended without a word (cancelled,
            // a download, a 204), and no `did-fail-provisional-load` is still to come.
            state.cancelled = 0;

            if (state.pending > 0) {
                resumePage(win);
            } else {
                startGrace(win);
            }
        },
        navigated: (win, toSite) => {
            const state = stateOf(win);

            stopTimer(win);
            state.cancelled = 0;
            state.loaded = false;
            state.pending = 0;
            state.phase = "loading";
            state.resume = undefined;
            state.toSite = toSite;

            if (!toSite) {
                state.queue = [];
            }
        },
        navigationAbandoned: (win) => {
            const state = stateOf(win);

            if (state.cancelled > 0) {
                state.cancelled -= 1;

                return;
            }

            abandonOne(win);
        },
        navigationCancelled: (win) => {
            const state = stateOf(win);

            if (state.pending === 0) {
                return;
            }

            state.cancelled += 1;
            abandonOne(win);
        },
        navigationStarted: (win) => {
            const state = stateOf(win);

            if (state.pending === 0) {
                state.resume = { phase: state.phase, toSite: state.toSite };
            }

            state.pending += 1;
            stopTimer(win);
            state.phase = "loading";
            // Where it goes is known at the commit: until then a command is held, and dropped if it is not the site.
            state.toSite = true;
        },
        ready: (win) => {
            const state = stateOf(win);

            // Before the commit only the departing document can say this: it is that page's, never the next one's.
            if (state.pending > 0) {
                if (state.resume !== undefined) {
                    state.resume.phase = "ready";
                }

                return;
            }

            stopTimer(win);
            state.phase = "ready";
            flush(win);
        },
        unready: (win) => {
            const state = stateOf(win);

            if (state.pending > 0) {
                if (state.resume?.phase === "ready") {
                    state.resume.phase = "loading";
                }

                return;
            }

            if (state.phase !== "ready") {
                return;
            }

            state.phase = "loading";
            startGrace(win);
        },
    };
};
