import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { Switch } from "./switch";

const meta = {
    args: { "aria-label": "Remember chats", onCheckedChange: fn() },
    argTypes: { size: { control: "inline-radio", options: ["sm", "default"] } },
    component: Switch,
    title: "UI/Switch",
} satisfies Meta<typeof Switch>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Off: Story = {
    play: async ({ args, canvas }) => {
        const toggle = canvas.getByRole("switch", { name: "Remember chats" });

        await userEvent.click(toggle);
        await expect(args.onCheckedChange).toHaveBeenCalledWith(true);
        await expect(toggle).toBeChecked();
    },
};

export const On: Story = { args: { defaultChecked: true } };

export const Small: Story = { args: { defaultChecked: true, size: "sm" } };

export const Disabled: Story = { args: { disabled: true } };

export const DisabledOn: Story = { args: { defaultChecked: true, disabled: true } };

export const WithLabel: Story = {
    args: { "aria-label": undefined, id: "story-memory" },
    render: (args) => (
        <div className="flex items-center gap-2">
            <Switch {...args} />
            <label className="text-sm" htmlFor="story-memory">
                Remember things across chats
            </label>
        </div>
    ),
};
