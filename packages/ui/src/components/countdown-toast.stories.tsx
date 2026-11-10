import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, screen, userEvent, waitFor } from "storybook/test";

import { Button } from "./button";
import { countdownToast } from "./countdown-toast";

const meta = {
    args: { onUndo: fn() },
    render: ({ onUndo }: { onUndo: () => void }) => (
        <div className="flex flex-wrap gap-2">
            <Button
                onClick={() =>
                    countdownToast({
                        action: { label: "Undo", onClick: onUndo },
                        cancel: { label: "Dismiss", onClick: () => undefined },
                        description: "This message will close in 5 seconds.",
                        title: "Changes saved",
                    })
                }
                variant="outline"
            >
                Neutral
            </Button>
            <Button
                onClick={() =>
                    countdownToast({
                        action: { label: "Undo", onClick: onUndo },
                        countdownLabel: (seconds) => `Permanently deleted in ${seconds} seconds`,
                        cancel: { label: "Dismiss", onClick: () => undefined },
                        description: "INV-2026-0412 moved to trash.",
                        title: "Invoice deleted",
                        tone: "destructive",
                    })
                }
                variant="outline"
            >
                Destructive
            </Button>
        </div>
    ),
    title: "UI/Countdown toast",
} satisfies Meta<{ onUndo: () => void }>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Neutral: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Neutral" }));
        await screen.findAllByText(/This message will close in/);
        await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
        expect(args.onUndo).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument());
    },
};

export const Destructive: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Destructive" }));
        await screen.findAllByText(/Permanently deleted in/);
        await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
        expect(args.onUndo).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument());
    },
};
