import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import PdfViewer from "./pdf-viewer";

/**
 * A rendered page is not shown here: pdf.js runs its worker from a hashed asset, which the
 * Storybook dev server does not serve as a worker, so no document ever loads. The toolbar does not need one.
 */
const meta = {
    args: { filename: "handbook.pdf", url: `data:application/pdf;base64,${btoa("not a pdf")}` },
    component: PdfViewer,
    title: "UI/Files/PdfViewer",
} satisfies Meta<typeof PdfViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ZoomControls: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Zoom in" }));
        await expect(canvas.getByText("125%")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "Zoom out" }));
        await expect(canvas.getByText("100%")).toBeVisible();
    },
};

/** Paging is disabled until a document has loaded. */
export const PagingDisabled: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Previous page" })).toBeDisabled();
        await expect(canvas.getByRole("button", { name: "Next page" })).toBeDisabled();
    },
};

export const Unnamed: Story = { args: { filename: undefined } };
