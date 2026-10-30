import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const { ToolProgressRows } = await import("./tool-progress-rows");

const entry = { progress: 25, serverName: "Docs", toolCallId: "call_1", toolName: "index" };

describe("tool progress rows", () => {
    it("renders nothing while no call reports progress", () => {
        render(<ToolProgressRows state={[]} />);

        expect(screen.queryByTestId("tool-progress-row")).toBeNull();
    });

    it("shows a determinate bar when the server gave a total", () => {
        render(<ToolProgressRows state={[{ ...entry, message: "Reading page 3", total: 100 }]} />);

        const bar = screen.getByRole("progressbar", { name: "Progress of index" });

        expect(bar.getAttribute("aria-valuenow")).toBe("25");
        expect(bar.getAttribute("aria-valuemin")).toBe("0");
        expect(bar.getAttribute("aria-valuemax")).toBe("100");
        expect(bar.dataset["indeterminate"]).toBeUndefined();
        expect(screen.getByText("index")).toBeDefined();
        expect(screen.getByText("Docs")).toBeDefined();
    });

    it("shows an indeterminate bar, with no value, when there is no total", () => {
        render(<ToolProgressRows state={[entry]} />);

        const bar = screen.getByRole("progressbar", { name: "Progress of index" });

        expect(bar.hasAttribute("aria-valuenow")).toBe(false);
        expect(bar.dataset["indeterminate"]).toBeDefined();
    });

    it("announces the latest message politely", () => {
        render(<ToolProgressRows state={[{ ...entry, message: "Reading page 3", total: 100 }]} />);

        const status = screen.getByRole("status");

        expect(status.textContent).toBe("Reading page 3");
        expect(status.getAttribute("aria-live")).toBe("polite");
    });

    it("lists calls running side by side", () => {
        render(
            <ToolProgressRows
                state={[
                    { ...entry, total: 10 },
                    { ...entry, toolCallId: "call_2", toolName: "crawl" },
                ]}
            />,
        );

        expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    });

    describe("live region", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        const row = (message: string) => <ToolProgressRows state={[{ ...entry, message, total: 100 }]} />;

        it("announces a changed message at most every 3 seconds, and the latest one", () => {
            const { rerender } = render(row("Page 1"));

            expect(screen.getByRole("status").textContent).toBe("Page 1");

            act(() => {
                vi.advanceTimersByTime(1000);
            });
            rerender(row("Page 2"));
            act(() => {
                vi.advanceTimersByTime(500);
            });
            rerender(row("Page 3"));

            // The sighted row follows at once; the announcement waits for the window to pass.
            expect(screen.getByText("Page 3", { selector: "p" })).toBeDefined();
            expect(screen.getByRole("status").textContent).toBe("Page 1");

            act(() => {
                vi.advanceTimersByTime(1499);
            });

            expect(screen.getByRole("status").textContent).toBe("Page 1");

            act(() => {
                vi.advanceTimersByTime(1);
            });

            expect(screen.getByRole("status").textContent).toBe("Page 3");
        });

        it("announces a change straight away once the window has passed", () => {
            const { rerender } = render(row("Page 1"));

            act(() => {
                vi.advanceTimersByTime(5000);
            });
            rerender(row("Page 2"));
            act(() => {
                vi.advanceTimersByTime(0);
            });

            expect(screen.getByRole("status").textContent).toBe("Page 2");
        });

        it("does not announce again when the message is unchanged", () => {
            const { rerender } = render(row("Page 1"));
            const region = screen.getByRole("status");

            rerender(<ToolProgressRows state={[{ ...entry, message: "Page 1", progress: 60, total: 100 }]} />);
            act(() => {
                vi.advanceTimersByTime(10_000);
            });

            expect(screen.getByRole("status")).toBe(region);
            expect(region.textContent).toBe("Page 1");
        });
    });
});
