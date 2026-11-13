/**
 * Selecting a line in one file of a commentable diff draws that file again, not every file in the patch: each file
 * gets only its own selection. A file's renders are counted through the draft hook it calls once per render.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import HostDiffViewer from "./host-diff-viewer";

const { renders } = vi.hoisted(() => {
    return { renders: { count: 0 } };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Trans: ({ children }: { children: unknown }) => <>{children as never}</>,
        useLingui: () => {
            return { t: text };
        },
    };
});

const NO_DRAFTS: never[] = [];

vi.mock("@/features/chat/host/diff-comments-store", () => {
    return {
        useDiffCommentStore: {
            getState: () => {
                return { add: () => true };
            },
        },
        useDiffDraft: () => NO_DRAFTS,
        // Called once per render of each file's view.
        useDiffDraftFull: () => {
            renders.count += 1;

            return false;
        },
    };
});

vi.mock("@/features/chat/host/diff-comment-form", () => {
    return { default: () => null };
});

const fileDiff = (path: string) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n");

const PATCH = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].map((path: string) => fileDiff(path)).join("\n");
const KEEP_LINE = /Line 1, unchanged: keep/u;

describe("HostDiffViewer: selecting lines", () => {
    it("draws only the file whose selection changed", () => {
        render(<HostDiffViewer comment={{ messageId: "m1", threadId: "t1" }} patch={PATCH} />);

        expect(renders.count).toBe(4);

        const [firstLine] = screen.getAllByRole("option", { name: KEEP_LINE });

        renders.count = 0;
        fireEvent.click(firstLine!);

        expect(firstLine!.getAttribute("aria-selected")).toBe("true");
        // The file that gained the selection; the other three are left alone.
        expect(renders.count).toBe(1);

        // Moving the selection to another file draws the file that lost it and the one that gained it.
        const lastFileLine = screen.getAllByRole("option", { name: KEEP_LINE }).at(-1)!;

        renders.count = 0;
        fireEvent.click(lastFileLine);

        expect(lastFileLine.getAttribute("aria-selected")).toBe("true");
        expect(firstLine!.getAttribute("aria-selected")).toBe("false");
        expect(renders.count).toBe(2);
    });
});
