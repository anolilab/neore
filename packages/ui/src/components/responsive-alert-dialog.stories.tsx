import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent } from "storybook/test";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "./responsive-alert-dialog";

/** A centered alert on wide screens and a bottom sheet below 768 px; the Mobile viewport shows the sheet. */
const meta = {
    args: { onOpenChange: fn(), open: true },
    component: AlertDialog,
    render: (args) => (
        <AlertDialog {...args}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                    <AlertDialogDescription>Its chats and files are removed for good.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    ),
    title: "UI/Responsive alert dialog",
} satisfies Meta<typeof AlertDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const OpensFromTrigger: Story = {
    args: { open: undefined },
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Delete project" }));
        await expect(await screen.findByText("Delete this project?")).toBeInTheDocument();
    },
    render: (args) => (
        <AlertDialog {...args}>
            <AlertDialogTrigger className="rounded-md border px-3 py-1.5 text-sm">Delete project</AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                    <AlertDialogDescription>Its chats and files are removed for good.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    ),
};
