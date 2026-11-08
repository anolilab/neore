import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";

import { IconPicker } from "./icon-picker";

const meta: Meta<typeof IconPicker> = {
    args: { onOpenChange: fn(), onValueChange: fn() },
    component: IconPicker,
    decorators: [
        (Story) => (
            <div className="flex min-h-24 items-start justify-center pt-4">
                <Story />
            </div>
        ),
    ],
    title: "UI/Icon picker",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Select an icon" })).toBeVisible();
    },
};

export const WithValue: Story = {
    args: { defaultValue: "star" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "star" })).toBeVisible();
    },
};

export const CustomPlaceholder: Story = {
    args: { triggerPlaceholder: "Choose a chat icon" },
};
