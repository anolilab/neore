import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import { Button } from "./button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "./popover";

const meta: Meta<typeof Popover> = {
    args: { defaultOpen: true, onOpenChange: fn() },
    component: Popover,
    decorators: [
        (Story) => (
            <div className="flex min-h-64 items-start justify-center pt-4">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Popover {...args}>
            <PopoverTrigger render={<Button variant="outline">Share</Button>} />
            <PopoverContent>
                <PopoverHeader>
                    <PopoverTitle>Share this chat</PopoverTitle>
                    <PopoverDescription>Anyone with the link can read it.</PopoverDescription>
                </PopoverHeader>
            </PopoverContent>
        </Popover>
    ),
    title: "UI/Popover",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Closed: Story = { args: { defaultOpen: false } };

export const OpensFromTrigger: Story = {
    args: { defaultOpen: false },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Share" }));
        await expect(await screen.findByText("Share this chat")).toBeInTheDocument();
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    },
};

export const Aligned: Story = {
    render: (args) => (
        <Popover {...args}>
            <PopoverTrigger render={<Button variant="outline">Share</Button>} />
            <PopoverContent align="start" side="right">
                <PopoverHeader>
                    <PopoverTitle>Share this chat</PopoverTitle>
                    <PopoverDescription>Opens to the right, aligned to the start.</PopoverDescription>
                </PopoverHeader>
            </PopoverContent>
        </Popover>
    ),
};
