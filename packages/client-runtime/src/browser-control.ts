/**
 * What a view of the thread's cloud browser makes of the live status (`browser.live_view.getThreadBrowser`) and of a
 * refused `takeControl`, shared by the web card and the phone so both read a lease the same way.
 */

/** The live status's lease, as `getThreadBrowser` answers it on a running browser. */
export interface BrowserLease {
    byYou: boolean;
    /** Only when the lease is the caller's: the public names of the claims that name it. */
    claimIds?: string[];
    until: number;
}

/** How long the server keeps a lease nobody renews (`CONTROL_IDLE_MS` in `backend/lunora/browser/live-view-logic.ts`). */
export const CONTROL_LEASE_MS = 120_000;

/**
 * How often a view in control renews its lease: well inside the server's idle window (two minutes), so one late or
 * lost renewal never ends it.
 */
export const CONTROL_KEEP_INTERVAL_MS = 30_000;

/**
 * Whose the lease is, seen from a view that holds the claim named `claimId` (or none): `mine`, `other-view` (another
 * of the same person's views took it over: the live status names its claim, not this one), `other-person`, or `none`
 * (no lease, or one that ended on the server's clock `now`).
 */
export const leaseHolder = (lease: BrowserLease | undefined, claimId: string | undefined, now: number): "mine" | "none" | "other-person" | "other-view" => {
    if (lease === undefined || lease.until <= now) {
        return "none";
    }

    if (!lease.byYou) {
        return "other-person";
    }

    return isTakenOverByOwnView(lease, claimId) ? "other-view" : "mine";
};

/** The lease is the caller's, but under another of their views' claims: the view holding `claimId` must stop. */
export const isTakenOverByOwnView = (lease: BrowserLease | undefined, claimId: string | undefined): boolean =>
    claimId !== undefined && lease?.byYou === true && lease.claimIds !== undefined && !lease.claimIds.includes(claimId);

/** The words for a `takeControl` that answered without a claim. */
export const controlRefusalText = (status: "busy" | "ended" | "held" | "taken" | "unavailable"): string => {
    switch (status) {
        case "busy": {
            return "The agent is using the browser right now. Try again in a moment.";
        }
        case "ended": {
            return "The browser has closed.";
        }
        case "held": {
            return "You are controlling this browser in another window, such as the web app. Hand it back there first.";
        }
        case "taken": {
            return "Someone else is controlling this browser.";
        }
        default: {
            return "Taking control is not available right now.";
        }
    }
};
