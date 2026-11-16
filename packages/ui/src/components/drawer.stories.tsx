import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";

import { Button } from "./button";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from "./drawer";

const meta = {
    args: { open: true },
    component: Drawer,
    render: (args) => (
        <Drawer {...args}>
            <DrawerTrigger asChild>
                <Button variant="outline">Open options</Button>
            </DrawerTrigger>
            <DrawerContent>
                <DrawerHeader>
                    <DrawerTitle>Chat options</DrawerTitle>
                    <DrawerDescription>Choose what to do with this chat.</DrawerDescription>
                </DrawerHeader>
                <DrawerFooter>
                    <Button>Pin chat</Button>
                    <DrawerClose asChild>
                        <Button variant="outline">Cancel</Button>
                    </DrawerClose>
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
    ),
    title: "UI/Drawer",
} satisfies Meta<typeof Drawer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Bottom: Story = {};

export const Right: Story = { args: { direction: "right" } };

export const Left: Story = { args: { direction: "left" } };

export const Top: Story = { args: { direction: "top" } };

export const OpensFromTrigger: Story = {
    args: { open: undefined },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Open options" }));
        await expect(await screen.findByRole("dialog", { name: "Chat options" })).toBeInTheDocument();
    },
};
