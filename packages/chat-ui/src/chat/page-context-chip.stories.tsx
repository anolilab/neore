import type { PageContextMarker } from "@neore/ai/gateway";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import PageContextChip from "./page-context-chip";

/** The stored text of a page part: the page, wrapped as JSON, which is what the chip reads back. */
const PAGE_TEXT = JSON.stringify({
    pageText: "Storybook is a frontend workshop for building UI components and pages in isolation.",
    selectedText: "Build UI components in isolation.",
});

const PAGE: PageContextMarker = { kind: "page", title: "Storybook: Frontend workshop for UI development", url: "https://storybook.js.org/docs/get-started" };

const meta: Meta<typeof PageContextChip> = {
    args: { info: PAGE, text: PAGE_TEXT },
    component: PageContextChip,
    title: "Chat/PageContextChip",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Page: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Page context")).toBeVisible();
        await expect(canvas.getByRole("link", { name: "storybook.js.org" })).toHaveAttribute("href", PAGE.url);
    },
};

export const Selection: Story = {
    args: { info: { ...PAGE, kind: "selection" } },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Selection context")).toBeVisible();
    },
};

export const Expanded: Story = {
    play: async ({ canvas }) => {
        const toggle = canvas.getByRole("button", { name: "Show attached content" });

        await userEvent.click(toggle);
        await expect(canvas.getByRole("button", { name: "Hide attached content" })).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByText(/Build UI components in isolation\./u)).toBeVisible();
    },
};

/** Text the marker cannot decode shows a placeholder when expanded. */
export const NothingToShow: Story = {
    args: { text: "not json" },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Show attached content" }));
        await expect(canvas.getByText("No text to show.")).toBeVisible();
    },
};

/** Only http(s) addresses are links; anything else is shown as text. */
export const UnsafeUrl: Story = {
    args: { info: { ...PAGE, url: "ftp://files.example.com/report.txt" } },
    play: async ({ canvas }) => {
        await expect(canvas.queryByRole("link")).toBeNull();
        await expect(canvas.getByText("ftp://files.example.com/report.txt")).toBeVisible();
    },
};
