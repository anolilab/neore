/**
 * What the browser screen shows, from the live status and the last frame. Each state is its own, so the screen never
 * shows a blank page or a disabled button without saying why.
 */
import type { BrowserFrame, BrowserStatus } from "./browser-api";

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
export const BROWSER_CLOSED = "The browser has closed.";

/**
 * `isExpired`: the grant this status was read under has ended (its `accessUntil` passed). A live status is re-run only
 * by a write, not by the clock, so the screen stops showing it then, as every later answer would be a denial.
 * `closedBrowserId`: a browser a frame read found gone while the status still says it runs (the provider lost it before
 * the row knew): that browser is shown as closed until the status names another.
 */
export const viewStateOf = (status: BrowserStatus | undefined, error: string | undefined, isExpired = false, closedBrowserId?: string): ViewState => {
    if (error !== undefined || isExpired) {
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

    if (status.browserId === closedBrowserId) {
        return { kind: "ended", message: BROWSER_CLOSED };
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

/**
 * While the phone holds control the agent cannot act, and the phone's own renewals move `idleUntil`: only the page and
 * the browser count then, so its renewals never spend frame reads.
 */
export const frameTrigger = (status: BrowserStatus | undefined, isHolding = false): string | undefined => {
    if (status?.kind !== "running") {
        return undefined;
    }

    return `${status.browserId}|${isHolding ? "" : status.idleUntil}|${status.currentUrl ?? ""}`;
};

/**
 * An answer older than the one on screen, which must not replace it: one that names an older grant revision (a
 * lagging read of a grant since removed), or one from earlier on the server's clock. A denial is kept over another
 * answer from the same moment.
 */
export const isOlderStatus = (current: BrowserStatus | undefined, next: BrowserStatus): boolean => {
    if (current === undefined) {
        return false;
    }

    if (current.revision !== undefined && next.revision !== undefined && next.revision !== current.revision) {
        return next.revision < current.revision;
    }

    if (next.now !== current.now) {
        return next.now < current.now;
    }

    return current.kind === "denied" && next.kind !== "denied";
};

/**
 * How much earlier than the grant's end on this device's clock the page goes: the answer's way here made it arrive
 * late, and that delay must not keep the page up past the end.
 */
export const GRANT_END_MARGIN_MS = 2000;

/** The newest status the screen took, and a refusal of the chat the status subscription reported since. */
export interface Seen {
    answer?: { receivedAt: number; status: BrowserStatus };
    refusal?: { at: number; message: string };
}

/**
 * Takes a status answer from a read that began at `startedAt` (a live push: when it came), at `now`. A read that began
 * before a refusal never undoes it, and an answer older than the one on screen never replaces it; any other answer
 * replaces both, a refusal included.
 */
export const withAnswer = (seen: Seen, next: BrowserStatus, startedAt: number, now: number): Seen => {
    if ((seen.refusal !== undefined && startedAt < seen.refusal.at) || isOlderStatus(seen.answer?.status, next)) {
        return seen;
    }

    return { answer: { receivedAt: now, status: next } };
};

/** When the grant `status` was read under ends, on this device's clock (it came at `receivedAt`); none for the owner. */
export const grantEndOnDevice = (status: BrowserStatus | undefined, receivedAt: number): number | undefined => {
    if (status === undefined || status.kind === "denied" || status.accessUntil === undefined) {
        return undefined;
    }

    return receivedAt + (status.accessUntil - status.now) - GRANT_END_MARGIN_MS;
};

/**
 * Until when the chat shows its link to the browser screen, on this device's clock: while the browser runs, until it
 * goes idle (`idleUntil`, after which the server no longer shows it), and for a reader until the grant ends. Neither
 * end pushes a new status. None: no link.
 */
export const browserLinkUntil = (status: BrowserStatus, receivedAt: number): number | undefined => {
    if (status.kind !== "running") {
        return undefined;
    }

    return Math.min(receivedAt + (status.idleUntil - status.now), grantEndOnDevice(status, receivedAt) ?? Infinity);
};

/**
 * When another person's lease on the browser ends, on this device's clock: a lease that runs out writes nothing, so the
 * screen reads the status again then to show the page. None while no one else holds it.
 */
export const otherLeaseEndOnDevice = (status: BrowserStatus | undefined, receivedAt: number): number | undefined => {
    if (status?.kind !== "running" || status.control === undefined || status.control.byYou || status.control.until <= status.now) {
        return undefined;
    }

    return receivedAt + (status.control.until - status.now);
};

/**
 * Whether a new read key (an agent action, a page opened, a nudge) asks the running reader for a read: never the first
 * key seen, which the reader's own first read covers, nor the same key again.
 */
export const isReadDue = (previousKey: string | undefined, nextKey: string): boolean => previousKey !== undefined && previousKey !== nextKey;

/**
 * A page held off by a grant's end reads its status again on the offline provider's tick (back online, or a retry
 * due), but never on the tick it ran out at: the end's own read is timed. `expiredAt`: that tick, once known.
 */
export const expiredReread = (expiredAt: number | undefined, tick: number): { expiredAt: number; isDue: boolean } => {
    if (expiredAt === undefined || expiredAt === tick) {
        return { expiredAt: tick, isDue: false };
    }

    return { expiredAt, isDue: true };
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
            return BROWSER_CLOSED;
        }
        case "ok": {
            return undefined;
        }
        default: {
            return "The page could not be shown right now.";
        }
    }
};

/**
 * A read the server refused for its rate limit: the last picture stays as it was, without a failure note, and the
 * reader's next read (its timer, or the next agent action past the gap) tries again.
 */
export const isRateLimited = (error: unknown): boolean => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } | null };

    // A Lunora error carries its code on `.code` or on `.data.code`.
    return (typeof code === "string" ? code : data?.code) === "TOO_MANY_REQUESTS";
};
