import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
});
