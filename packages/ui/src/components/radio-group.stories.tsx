import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { RadioGroup, RadioGroupItem } from "./radio-group";

const meta = {
    args: { "aria-label": "Density", defaultValue: "comfortable", onValueChange: fn() },
    component: RadioGroup,
    render: (args) => (
        <RadioGroup {...args}>
            {["compact", "comfortable", "spacious"].map((value) => (
                <div className="flex items-center gap-2" key={value}>
                    <RadioGroupItem id={`story-density-${value}`} value={value} />
                    <label className="text-sm capitalize" htmlFor={`story-density-${value}`}>
                        {value}
                    </label>
                </div>
            ))}
        </RadioGroup>
    ),
    title: "UI/RadioGroup",
} satisfies Meta<typeof RadioGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("radio", { name: "compact" }));
        await expect(args.onValueChange).toHaveBeenCalledWith("compact");
        await expect(canvas.getByRole("radio", { name: "compact" })).toBeChecked();
    },
};

export const Disabled: Story = { args: { disabled: true } };

export const Invalid: Story = { args: { "aria-invalid": true } };
