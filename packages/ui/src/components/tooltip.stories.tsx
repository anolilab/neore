import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";

import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const meta: Meta<typeof Tooltip> = {
    args: { defaultOpen: true },
    component: Tooltip,
    decorators: [
        (Story) => (
            <div className="flex min-h-32 items-center justify-center">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Tooltip {...args}>
            <TooltipTrigger render={<Button variant="outline">Copy</Button>} />
            <TooltipContent>Copy to clipboard</TooltipContent>
        </Tooltip>
    ),
    title: "UI/Tooltip",
};

export default meta;

type Story = StoryObj<typeof meta>;

const sideStory = (side: "bottom" | "left" | "right" | "top"): Story => {
    return {
        render: (args) => (
            <Tooltip {...args}>
                <TooltipTrigger render={<Button variant="outline">Copy</Button>} />
                <TooltipContent side={side}>Copy to clipboard</TooltipContent>
            </Tooltip>
        ),
    };
};

export const Top: Story = {};

export const Bottom: Story = sideStory("bottom");

export const Left: Story = sideStory("left");

export const Right: Story = sideStory("right");

export const OnHover: Story = {
    args: { defaultOpen: false },
    play: async ({ canvas }) => {
        await userEvent.hover(canvas.getByRole("button", { name: "Copy" }));
        await expect(await screen.findByText("Copy to clipboard")).toBeInTheDocument();
    },
};

export const OnKeyboardFocus: Story = {
    args: { defaultOpen: false },
    play: async () => {
        await userEvent.tab();
        await expect(await screen.findByText("Copy to clipboard")).toBeInTheDocument();
    },
};
