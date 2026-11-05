import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { Input } from "./input";

const meta = {
    args: { "aria-label": "Email", placeholder: "you@example.com", type: "email" },
    argTypes: { size: { control: "inline-radio", options: ["sm", "default", "lg"] } },
    component: Input,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    title: "UI/Input",
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        const input = canvas.getByRole("textbox", { name: "Email" });

        await userEvent.type(input, "ada@neore.test");
        await expect(input).toHaveValue("ada@neore.test");
    },
};

export const Filled: Story = { args: { defaultValue: "ada@neore.test" } };

export const Small: Story = { args: { size: "sm" } };

export const Large: Story = { args: { size: "lg" } };

export const Invalid: Story = { args: { "aria-invalid": true, defaultValue: "not-an-email" } };

export const Disabled: Story = { args: { defaultValue: "ada@neore.test", disabled: true } };

export const WithLabel: Story = {
    args: { "aria-label": undefined, id: "story-email" },
    render: (args) => (
        <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="story-email">
                Email
            </label>
            <Input {...args} />
        </div>
    ),
};
