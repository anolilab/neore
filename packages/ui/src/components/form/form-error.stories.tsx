import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import FormError from "./form-error";

const meta = {
    args: { error: "The email or password is incorrect." },
    component: FormError,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    title: "UI/FormError",
} satisfies Meta<typeof FormError>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("alert")).toHaveTextContent("The email or password is incorrect.");
    },
};

export const CustomTitle: Story = { args: { title: "Sign in failed" } };

export const NoError: Story = {
    args: { error: undefined },
    play: async ({ canvas }) => {
        await expect(canvas.queryByRole("alert")).toBeNull();
    },
};
