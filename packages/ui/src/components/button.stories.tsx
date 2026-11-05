import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";

import { Button } from "./button";

const meta = {
    args: { children: "Continue", onClick: fn() },
    argTypes: {
        size: { control: "select", options: ["xs", "sm", "default", "lg", "icon-xs", "icon-sm", "icon", "icon-lg"] },
        variant: { control: "select", options: ["default", "secondary", "outline", "ghost", "destructive", "link"] },
    },
    component: Button,
    title: "UI/Button",
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
        await expect(args.onClick).toHaveBeenCalledOnce();
    },
};

export const Secondary: Story = { args: { variant: "secondary" } };

export const Outline: Story = { args: { variant: "outline" } };

export const Ghost: Story = { args: { variant: "ghost" } };

export const Destructive: Story = {
    args: { children: "Delete", variant: "destructive" },
    // `text-destructive` on its own 10% tint is 4.1:1 in light mode (AA needs 4.5:1). Found by this story.
    parameters: { a11y: { test: "todo" } },
};

export const Disabled: Story = {
    args: { disabled: true },
    play: async ({ args, canvas }) => {
        await expect(canvas.getByRole("button", { name: "Continue" })).toBeDisabled();
        await expect(args.onClick).not.toHaveBeenCalled();
    },
};

export const WithIcons: Story = {
    args: {
        children: (
            <>
                <Plus aria-hidden="true" data-icon="inline-start" />
                New chat
                <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </>
        ),
    },
};

export const IconOnly: Story = {
    args: { "aria-label": "Delete thread", children: <Trash2 aria-hidden="true" />, size: "icon", variant: "ghost" },
};

/** Every variant at every text size, for a contrast check per theme and accent. */
export const Matrix: Story = {
    // `link` is `text-primary`: the lime accent as text, 1.05:1 on the light page. Moving it to
    // `--primary-text` is #546; `destructive` as above.
    parameters: { a11y: { test: "todo" } },
    render: (args) => (
        <div className="grid grid-cols-6 items-center gap-3">
            {(["default", "secondary", "outline", "ghost", "destructive", "link"] as const).map((variant) =>
                (["xs", "sm", "default", "lg"] as const).map((size) => (
                    <Button {...args} key={`${variant}-${size}`} size={size} variant={variant}>
                        {variant}
                    </Button>
                )),
            )}
        </div>
    ),
};
