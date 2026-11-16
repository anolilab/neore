import type { Meta, StoryObj } from "@storybook/react-vite";
import { BoldIcon } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";

import { Toggle } from "./toggle";

const meta = {
    args: { "aria-label": "Bold", children: <BoldIcon aria-hidden="true" />, onPressedChange: fn() },
    argTypes: {
        size: { control: "inline-radio", options: ["sm", "default", "lg"] },
        variant: { control: "inline-radio", options: ["default", "outline"] },
    },
    component: Toggle,
    title: "UI/Toggle",
} satisfies Meta<typeof Toggle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Off: Story = {
    play: async ({ args, canvas }) => {
        const toggle = canvas.getByRole("button", { name: "Bold" });

        await userEvent.click(toggle);
        await expect(args.onPressedChange).toHaveBeenCalled();
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
    },
};

export const On: Story = { args: { defaultPressed: true } };

export const Outline: Story = { args: { variant: "outline" } };

export const Small: Story = { args: { size: "sm" } };

export const Large: Story = { args: { size: "lg" } };

export const WithText: Story = { args: { "aria-label": undefined, children: "Italic" } };

export const Disabled: Story = { args: { disabled: true } };
