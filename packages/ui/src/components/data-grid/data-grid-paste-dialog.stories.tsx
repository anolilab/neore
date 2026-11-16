import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import DataGridPasteDialog from "./data-grid-paste-dialog";

const onCellsPaste = fn();

const meta: Meta<typeof DataGridPasteDialog> = {
    args: {
        pasteDialog: { clipboardText: "a\tb\nc\td\ne\tf", open: true, rowsNeeded: 3 },
        tableMeta: { onCellsPaste, onPasteDialogOpenChange: fn() },
    },
    component: DataGridPasteDialog,
    title: "UI/Data grid/Data grid paste dialog",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async () => {
        await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
        await expect(onCellsPaste).toHaveBeenCalledWith(true);
    },
};

export const SingleRowNeeded: Story = {
    args: { pasteDialog: { clipboardText: "a\nb", open: true, rowsNeeded: 1 } },
};

export const KeepCurrentRows: Story = {
    play: async () => {
        await userEvent.click(await screen.findByRole("radio", { name: /Keep current rows/ }));
        await userEvent.click(screen.getByRole("button", { name: "Continue" }));
        await expect(onCellsPaste).toHaveBeenCalledWith(false);
    },
};
