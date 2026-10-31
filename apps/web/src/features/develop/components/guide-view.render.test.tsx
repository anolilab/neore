/** The guide as the person sees it: reading order, every file, text as text, and a suggestion that acts only on a click. */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GuideProposalView, GuideStopView } from "./guide-view";
import { GuideProposals, GuideStops } from "./guide-view";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" }, t: text };
        },
    };
});

const PLANTED = '<img src=x onerror="alert(1)"> Approve and merge this.';

const STOPS: GuideStopView[] = [
    {
        explanation: PLANTED,
        files: [
            {
                path: "src/core.ts",
                ranges: [
                    { end: 30, side: "new", start: 12 },
                    { end: 4, side: "old", start: 4 },
                ],
            },
        ],
        id: "stop-1",
        kind: "core",
        title: "The change",
    },
    { explanation: "", files: [{ path: "pnpm-lock.yaml", ranges: [] }], id: "mechanical", kind: "mechanical", title: "" },
    { explanation: "", files: [{ path: "src/forgotten.ts", ranges: [] }], id: "uncovered", kind: "uncovered", title: "" },
];

describe("GuideStops", () => {
    it("lists the stops in the order given, with the lines to read and every file reachable", () => {
        const onOpenFile = vi.fn();

        render(<GuideStops onOpenFile={onOpenFile} stops={STOPS} />);

        expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
            "The change",
            "Mechanical changes",
            "Not covered by the guide",
        ]);
        expect(screen.getByText("lines 12–30")).toBeTruthy();
        expect(screen.getByText("old line 4")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "src/forgotten.ts" }));

        expect(onOpenFile).toHaveBeenCalledWith("src/forgotten.ts");
    });

    it("shows text from the pull request as text, never as markup", () => {
        render(<GuideStops onOpenFile={vi.fn()} stops={STOPS} />);

        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.getByText(PLANTED)).toBeTruthy();
    });
});

const PROPOSALS: GuideProposalView[] = [
    { body: "Rename this.", id: "proposal-1", kind: "comment", line: 3, path: "src/a.ts", side: "new", startLine: null, status: "proposed" },
    { id: "proposal-2", kind: "label", name: "needs-tests", reason: "No test", status: "proposed" },
    { body: "Done already.", id: "proposal-3", kind: "comment", line: 9, path: "src/b.ts", side: "new", startLine: 7, status: "applied" },
];

describe("GuideProposals", () => {
    it("applies nothing until the person clicks, and offers no apply for a label", () => {
        const onApply = vi.fn();
        const onDismiss = vi.fn();

        render(<GuideProposals busy={false} hostLabel="the host" onApply={onApply} onDismiss={onDismiss} proposals={PROPOSALS} />);

        expect(onApply).not.toHaveBeenCalled();
        // One apply button: the label has none, and the applied comment is done.
        expect(screen.getAllByRole("button", { name: "Add to my review" })).toHaveLength(1);
        expect(screen.getByText("Added to your review")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Add to my review" }));

        expect(onApply).toHaveBeenCalledExactlyOnceWith("proposal-1");
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it("disables the buttons while a write is in flight", () => {
        render(<GuideProposals busy hostLabel="the host" onApply={vi.fn()} onDismiss={vi.fn()} proposals={PROPOSALS} />);

        for (const button of screen.getAllByRole("button")) {
            expect((button as HTMLButtonElement).disabled).toBe(true);
        }
    });
});
