import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import GenericFileCard from "./generic-file-card";

const meta = {
    args: { filename: "quarterly-report.pdf", fileSize: 1_258_291, mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" },
    component: GenericFileCard,
    title: "UI/Files/GenericFileCard",
} satisfies Meta<typeof GenericFileCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas, canvasElement }) => {
        const link = await canvas.findByRole("link", { name: /^Download quarterly-report\.pdf/u });

        await expect(link).toHaveAttribute("download", "quarterly-report.pdf");
        await expect(canvasElement).toHaveTextContent("1.2 MB");
    },
};

export const Archive: Story = { args: { filename: "export.zip", fileSize: 48_000_000, mediaType: "application/zip" } };

export const Spreadsheet: Story = { args: { filename: "budget.csv", fileSize: 2048, mediaType: "text/csv" } };

export const Audio: Story = { args: { filename: "voice-note.mp3", fileSize: 320_000, mediaType: "audio/mpeg" } };

/** The icon falls back to the file extension when there is no media type. */
export const ByExtensionOnly: Story = { args: { filename: "main.py", fileSize: undefined, mediaType: undefined } };

export const UnknownType: Story = { args: { filename: "notes.unknown", fileSize: undefined, mediaType: undefined } };

/** Stands in for a preview that could not be shown. */
export const PreviewFailed: Story = {
    args: { description: "Could not preview · Click to download", filename: "report.docx", mediaType: undefined },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Could not preview · Click to download")).toBeVisible();
    },
};

export const NoName: Story = { args: { filename: undefined, fileSize: undefined, mediaType: undefined } };
