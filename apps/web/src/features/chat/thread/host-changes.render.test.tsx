// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import HostChanges from "./host-changes";

vi.mock("@lingui/react/macro", () => {
    return {
        Plural: ({ one, other, value }: { one: string; other: string; value: number }) => (value === 1 ? one : other).split("#").join(String(value)),
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const ONE_FILE = /1 file changed/u;

const files = [
    { added: 2, path: "src/a.ts", removed: 1 },
    { added: 4, path: "b.md", removed: 0 },
];

// The dialog's scroll area measures itself; jsdom has no layout.
/* eslint-disable class-methods-use-this -- an inert stand-in */
class InertResizeObserver {
    public disconnect(): void {}

    public observe(): void {}

    public unobserve(): void {}
}
/* eslint-enable class-methods-use-this */

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
});

describe("a host turn's changes", () => {
    it("lists each file with its counts and opens the patch as plain text", () => {
        render(<HostChanges changes={{ files, patch: "--- a/src/a.ts\n+++ b/src/a.ts\n+<img src=x onerror=alert(1)>\n" }} />);

        expect(screen.getByText("src/a.ts")).toBeTruthy();
        expect(screen.getByText("b.md")).toBeTruthy();
        expect(screen.queryByTestId("host-changes-patch")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Open diff" }));

        const patch = screen.getByTestId("host-changes-patch");

        expect(patch.textContent).toContain("+<img src=x onerror=alert(1)>");
        expect(screen.queryByRole("img")).toBeNull();
    });

    it("counts one file in the singular", () => {
        render(<HostChanges changes={{ files: files.slice(0, 1), patch: "--- a\n" }} />);

        expect(screen.getByText(ONE_FILE)).toBeTruthy();
    });

    it("says the diff is too large and offers no diff, keeping the files", () => {
        render(<HostChanges changes={{ files, patch: { tooLarge: true } }} />);

        expect(screen.getByText("src/a.ts")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Open diff" })).toBeNull();
        expect(screen.getByRole("status").textContent).toContain("too large");
    });
});
