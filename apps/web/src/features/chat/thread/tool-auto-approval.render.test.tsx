// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ToolAutoApproval from "./tool-auto-approval";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
                    if (typeof strings === "string") {
                        return strings;
                    }

                    return strings.map((chunk, index) => `${chunk}${String(values[index] ?? "")}`).join("");
                },
            };
        },
    };
});

describe("ToolAutoApproval", () => {
    it("says the call was approved automatically and why", () => {
        render(<ToolAutoApproval reason="Reads a forecast." />);

        expect(screen.getByTestId("tool-auto-approval").textContent).toContain("Approved automatically — low risk");
        expect(screen.getByTestId("tool-auto-approval").textContent).toContain("Reads a forecast.");
    });

    it("shows the reason as plain text, never as markup", () => {
        render(<ToolAutoApproval reason={`<img src=x onerror="alert(1)"> **bold**`} />);

        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.getByTestId("tool-auto-approval").textContent).toContain('<img src=x onerror="alert(1)"> **bold**');
    });
});
