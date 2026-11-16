import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import { Button } from "./button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "./sheet";

const meta = {
    args: { defaultOpen: true, onOpenChange: fn() },
    component: Sheet,
    render: (args) => (
        <Sheet {...args}>
            <SheetTrigger render={<Button variant="outline" />}>Open filters</SheetTrigger>
            <SheetContent>
                <SheetHeader>
                    <SheetTitle>Filters</SheetTitle>
                    <SheetDescription>Narrow the chat list by date or model.</SheetDescription>
                </SheetHeader>
                <SheetFooter>
                    <SheetClose render={<Button variant="outline" />}>Done</SheetClose>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    ),
    title: "UI/Sheet",
} satisfies Meta<typeof Sheet>;

export default meta;

type Story = StoryObj<typeof meta>;

const sideStory = (side: "bottom" | "left" | "right" | "top"): Story => {
    return {
        render: (args) => (
            <Sheet {...args}>
                <SheetContent side={side}>
                    <SheetHeader>
                        <SheetTitle>Filters</SheetTitle>
                        <SheetDescription>Narrow the chat list by date or model.</SheetDescription>
                    </SheetHeader>
                </SheetContent>
            </Sheet>
        ),
    };
};

export const Right: Story = {};

export const Left: Story = sideStory("left");

export const Top: Story = sideStory("top");

export const Bottom: Story = sideStory("bottom");

export const WithoutCloseButton: Story = {
    render: (args) => (
        <Sheet {...args}>
            <SheetContent showCloseButton={false}>
                <SheetHeader>
                    <SheetTitle>Filters</SheetTitle>
                    <SheetDescription>Narrow the chat list by date or model.</SheetDescription>
                </SheetHeader>
                <SheetFooter>
                    <SheetClose render={<Button />}>Done</SheetClose>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    ),
};

export const OpensFromTrigger: Story = {
    args: { defaultOpen: false },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Open filters" }));
        await expect(await screen.findByRole("dialog", { name: "Filters" })).toBeInTheDocument();
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    },
};
