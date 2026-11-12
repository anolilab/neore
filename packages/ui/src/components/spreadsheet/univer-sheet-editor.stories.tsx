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
 * Waits until Univer has drawn its canvas and the editor's repairs (univer-accessibility.tsx, run from a
 * MutationObserver) have caught up: the a11y check runs right after `play`, and a canvas still carrying Univer's own
 * positive tabindex fails it.
 */
const settled: Story["play"] = async ({ canvasElement }) => {
    // Two waits, so a timeout names the condition that was not met.
    await waitFor(() => expect(canvasElement.querySelector("canvas")).not.toBeNull(), { timeout: 15_000 });
    // Only the canvases: they are what the repair resets, and any other positive tabindex is left for the a11y check to report.
    await waitFor(() => expect(canvasElement.querySelector('canvas[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toBeNull(), { timeout: 15_000 });
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
