import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { FetchedTextPreview } from "./fetched-text-preview";

const textUrl = (text: string): string => `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;

const NOTES = "Release checklist\n- Freeze the branch\n- Run the full test suite\n- Tag and publish";

const meta = {
    args: {
        children: (text: string) => <pre className="max-h-64 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>,
        fallbackName: "Text file",
        filename: "notes.txt",
        url: textUrl(NOTES),
    },
    component: FetchedTextPreview,
    title: "UI/Files/FetchedTextPreview",
} satisfies Meta<typeof FetchedTextPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/Freeze the branch/u)).toBeVisible();
        await expect(canvas.getByRole("link", { name: "Download notes.txt" })).toBeVisible();
    },
};

/** Without a file name the frame titles itself with `fallbackName`. */
export const Unnamed: Story = {
    args: { filename: undefined },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Text file")).toBeVisible();
    },
};

/** A URL the preview may not fetch shows the download card instead. */
export const CouldNotPreview: Story = {
    args: { url: "https://example.invalid/blocked.txt" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Could not preview · Click to download")).toBeVisible();
    },
};

/** `refusal` keeps a readable file off the preview and gives the reason on the card. */
export const Refused: Story = {
    args: { refusal: () => "Too long to preview · Click to download" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Too long to preview · Click to download")).toBeVisible();
    },
};
