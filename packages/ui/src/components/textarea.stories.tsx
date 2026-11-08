import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { Textarea } from "./textarea";

const meta = {
    args: { "aria-label": "Message", placeholder: "Write a message" },
    argTypes: { size: { control: "inline-radio", options: ["sm", "default", "lg"] } },
    component: Textarea,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    title: "UI/Textarea",
} satisfies Meta<typeof Textarea>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        const field = canvas.getByRole("textbox", { name: "Message" });

        await userEvent.type(field, "Hello there");
        await expect(field).toHaveValue("Hello there");
    },
};

export const Small: Story = { args: { size: "sm" } };

export const Large: Story = { args: { size: "lg" } };

export const Disabled: Story = { args: { defaultValue: "Locked content", disabled: true } };

export const Invalid: Story = { args: { "aria-invalid": true, defaultValue: "Too short" } };

export const Expandable: Story = {
    args: { defaultValue: "A long note that can be opened in a larger editor.", expandable: true, expandableDialogTitle: "Edit message" },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Expand textarea" })).toBeVisible();
    },
};
