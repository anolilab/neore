// @vitest-environment jsdom

/**
 * The MCP snippet shown beside a new key: it carries that key, the endpoint, and named copy buttons.
 * That its header is the one `authenticate` reads is pinned backend-side (`key-revocation.test.ts`).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

describe("McpConfigSnippet", () => {
    it("shows the Claude Code command and the JSON config for the new key", () => {
        render(<McpConfigSnippet apiKey="nk_secret" />);

        const command = `claude mcp add --transport http neore https://api.example.test/api/v1/mcp --header "Authorization: Bearer nk_secret"`;

        expect(screen.getByText(command)).toBeTruthy();
        expect(screen.getByText((content) => content.includes(`"Authorization": "Bearer nk_secret"`))).toBeTruthy();
    });

    it("gives every copy button an accessible name", () => {
        render(<McpConfigSnippet apiKey="nk_secret" />);

        expect(screen.getByRole("button", { name: "Copy the Claude Code command" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Copy the JSON configuration" })).toBeTruthy();
    });
});
