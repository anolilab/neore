import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { Thread } from "../types/thread";
import ThreadItem from "./thread-item";

const HOUR = 3_600_000;

/** The story clock is pinned to this instant (5 Nov 2026, 12:00 UTC), so the relative time does not drift. */
const NOW = Date.UTC(2026, 10, 5, 12);

const THREAD: Thread = { _creationTime: NOW - 3 * HOUR, _id: "thread-1", title: "Plan the Q1 roadmap" };

const meta: Meta<typeof ThreadItem> = {
    args: { onSelect: fn(), thread: THREAD },
    component: ThreadItem,
    decorators: [
        (Story) => (
            <div className="w-72">
                <Story />
            </div>
        ),
    ],
    title: "Chat/ThreadItem",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: /Plan the Q1 roadmap/u }));
        await expect(args.onSelect).toHaveBeenCalledOnce();
    },
};

export const Selected: Story = {
    args: { isSelected: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /Plan the Q1 roadmap/u })).toHaveAttribute("aria-current", "page");
    },
};

export const Pinned: Story = { args: { thread: { ...THREAD, pinnedAt: NOW - HOUR } } };

export const Untitled: Story = {
    args: { thread: { ...THREAD, title: undefined } },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("New Chat")).toBeVisible();
    },
};

export const FromMessenger: Story = { args: { thread: { ...THREAD, source: "slack", title: "Deploy window for Friday" } } };

export const LongTitle: Story = {
    args: { thread: { ...THREAD, title: "A very long conversation title that has to be cut off before it pushes the time out of the row" } },
};

/** Hovering the row shows the actions its callbacks provide. */
export const WithActions: Story = {
    args: { onArchive: fn(), onDelete: fn(), onPin: fn() },
    play: async ({ args, canvas }) => {
        await userEvent.hover(canvas.getByRole("button", { name: /Plan the Q1 roadmap/u }));
        await userEvent.click(await canvas.findByRole("button", { name: "Pin thread" }));
        await expect(args.onPin).toHaveBeenCalledOnce();
        await expect(canvas.getByRole("button", { name: "Archive thread" })).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Delete thread" })).toBeVisible();
    },
};
