import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen } from "storybook/test";

import { Button } from "./button";
import KeybindingTooltip from "./keybinding-tooltip";
import { Tooltip, TooltipTrigger } from "./tooltip";

const meta: Meta<typeof KeybindingTooltip> = {
    args: { children: null, text: "New chat (Ctrl+K)" },
    component: KeybindingTooltip,
    decorators: [
        (Story) => (
            <div className="flex min-h-32 items-center justify-center">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Tooltip defaultOpen>
            <KeybindingTooltip {...args}>
                <TooltipTrigger render={<Button variant="outline">New chat</Button>} />
            </KeybindingTooltip>
        </Tooltip>
    ),
    title: "UI/Keybinding tooltip",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async () => {
        await expect(await screen.findByText("New chat (Ctrl+K)")).toBeInTheDocument();
    },
};

export const Right: Story = { args: { side: "right" } };

export const Bottom: Story = { args: { align: "start", side: "bottom" } };

export const Hidden: Story = {
    args: { hidden: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "New chat" })).toBeInTheDocument();
        await expect(screen.queryByText("New chat (Ctrl+K)")).not.toBeInTheDocument();
    },
};
