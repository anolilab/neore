import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import { Button } from "./button";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogTitle,
    DialogTrigger,
} from "./responsive-dialog";

const triggerClass = "rounded-md border px-3 py-1.5 text-sm";

/** A centered dialog on wide screens and a bottom sheet below 768 px; the Mobile viewport shows the sheet. */
const meta = {
    args: { onOpenChange: fn(), open: true },
    component: Dialog,
    render: (args) => (
        <Dialog {...args}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Invite people</DialogTitle>
                    <DialogDescription>They get an email with a link to join.</DialogDescription>
                </DialogHeader>
                <DialogPanel>
                    <p className="text-sm">Invitations expire after seven days.</p>
                </DialogPanel>
                <DialogFooter>
                    <DialogClose render={<Button variant="outline">Cancel</Button>} />
                    <Button>Send invite</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    ),
    title: "UI/Responsive dialog",
} satisfies Meta<typeof Dialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const OpensFromTrigger: Story = {
    args: { open: undefined },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Invite people" }));
        await expect(await screen.findByRole("dialog", { name: "Invite people" })).toBeInTheDocument();
    },
    render: (args) => (
        <Dialog {...args}>
            <DialogTrigger className={triggerClass}>Invite people</DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Invite people</DialogTitle>
                    <DialogDescription>They get an email with a link to join.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button>Send invite</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    ),
};
