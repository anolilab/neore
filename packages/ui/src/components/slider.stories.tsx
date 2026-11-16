import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { Slider } from "./slider";

const meta = {
    args: { defaultValue: [40], onValueChange: fn(), thumbLabel: "Volume" },
    component: Slider,
    decorators: [
        (Story) => (
            <div className="w-72">
                <Story />
            </div>
        ),
    ],
    title: "UI/Slider",
} satisfies Meta<typeof Slider>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        const thumb = canvas.getByRole("slider", { name: "Volume" });

        thumb.focus();
        // ArrowUp raises the value in both text directions; ArrowRight flips in right-to-left.
        await userEvent.keyboard("{ArrowUp}");
        await expect(args.onValueChange).toHaveBeenCalled();
        await expect(thumb).toHaveValue("41");
    },
};

export const Range: Story = { args: { defaultValue: [20, 70], thumbLabel: "Price" } };

export const Stepped: Story = { args: { defaultValue: [50], step: 25 } };

export const Disabled: Story = { args: { disabled: true } };

export const Vertical: Story = {
    args: { orientation: "vertical" },
    decorators: [
        (Story) => (
            <div className="h-48">
                <Story />
            </div>
        ),
    ],
};
