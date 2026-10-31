import { describe, expect, it } from "vitest";

import type { HooksView } from "../../acp/hooks/types";
import { APPROVE_GUARD_MS, HooksPanelModel } from "./hooks-panel";

const hook = { event: "saved", glob: "*.ts", id: "r", name: "Review", prompt: "Review it." } as const;
const hashOf = (letter: string): string => letter.repeat(64);
const view = (patch: Partial<HooksView> = {}): HooksView => {
    return { hash: "a".repeat(64), hooks: [hook], state: "unapproved", watching: true, ...patch };
};

describe("HooksPanelModel", () => {
    it("shows a first view and holds Approve back for a moment", () => {
        const model = new HooksPanelModel();

        expect(APPROVE_GUARD_MS).toBeGreaterThanOrEqual(2000);
        expect(model.receive("s1", "s1", view())).toEqual({ approveDelayMs: APPROVE_GUARD_MS, kind: "show", view: view() });
    });

    it("keeps what is drawn when a re-read finds nothing new, so Approve is not held back again", () => {
        const model = new HooksPanelModel();

        model.receive("s1", "s1", view());

        expect(model.receive("s1", "s1", view())).toEqual({ kind: "keep" });
        expect(model.receive("s1", "s1", view())).toEqual({ kind: "keep" });
    });

    it("does not swap an unapproved view in place when the file changed: it asks for a review", () => {
        const model = new HooksPanelModel();

        model.receive("s1", "s1", view());

        const changed = view({ hash: "b".repeat(64), hooks: [{ ...hook, prompt: "Something else." }] });

        const later = view({ hash: hashOf("c") });

        expect(model.receive("s1", "s1", changed)).toEqual({ kind: "notice" });
        // Further changes do not replace the notice either; only an explicit review does.
        expect(model.receive("s1", "s1", later)).toEqual({ kind: "keep" });
        expect(model.receive("s1", "s1", changed)).toEqual({ kind: "keep" });
    });

    it("treats a file that changes after approval as a new, unapproved view that must be reviewed", () => {
        const model = new HooksPanelModel();

        const edited = view({ hash: hashOf("d"), state: "changed" });

        model.receive("s1", "s1", view({ state: "unapproved" }));

        expect(model.receive("s1", "s1", edited)).toEqual({ kind: "notice" });
    });

    it("draws the fresh view, with Approve held back, only when the person asks to review again", () => {
        const model = new HooksPanelModel();

        const fresh = view({ hash: hashOf("b") });

        model.receive("s1", "s1", view());
        model.receive("s1", "s1", fresh);

        expect(model.review("s1", "s1", fresh)).toEqual({ approveDelayMs: APPROVE_GUARD_MS, kind: "show", view: fresh });
        expect(model.receive("s1", "s1", fresh)).toEqual({ kind: "keep" });
    });

    it("redraws freely when no Approve is on screen, and holds the one it brings back", () => {
        const model = new HooksPanelModel();

        model.receive("s1", "s1", view({ state: "approved" }));

        const next = view({ hash: hashOf("e"), state: "changed" });

        expect(model.receive("s1", "s1", next)).toEqual({ approveDelayMs: APPROVE_GUARD_MS, kind: "show", view: next });
    });

    it("does not hold back a view that offers nothing to approve", () => {
        const model = new HooksPanelModel();

        const invalid = view({ hash: undefined, state: "invalid" });

        expect(model.receive("s1", "s1", invalid)).toMatchObject({ approveDelayMs: 0, kind: "show" });
    });

    it("answers for the selected session only", () => {
        const model = new HooksPanelModel();

        // A read for s1 came back after the person moved to s2.
        expect(model.receive("s1", "s2", view())).toEqual({ kind: "ignore" });
        expect(model.canAct("s1", "s2")).toBe(false);
    });

    it("lets a click through only for the session on show, and not after the panel was cleared", () => {
        const model = new HooksPanelModel();

        model.receive("s1", "s1", view({ state: "approved" }));
        expect(model.canAct("s1", "s1")).toBe(true);
        expect(model.canAct("s1", "s2")).toBe(false);
        expect(model.canAct("s2", "s2")).toBe(false);

        model.clear();
        expect(model.canAct("s1", "s1")).toBe(false);
    });

    it("starts over for another session: nothing carries across, and the first view of it is shown", () => {
        const model = new HooksPanelModel();

        model.receive("s1", "s1", view());

        expect(model.isShowing("s1")).toBe(true);
        expect(model.isShowing("s2")).toBe(false);
        const other = view({ hash: hashOf("f") });

        expect(model.receive("s2", "s2", other)).toMatchObject({ kind: "show" });
    });
});
