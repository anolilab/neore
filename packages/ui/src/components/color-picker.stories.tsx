import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";

import { Button } from "./button";
import { ColorPicker } from "./color-picker";

const meta = {
    args: { children: <Button variant="outline">Pick a color</Button>, onValueChange: fn(), value: "#2563eb" },
    component: ColorPicker,
    decorators: [
        (Story) => (
            <div className="flex min-h-[28rem] items-start justify-center pt-4">
                <Story />
            </div>
        ),
    ],
    title: "UI/Color picker",
} satisfies Meta<typeof ColorPicker>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Pick a color" })).toBeVisible();
    },
};
