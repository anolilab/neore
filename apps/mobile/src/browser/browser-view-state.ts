/**
 * What the browser screen shows, from the live status and the last frame. Each state is its own, so the screen never
 * shows a blank page or a disabled button without saying why.
 */
import type { BrowserFrame, BrowserStatus } from "./browser-api";

/** How often a frame is read while the screen is open and nothing else asked for one. */
export const FRAME_REFRESH_MS = 10_000;

export type ViewState
    = | { kind: "connecting" }
    /** No browser runs in the chat, or the caller cannot read it. */
        | { kind: "ended"; message: string }
    /** Another person drives the browser: no one else sees the page meanwhile. */
        | { kind: "hidden"; message: string }
        | { canControl: boolean; currentUrl?: string; kind: "ready" };

export const NO_BROWSER = "No browser is open in this chat. It opens when the agent browses a page; ask it to open one first.";
export const NOT_READABLE = "This chat's browser cannot be shown. The chat may be locked, or no longer shared with you.";
export const CONTROLLED_BY_OTHER = "Someone else is controlling this browser. The page is hidden until they hand it back.";

export const viewStateOf = (status: BrowserStatus | undefined, error: string | undefined): ViewState => {
    if (error !== undefined) {
        return { kind: "ended", message: NOT_READABLE };
    }

    if (status === undefined) {
        return { kind: "connecting" };
    }

    if (status.kind === "denied") {
        return { kind: "ended", message: NOT_READABLE };
    }

    if (status.kind === "none") {
        return { kind: "ended", message: NO_BROWSER };
    }

    if (status.control !== undefined && !status.control.byYou && status.control.until > status.now) {
        return { kind: "hidden", message: CONTROLLED_BY_OTHER };
    }

    return { canControl: status.canControl, kind: "ready", ...status.currentUrl !== undefined && { currentUrl: status.currentUrl } };
};

/**
 * Changes whenever the agent acted on the browser (its activity moves `idleUntil`, a page moves `currentUrl`) or the
 * browser was replaced: a new frame is read then, not only on the timer.
 */
export const frameTrigger = (status: BrowserStatus | undefined): string | undefined => {
    if (status?.kind !== "running") {
        return undefined;
    }

    return `${status.browserId}|${status.idleUntil}|${status.currentUrl ?? ""}`;
};

/** A frame is read only for a screen that shows the page, in front, online. */
export const shouldReadFrame = (view: ViewState, { isActive, isOffline }: { isActive: boolean; isOffline: boolean }): boolean =>
    view.kind === "ready" && isActive && !isOffline;

/** The words for a frame read that brought no picture; `undefined` for one that did. */
export const frameMessage = (frame: BrowserFrame): string | undefined => {
    switch (frame.status) {
        case "busy": {
            return "A saved sign-in is being filled in on the page. It shows again once that is done.";
        }
        case "controlled": {
            return CONTROLLED_BY_OTHER;
        }
        case "ended": {
            return "The browser has closed.";
        }
        case "ok": {
            return undefined;
        }
        default: {
            return "The page could not be shown right now.";
        }
    }
};
