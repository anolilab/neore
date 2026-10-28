// @vitest-environment jsdom

/**
 * The MCP snippet shown beside a new key: it carries that key, the endpoint, and named copy buttons.
 * That its header is the one `authenticate` reads is pinned backend-side (`key-revocation.test.ts`).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => vi.fn());

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { toast };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/env", () => {
    return { default: { VITE_LUNORA_URL: "https://api.example.test" } };
});

const { default: McpConfigSnippet } = await import("./mcp-config-snippet");

const writeText = vi.fn();

describe("McpConfigSnippet", () => {
    beforeEach(() => {
        toast.mockReset();
        writeText.mockReset();
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    });

    it("shows the Claude Code command and the JSON config for the new key", () => {
        render(<McpConfigSnippet apiKey="nk_test" />);

        const add = `claude mcp add --transport http neore https://api.example.test/api/v1/mcp --header "Authorization: Bearer $NEORE_API_KEY"`;

        expect(screen.getByText((content) => content.includes("export NEORE_API_KEY='nk_test'") && content.includes(add))).toBeTruthy();
        expect(screen.getByText((content) => content.includes(`"Authorization": "Bearer nk_test"`))).toBeTruthy();
    });

    it("gives every copy button an accessible name", () => {
        render(<McpConfigSnippet apiKey="nk_test" />);

        expect(screen.getByRole("button", { name: "Copy the Claude Code command" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Copy the JSON configuration" })).toBeTruthy();
    });

    it("announces a successful copy and leaves the button usable", async () => {
        writeText.mockResolvedValue(undefined);
        render(<McpConfigSnippet apiKey="nk_test" />);

        const button = screen.getByRole("button", { name: "Copy the JSON configuration" });

        fireEvent.click(button);

        await waitFor(() => expect(screen.getAllByRole("status").some((status) => status.textContent === "Copied")).toBe(true));
        expect((button as HTMLButtonElement).disabled).toBe(false);
        expect(toast).not.toHaveBeenCalled();
    });

    it("reports a refused clipboard write instead of saying it copied", async () => {
        writeText.mockRejectedValue(new Error("denied"));
        render(<McpConfigSnippet apiKey="nk_test" />);

        fireEvent.click(screen.getByRole("button", { name: "Copy the JSON configuration" }));

        await waitFor(() => expect(toast).toHaveBeenCalledWith({ message: "Could not copy to the clipboard", variant: "error" }));
        expect(screen.getAllByRole("status").every((status) => status.textContent === "")).toBe(true);
    });
});
