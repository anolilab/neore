import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

const meta = {
    args: { "aria-label": "Text alignment", defaultValue: ["left"], onValueChange: fn() },
    argTypes: {
        orientation: { control: "inline-radio", options: ["horizontal", "vertical"] },
        size: { control: "inline-radio", options: ["sm", "default", "lg"] },
        variant: { control: "inline-radio", options: ["default", "outline"] },
    },
    component: ToggleGroup,
    render: (args) => (
        <ToggleGroup {...args}>
            <ToggleGroupItem value="left">Left</ToggleGroupItem>
            <ToggleGroupItem value="center">Center</ToggleGroupItem>
            <ToggleGroupItem value="right">Right</ToggleGroupItem>
        </ToggleGroup>
    ),
    title: "UI/ToggleGroup",
} satisfies Meta<typeof ToggleGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Center" }));
        await expect(args.onValueChange).toHaveBeenCalled();
        await expect(canvas.getByRole("button", { name: "Center" })).toHaveAttribute("aria-pressed", "true");
    },
};

export const Outline: Story = { args: { variant: "outline" } };

export const WithSpacing: Story = { args: { spacing: 2, variant: "outline" } };

export const Multiple: Story = { args: { defaultValue: ["left", "right"], multiple: true } };

export const Vertical: Story = { args: { orientation: "vertical", variant: "outline" } };

export const Small: Story = { args: { size: "sm", variant: "outline" } };

export const Disabled: Story = { args: { disabled: true } };
