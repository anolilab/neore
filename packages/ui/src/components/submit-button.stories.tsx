import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import SubmitButton from "./submit-button";

const meta = {
    args: { children: "Save changes", isSubmitting: false },
    component: SubmitButton,
    title: "UI/SubmitButton",
} satisfies Meta<typeof SubmitButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Submitting: Story = {
    args: { isSubmitting: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button")).toBeDisabled();
        await expect(canvas.getByRole("status", { name: "Loading" })).toBeVisible();
    },
};

export const Disabled: Story = { args: { disabled: true } };
