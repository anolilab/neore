/**
 * The host composer's context row: the computer, the folder and the agent, under the message box. The computer is left out until the
 * device list has answered, and named as removed when the list no longer has it.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import HostContextRow from "./host-context-row";

// Unit tests do not compile the Lingui macros.
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

describe("host context row", () => {
    it("names the computer, the folder and the agent in a group", () => {
        render(<HostContextRow agentLabel="Claude Code" deviceName="nova" folderLabel="~/Projects/billing" />);

        const group = screen.getByRole("group", { name: "Context" });

        expect(group.textContent).toContain("nova");
        expect(group.textContent).toContain("~/Projects/billing");
        expect(group.textContent).toContain("Claude Code");
    });

    it("says what the computer chip is for a screen reader", () => {
        render(<HostContextRow agentLabel="Claude Code" deviceName="nova" folderLabel="~/Projects/billing" />);

        expect(screen.getByText("Computer").className).toContain("sr-only");
    });

    it("leaves the computer out while the device list loads", () => {
        render(<HostContextRow agentLabel="Claude Code" deviceName={undefined} folderLabel="~/Projects/billing" />);

        expect(screen.queryByText("Computer")).toBeNull();
        expect(screen.getByRole("group", { name: "Context" }).textContent).toContain("~/Projects/billing");
    });

    it("names a computer the list no longer has as removed", () => {
        render(<HostContextRow agentLabel="Claude Code" deviceName={null} folderLabel="~/Projects/billing" />);

        expect(screen.getByRole("group", { name: "Context" }).textContent).toContain("Device removed");
    });
});
