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

export const Default: Story = {
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(canvasElement.querySelector("canvas")).not.toBeNull(), { timeout: 15_000 });
    },
};

export const DarkMode: Story = {
    args: { darkMode: true },
};

export const Empty: Story = {
    args: { content: "" },
};
