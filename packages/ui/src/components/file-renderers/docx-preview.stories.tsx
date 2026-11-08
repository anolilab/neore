import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import DocxPreview from "./docx-preview";

/**
 * Only the failure state has a story. A document that converts is not shown: the converter
 * (mammoth) calls the XML parser without a MIME type, which the pinned parser version
 * (the security override in pnpm-workspace.yaml) rejects, so every .docx lands on the card.
 */
const meta = {
    args: { filename: "meeting-notes.docx", url: `data:text/plain;base64,${btoa("not a document")}` },
    component: DocxPreview,
    title: "UI/Files/DocxPreview",
} satisfies Meta<typeof DocxPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A file that is not a .docx shows the download card. */
export const CouldNotPreview: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Could not preview · Click to download", {}, { timeout: 5000 })).toBeVisible();
        await expect(canvas.getByRole("link", { name: /^Download meeting-notes\.docx/u })).toBeVisible();
    },
};

export const Unnamed: Story = {
    args: { filename: undefined },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Could not preview · Click to download", {}, { timeout: 5000 })).toBeVisible();
    },
};
