import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import PasswordInput from "./password-input";

const meta = {
    args: { "aria-label": "Password", placeholder: "Enter your password" },
    component: PasswordInput,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    title: "UI/PasswordInput",
} satisfies Meta<typeof PasswordInput>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithToggle: Story = {
    args: { enableToggle: true },
    play: async ({ canvas }) => {
        const input = canvas.getByLabelText("Password");

        await expect(input).toHaveAttribute("type", "password");
        await userEvent.type(input, "hunter2");
        await userEvent.click(canvas.getByRole("button", { name: "Show password" }));
        await expect(input).toHaveAttribute("type", "text");
    },
};

export const Invalid: Story = { args: { "aria-invalid": true } };
