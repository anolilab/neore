import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { Label } from "./label";

const meta = {
    args: { children: "Email", htmlFor: "story-label-email" },
    component: Label,
    title: "UI/Label",
} satisfies Meta<typeof Label>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByText("Email"));
        await expect(canvas.getByRole("textbox", { name: "Email" })).toHaveFocus();
    },
    render: (args) => (
        <div className="grid w-72 gap-2">
            <Label {...args} />
            <Input id="story-label-email" />
        </div>
    ),
};

export const WithCheckbox: Story = {
    args: { children: "Remember me", htmlFor: "story-label-remember" },
    render: (args) => (
        <div className="flex items-center gap-2">
            <Checkbox id="story-label-remember" />
            <Label {...args} />
        </div>
    ),
};

export const ForDisabledControl: Story = {
    args: { children: "Locked", className: "peer-disabled:opacity-50", htmlFor: "story-label-locked" },
    render: (args) => (
        <div className="flex items-center gap-2">
            <Checkbox disabled id="story-label-locked" />
            <Label {...args} />
        </div>
    ),
};
