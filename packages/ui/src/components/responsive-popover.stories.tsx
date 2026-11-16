import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import { Button } from "./button";
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "./responsive-popover";

/** A positioned popover on wide screens and a bottom sheet below 768 px; the Mobile viewport shows the sheet. */
const meta: Meta<typeof Popover> = {
    args: { onOpenChange: fn(), open: true },
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
                <PopoverClose>Done</PopoverClose>
            </PopoverContent>
        </Popover>
    ),
    title: "UI/Responsive popover",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const OpensFromTrigger: Story = {
    args: { open: undefined },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Share" }));
        await expect(await screen.findByText("Share this chat")).toBeInTheDocument();
    },
};
