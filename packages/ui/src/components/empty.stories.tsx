import type { Meta, StoryObj } from "@storybook/react-vite";
import { InboxIcon } from "lucide-react";

import { Button } from "./button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./empty";

const meta = {
    component: Empty,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    title: "UI/Empty",
} satisfies Meta<typeof Empty>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: (args) => (
        <Empty {...args}>
            <EmptyHeader>
                <EmptyTitle>No chats yet</EmptyTitle>
                <EmptyDescription>Start a conversation and it will show up here.</EmptyDescription>
            </EmptyHeader>
        </Empty>
    ),
};

export const WithIconAndAction: Story = {
    render: (args) => (
        <Empty className="border" {...args}>
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <InboxIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Inbox is empty</EmptyTitle>
                <EmptyDescription>New notifications will appear here.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm">Refresh</Button>
            </EmptyContent>
        </Empty>
    ),
};
