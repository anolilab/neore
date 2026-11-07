import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { Thread } from "../types/thread";
import ThreadList from "./thread-list";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The story clock is pinned to this instant (5 Nov 2026, 12:00 UTC), so the groups do not drift. */
const NOW = Date.UTC(2026, 10, 5, 12);

const thread = (id: string, title: string, age: number, extra?: Partial<Thread>): Thread => {
    return { _creationTime: NOW - age, _id: id, title, ...extra };
};

const THREADS: Thread[] = [
    thread("t1", "Plan the Q1 roadmap", HOUR, { pinnedAt: NOW - HOUR }),
    thread("t2", "Summarize the incident review", 2 * HOUR),
    thread("t3", "Draft the launch announcement", DAY + HOUR),
    thread("t4", "Refactor the billing module", 80 * DAY, { source: "slack" }),
];

const meta: Meta<typeof ThreadList> = {
    args: { onCreateThread: fn(), onSelect: fn(), selectedId: "t2", threads: THREADS },
    component: ThreadList,
    decorators: [
        (Story) => (
            <div className="h-[28rem] w-72 rounded-lg border">
                <Story />
            </div>
        ),
    ],
    title: "Chat/ThreadList",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await expect(canvas.getByText("Today")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: /Draft the launch announcement/u }));
        await expect(args.onSelect).toHaveBeenCalledWith("t3");
    },
};

export const NewChat: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "New Chat" }));
        await expect(args.onCreateThread).toHaveBeenCalledOnce();
    },
};

export const Empty: Story = {
    args: { threads: [] },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("No conversations yet")).toBeVisible();
    },
};

export const Loading: Story = {
    args: { isLoading: true, threads: [] },
    play: async ({ canvas }) => {
        await expect(canvas.getByLabelText("Loading threads")).toBeVisible();
    },
};

export const LoadMore: Story = {
    args: { hasMore: true, onLoadMore: fn() },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Load more" }));
        await expect(args.onLoadMore).toHaveBeenCalledOnce();
    },
};

export const LoadingMore: Story = {
    args: { hasMore: true, isLoading: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Loading..." })).toBeVisible();
    },
};
