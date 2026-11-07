import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileIcon } from "lucide-react";
import { expect, userEvent, waitFor } from "storybook/test";

import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "./task";

const meta = {
    component: Task,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Task",
} satisfies Meta<typeof Task>;

export default meta;

type Story = StoryObj<typeof meta>;

const Items = () => (
    <TaskContent>
        <TaskItem>Searched the repository for usages</TaskItem>
        <TaskItem>
            Read{" "}
            <TaskItemFile>
                <FileIcon aria-hidden="true" className="size-3" />
                button.tsx
            </TaskItemFile>
        </TaskItem>
    </TaskContent>
);

export const Open: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Searched the repository for usages")).toBeVisible();
    },
    render: () => (
        <Task>
            <TaskTrigger title="Find usages" />
            <Items />
        </Task>
    ),
};

export const Collapsed: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Find usages" }));
        await waitFor(() => expect(canvas.getByText("Searched the repository for usages")).toBeVisible());
    },
    render: () => (
        <Task defaultOpen={false}>
            <TaskTrigger title="Find usages" />
            <Items />
        </Task>
    ),
};

export const CustomTrigger: Story = {
    render: () => (
        <Task>
            <TaskTrigger title="Edit files">
                <span className="text-sm font-medium">Edit files</span>
            </TaskTrigger>
            <TaskContent>
                <TaskItem>Updated two files</TaskItem>
            </TaskContent>
        </Task>
    ),
};
