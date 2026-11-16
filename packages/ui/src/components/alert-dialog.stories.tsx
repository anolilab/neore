import type { Meta, StoryObj } from "@storybook/react-vite";
import { TriangleAlertIcon } from "lucide-react";
import { expect, fn, screen, userEvent } from "storybook/test";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogMedia,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "./alert-dialog";
import { Button } from "./button";

const meta = {
    args: { defaultOpen: true, onOpenChange: fn() },
    component: AlertDialog,
    render: (args) => (
        <AlertDialog {...args}>
            <AlertDialogTrigger render={<Button variant="outline" />}>Delete chat</AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
                    <AlertDialogDescription>The messages and attachments in it are removed for good.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    ),
    title: "UI/Alert dialog",
} satisfies Meta<typeof AlertDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
    render: (args) => (
        <AlertDialog {...args}>
            <AlertDialogContent size="sm">
                <AlertDialogHeader>
                    <AlertDialogTitle>Sign out?</AlertDialogTitle>
                    <AlertDialogDescription>You can sign back in at any time.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Stay</AlertDialogCancel>
                    <AlertDialogAction>Sign out</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    ),
};

export const WithMedia: Story = {
    render: (args) => (
        <AlertDialog {...args}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogMedia>
                        <TriangleAlertIcon aria-hidden="true" />
                    </AlertDialogMedia>
                    <AlertDialogTitle>Remove this device?</AlertDialogTitle>
                    <AlertDialogDescription>It stops running agents until you pair it again.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive">Remove</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    ),
};

export const OpensFromTrigger: Story = {
    args: { defaultOpen: false },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Delete chat" }));
        await expect(await screen.findByRole("alertdialog", { name: "Delete this chat?" })).toBeInTheDocument();
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    },
};

export const CancelCloses: Story = {
    play: async ({ args }) => {
        await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        await expect(args.onOpenChange).toHaveBeenCalledWith(false);
    },
};
