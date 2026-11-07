import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { Checkbox } from "./checkbox";

const meta = {
    args: { "aria-label": "Accept terms", onCheckedChange: fn() },
    component: Checkbox,
    title: "UI/Checkbox",
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {
    play: async ({ args, canvas }) => {
        const box = canvas.getByRole("checkbox", { name: "Accept terms" });

        await userEvent.click(box);
        await expect(args.onCheckedChange).toHaveBeenCalledWith(true);
        await expect(box).toBeChecked();
    },
};

export const Checked: Story = { args: { defaultChecked: true } };

export const Indeterminate: Story = { args: { indeterminate: true } };

export const Disabled: Story = { args: { disabled: true } };

export const DisabledChecked: Story = { args: { defaultChecked: true, disabled: true } };

export const Invalid: Story = { args: { "aria-invalid": true } };

export const WithLabel: Story = {
    args: { "aria-label": undefined, id: "story-terms" },
    render: (args) => (
        <div className="flex items-center gap-2">
            <Checkbox {...args} />
            <label className="text-sm" htmlFor="story-terms">
                I accept the terms
            </label>
        </div>
    ),
};
