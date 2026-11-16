import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import ConfirmDialog from "./confirm-dialog";

const meta: Meta<typeof ConfirmDialog> = {
    args: {
        description: "Shared links to it stop working.",
        onConfirm: fn(),
        onOpenChange: fn(),
        open: true,
        title: "Archive this project?",
    },
    component: ConfirmDialog,
    title: "UI/Confirm dialog",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args }) => {
        await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
        await expect(args.onConfirm).toHaveBeenCalledOnce();
    },
};

export const CustomLabels: Story = { args: { cancelLabel: "Keep it", confirmLabel: "Archive" } };

export const WithoutDescription: Story = { args: { description: undefined } };

export const Loading: Story = {
    args: { loading: true },
    play: async () => {
        await expect(await screen.findByRole("button", { name: "Confirm" })).toBeDisabled();
        await expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    },
};
