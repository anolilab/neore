import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import DataGridKeyboardShortcuts from "./data-grid-keyboard-shortcuts";

const meta: Meta<typeof DataGridKeyboardShortcuts> = {
    component: DataGridKeyboardShortcuts,
    title: "UI/Data grid/Data grid keyboard shortcuts",
};

export default meta;

type Story = StoryObj<typeof meta>;

// The dialog has no trigger of its own: Ctrl or Cmd + / opens it.
const openDialog = async () => {
    await userEvent.keyboard("{Control>}/{/Control}");

    return screen.findByRole("dialog", { name: "Keyboard shortcuts" });
};

export const Default: Story = {
    play: async () => {
        const element = await openDialog();

        await waitFor(() => expect(element).toBeVisible());
    },
};

export const WithSearchShortcuts: Story = {
    args: { enableSearch: true },
    play: async () => {
        const element = await openDialog();

        await waitFor(() => expect(element).toBeVisible());
    },
};

export const NoResults: Story = {
    play: async () => {
        await openDialog();
        await userEvent.type(await screen.findByPlaceholderText("Search shortcuts..."), "zzzzzz");
        await expect(await screen.findByText("No shortcuts found")).toBeInTheDocument();
    },
};

export const Closed: Story = {
    play: async () => {
        await expect(screen.queryByRole("dialog")).toBeNull();
    },
};
