import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Spinner } from "./spinner";

const meta = {
    component: Spinner,
    title: "UI/Spinner",
} satisfies Meta<typeof Spinner>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("status", { name: "Loading" })).toBeVisible();
    },
};

export const Large: Story = { args: { className: "size-8" } };
