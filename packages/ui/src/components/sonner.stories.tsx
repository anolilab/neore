import type { Meta, StoryObj } from "@storybook/react-vite";
import { toast } from "sonner";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { Button } from "./button";
import { Toaster } from "./sonner";

/** The preview already mounts one `Toaster`; the buttons below raise toasts on it. */
const meta = {
    component: Toaster,
    render: () => (
        <div className="flex flex-wrap gap-2">
            <Button onClick={() => toast("Chat archived")} variant="outline">
                Default
            </Button>
            <Button onClick={() => toast.success("Saved your changes")} variant="outline">
                Success
            </Button>
            <Button onClick={() => toast.error("Could not send the message")} variant="outline">
                Error
            </Button>
            <Button onClick={() => toast.warning("You are close to your usage limit")} variant="outline">
                Warning
            </Button>
            <Button onClick={() => toast.info("A new version is available")} variant="outline">
                Info
            </Button>
            <Button onClick={() => toast.loading("Uploading file")} variant="outline">
                Loading
            </Button>
        </div>
    ),
    title: "UI/Toaster",
} satisfies Meta<typeof Toaster>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Default: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Default" }));
        await waitFor(() => expect(screen.getByText("Chat archived")).toBeInTheDocument());
    },
};

export const Success: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Success" }));
        await waitFor(() => expect(screen.getByText("Saved your changes")).toBeInTheDocument());
    },
};

export const Failure: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Error" }));
        await waitFor(() => expect(screen.getByText("Could not send the message")).toBeInTheDocument());
    },
};

export const Warning: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Warning" }));
        await waitFor(() => expect(screen.getByText("You are close to your usage limit")).toBeInTheDocument());
    },
};
