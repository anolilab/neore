import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, waitFor } from "storybook/test";

import { UniverSheetEditor } from "./univer-sheet-editor";

const CSV = `name,city,age
Ada,Berlin,31
Grace,Lisbon,27
Linus,Oslo,45`;

const meta = {
    args: { content: CSV, onContentChange: fn(), title: "People" },
    component: UniverSheetEditor,
    decorators: [
        (Story) => (
            <div className="h-[480px]">
                <Story />
            </div>
        ),
    ],
    // The toolbar and sheet bar are Univer's markup; the editor names and repairs them as Univer renders them
    // (univer-accessibility.ts), so these stories are checked like any other.
    title: "UI/Files/Univer sheet editor",
} satisfies Meta<typeof UniverSheetEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Waits until Univer has drawn the sheet's own canvas. Univer adds several canvases (the cell and formula-bar editors
 * have one each) and the sheet's can come last, so waiting for any canvas is not enough. The editor resets each
 * canvas's positive tabindex in the task that inserts it (univer-accessibility.tsx), so the a11y check after `play`
 * never sees one.
 */
const settled: Story["play"] = async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('canvas[id^="univer-sheet-main-canvas"]')).not.toBeNull(), { timeout: 15_000 });
    // Only the canvases: they are what the repair resets, and any other positive tabindex is left for the a11y check to report.
    expect(canvasElement.querySelector('canvas[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toBeNull();
};

export const Default: Story = {
    play: settled,
};

export const DarkMode: Story = {
    args: { darkMode: true },
    play: settled,
};

export const Empty: Story = {
    args: { content: "" },
    play: settled,
};
