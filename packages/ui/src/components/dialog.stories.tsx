import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import { Button } from "./button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle, DialogTrigger } from "./dialog";
import { Input } from "./input";

const meta = {
    args: { defaultOpen: true, onOpenChange: fn() },
    component: Dialog,
    render: (args) => (
        <Dialog {...args}>
            <DialogTrigger render={<Button variant="outline" />}>Rename chat</DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Rename chat</DialogTitle>
                    <DialogDescription>Pick a name you will recognise in the sidebar.</DialogDescription>
                </DialogHeader>
                <DialogPanel>
                    <Input aria-label="Chat name" defaultValue="Trip planning" />
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                    <Button>Save</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    ),
    title: "UI/Dialog",
} satisfies Meta<typeof Dialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const OpensFromTrigger: Story = {
    args: { defaultOpen: false },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Rename chat" }));
        await expect(await screen.findByRole("dialog", { name: "Rename chat" })).toBeInTheDocument();
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    },
};

export const EscapeCloses: Story = {
    play: async ({ args }) => {
        await screen.findByRole("dialog", { name: "Rename chat" });
        await userEvent.keyboard("{Escape}");
        await expect(args.onOpenChange).toHaveBeenCalledWith(false);
    },
};

export const BareFooter: Story = {
    render: (args) => (
        <Dialog {...args}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Leave workspace</DialogTitle>
                    <DialogDescription>You lose access to its chats and files.</DialogDescription>
                </DialogHeader>
                <DialogFooter variant="bare">
                    <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                    <Button variant="destructive">Leave</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    ),
};

export const WithoutCloseButton: Story = {
    play: async () => {
        await screen.findByRole("dialog", { name: "Finish setup" });
        await expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    },
    render: (args) => (
        <Dialog {...args}>
            <DialogContent showCloseButton={false}>
                <DialogHeader>
                    <DialogTitle>Finish setup</DialogTitle>
                    <DialogDescription>Choose how you want to sign in next time.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <DialogClose render={<Button />}>Continue</DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    ),
};

export const LongContent: Story = {
    render: (args) => (
        <Dialog {...args}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Terms of use</DialogTitle>
                    <DialogDescription>Scroll to read the full text.</DialogDescription>
                </DialogHeader>
                <DialogPanel>
                    {Array.from({ length: 20 }, (_, index) => (
                        <p className="mb-3 text-sm" key={index}>
                            Section {index + 1}. You keep ownership of what you create, and you agree not to misuse the service.
                        </p>
                    ))}
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button />}>Accept</DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    ),
};
