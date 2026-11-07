import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import ModeToggle from "./theme-toggle";

const meta = {
    component: ModeToggle,
    title: "UI/Theme toggle",
} satisfies Meta<typeof ModeToggle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        const toggle = canvas.getByRole("button", { name: "Toggle theme" });

        await userEvent.click(toggle);
        await expect(toggle).toBeVisible();
    },
};
