/**
 * The tool rows of a live host turn: a long title wraps rather than cuts, and the tail of a call's output opens at its
 * newest lines and keeps the reader's place once they scroll up.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostToolRow } from "./host-activity";
import { HostPlan, HostToolCalls } from "./host-activity";

const reader = vi.hoisted(() => {
    return { locale: "en" };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return {
                i18n: {
                    get locale() {
                        return reader.locale;
                    },
                },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

// jsdom lays nothing out, so the box's size is fixed here; its scroll position is kept as it is set.
const geometry = { clientHeight: 100, scrollHeight: 400 };

const CARGO_TITLE = /^cargo test/u;

const running = (output: string, title = "Run tests"): HostToolRow => {
    return { id: "c1", output, status: "in_progress", title, toolKind: "execute" };
};

const outputBox = (): HTMLElement => screen.getByRole("region", { name: "Output of Run tests" });

beforeEach(() => {
    geometry.clientHeight = 100;
    geometry.scrollHeight = 400;

    Object.defineProperties(HTMLElement.prototype, {
        clientHeight: { configurable: true, get: () => geometry.clientHeight },
        scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    });
});

describe("a coding agent's plan", () => {
    it("puts each task's status at the logical end of its row, so it sits on the far side in right-to-left text", () => {
        render(<HostPlan entries={[{ content: "Read the code", priority: "high", status: "completed" }]} />);

        const status = screen.getByText("Done");

        expect(status.className).toContain("ms-auto");
        expect(status.className).not.toContain("ml-auto");
    });

    it("lets a long unbroken task name wrap, so it cannot push its status out of view", () => {
        render(
            <HostPlan
                entries={[
                    {
                        content: "cargo test -p neore-device-core --features keychain -- acp_terminal::tests::runs_an_allowed",
                        priority: "high",
                        status: "pending",
                    },
                ]}
            />,
        );

        const task = screen.getByText(CARGO_TITLE);

        expect(task.className).toContain("min-w-0");
        expect(task.className).toContain("break-words");
    });
});

describe("a coding agent's tool calls", () => {
    it("lets a long title wrap instead of cutting it off", () => {
        render(<HostToolCalls tools={[running("", "cargo test -p neore-device-core --features keychain -- acp_terminal::tests::runs_an_allowed")]} />);

        const title = screen.getByText(CARGO_TITLE);

        expect(title.className).not.toContain("truncate");
        expect(title.className).toContain("break-all");
    });

    it("opens a growing output at its newest lines", () => {
        const { rerender } = render(<HostToolCalls tools={[running("line 1")]} />);

        expect(outputBox().scrollTop).toBe(400);

        geometry.scrollHeight = 500;
        rerender(<HostToolCalls tools={[running("line 1\nline 2")]} />);

        expect(outputBox().scrollTop).toBe(500);
    });

    it("keeps the place of a reader who scrolled up, while the output keeps growing", () => {
        const { rerender } = render(<HostToolCalls tools={[running("line 1")]} />);
        const box = outputBox();

        box.scrollTop = 0;
        fireEvent.scroll(box);
        geometry.scrollHeight = 500;
        rerender(<HostToolCalls tools={[running("line 1\nline 2")]} />);

        expect(box.scrollTop).toBe(0);
    });

    it("formats a command's exit code for the reader's locale, in the row and in its announcement", () => {
        const digit = new Intl.NumberFormat("ar-EG").format(1);

        reader.locale = "ar-EG";

        try {
            render(<HostToolCalls tools={[{ exit: { code: 1 }, id: "c1", output: "", status: "failed", title: "Run tests", toolKind: "execute" }]} />);

            expect(screen.getByText(`Exited with code ${digit}`)).toBeTruthy();
            expect(within(screen.getByRole("listitem")).getByRole("status").textContent).toBe(`Run tests: Failed. Exited with code ${digit}`);
        } finally {
            reader.locale = "en";
        }
    });

    it("keeps a command's status region in place from the start and fills it when the command finishes", () => {
        const { rerender } = render(<HostToolCalls tools={[running("")]} />);
        const row = screen.getByRole("listitem");
        const region = within(row).getByRole("status");

        expect(region.textContent).toBe("");

        rerender(<HostToolCalls tools={[{ ...running(""), status: "completed" }]} />);

        expect(within(row).getByRole("status")).toBe(region);
        expect(region.textContent).toBe("Run tests: Done");
    });

    it("moves the reader's focus to the tool row when its output is cleared while they are in it", () => {
        const { rerender } = render(<HostToolCalls tools={[running("line 1")]} />);

        outputBox().focus();
        rerender(<HostToolCalls tools={[running("")]} />);

        // eslint-disable-next-line testing-library/no-node-access -- focus placement (document.activeElement) is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("listitem"));
    });

    it("follows the newest lines again once the reader is back at the bottom", () => {
        const { rerender } = render(<HostToolCalls tools={[running("line 1")]} />);
        const box = outputBox();

        box.scrollTop = 0;
        fireEvent.scroll(box);
        box.scrollTop = 400;
        fireEvent.scroll(box);
        geometry.scrollHeight = 500;
        rerender(<HostToolCalls tools={[running("line 1\nline 2")]} />);

        expect(box.scrollTop).toBe(500);
    });
});
