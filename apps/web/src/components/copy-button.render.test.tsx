// @vitest-environment jsdom

/**
 * The copy button is icon-only, so its screen-reader label is the only name it has.
 * A literal `$` in front of the translated text made it read "$Copy to clipboard".
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

const { default: CopyButton } = await import("./copy-button");

describe("CopyButton", () => {
    it("names the button without a stray dollar sign", () => {
        render(<CopyButton textToCopy="hello" />);

        const button = screen.getByRole("button", { name: "Copy to clipboard" });

        expect(button.textContent).toBe("Copy to clipboard");
    });
});
