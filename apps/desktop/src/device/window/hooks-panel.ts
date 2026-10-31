/**
 * What the hooks panel in the device window may do with a newly read view. The file is repository content and can
 * change under the person's hands, so a view with an Approve button is never swapped for another in place: the button
 * that was clicked must approve what was on screen. A changed file shows a notice with an explicit "review again"
 * instead, and every redraw that brings Approve back holds it for a moment. Pure, so the rules are tested without a page.
 */
import type { HooksView } from "../../acp/hooks/types";

/** Approve stays disabled this long after the view that carries it was drawn. */
export const APPROVE_GUARD_MS = 2000;

export type PanelStep = { approveDelayMs: number; kind: "show"; view: HooksView } | { kind: "ignore" } | { kind: "keep" } | { kind: "notice" };

interface Shown {
    notice: boolean;
    offersApproval: boolean;
    sessionId: string;
    signature: string;
}

const offersApproval = (view: HooksView): boolean => view.hash !== undefined && (view.state === "unapproved" || view.state === "changed");

const signatureOf = (view: HooksView): string => JSON.stringify([view.state, view.hash, view.watching, view.error, view.hooks]);

export class HooksPanelModel {
    private shown: Shown | undefined;

    /** The panel was emptied (another session, or none): nothing on screen may be acted on. */
    public clear(): void {
        this.shown = undefined;
    }

    public isShowing(sessionId: string): boolean {
        return this.shown?.sessionId === sessionId;
    }

    /** Whether a click on a button drawn for `sessionId` still means what it says: that session is on show and selected. */
    public canAct(sessionId: string, selected: string | undefined): boolean {
        return selected === sessionId && this.shown?.sessionId === sessionId && !this.shown.notice;
    }

    /** A view that was read in the background. */
    public receive(sessionId: string, selected: string | undefined, view: HooksView): PanelStep {
        if (selected !== sessionId) {
            return { kind: "ignore" };
        }

        const { shown } = this;

        if (shown?.sessionId !== sessionId) {
            return this.draw(sessionId, view);
        }

        if (shown.notice) {
            return { kind: "keep" };
        }

        if (shown.signature === signatureOf(view)) {
            return { kind: "keep" };
        }

        if (shown.offersApproval) {
            this.shown = { notice: true, offersApproval: false, sessionId, signature: "" };

            return { kind: "notice" };
        }

        return this.draw(sessionId, view);
    }

    /** A view the person asked for (after approving or revoking, or "review again"): it replaces whatever is on screen. */
    public review(sessionId: string, selected: string | undefined, view: HooksView): PanelStep {
        return selected === sessionId ? this.draw(sessionId, view) : { kind: "ignore" };
    }

    private draw(sessionId: string, view: HooksView): PanelStep {
        const offers = offersApproval(view);

        this.shown = { notice: false, offersApproval: offers, sessionId, signature: signatureOf(view) };

        return { approveDelayMs: offers ? APPROVE_GUARD_MS : 0, kind: "show", view };
    }
}
