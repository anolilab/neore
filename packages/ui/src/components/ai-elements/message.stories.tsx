import type { Meta, StoryObj } from "@storybook/react-vite";
import { CopyIcon, RefreshCwIcon, ThumbsUpIcon } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";

import {
    Message,
    MessageAction,
    MessageActions,
    MessageBranch,
    MessageBranchContent,
    MessageBranchNext,
    MessageBranchPage,
    MessageBranchPrevious,
    MessageBranchSelector,
    MessageContent,
    MessageResponse,
    MessageToolbar,
} from "./message";

const meta = {
    args: { from: "assistant" },
    component: Message,
    decorators: [
        (Story) => (
            <div className="w-[32rem]">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Message",
} satisfies Meta<typeof Message>;

export default meta;

type Story = StoryObj<typeof meta>;

export const User: Story = {
    args: { from: "user" },
    render: (args) => (
        <Message {...args}>
            <MessageContent>Can you summarise the last release?</MessageContent>
        </Message>
    ),
};

export const Assistant: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Faster search")).toBeVisible();
    },
    render: (args) => (
        <Message {...args}>
            <MessageContent>
                <MessageResponse>{"The release adds **three** features:\n\n- Faster search\n- Offline mode\n- A new `export` command"}</MessageResponse>
            </MessageContent>
        </Message>
    ),
};

export const WithActions: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible();
    },
    render: (args) => {
        const onCopy = fn();

        return (
            <Message {...args}>
                <MessageContent>
                    <MessageResponse>Here is the summary you asked for.</MessageResponse>
                </MessageContent>
                <MessageToolbar>
                    <MessageActions>
                        <MessageAction label="Copy" onClick={onCopy} tooltip="Copy message">
                            <CopyIcon aria-hidden="true" />
                        </MessageAction>
                        <MessageAction label="Retry">
                            <RefreshCwIcon aria-hidden="true" />
                        </MessageAction>
                        <MessageAction label="Like">
                            <ThumbsUpIcon aria-hidden="true" />
                        </MessageAction>
                    </MessageActions>
                </MessageToolbar>
            </Message>
        );
    },
};

export const Branches: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("1 of 2")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "Next branch" }));
        await expect(await canvas.findByText("2 of 2")).toBeVisible();
    },
    render: (args) => (
        <Message {...args}>
            <MessageBranch>
                <MessageBranchContent>
                    <MessageContent key="a">
                        <MessageResponse>First answer: use a queue.</MessageResponse>
                    </MessageContent>
                    <MessageContent key="b">
                        <MessageResponse>Second answer: use a cron trigger.</MessageResponse>
                    </MessageContent>
                </MessageBranchContent>
                <MessageToolbar>
                    <MessageBranchSelector>
                        <MessageBranchPrevious />
                        <MessageBranchPage />
                        <MessageBranchNext />
                    </MessageBranchSelector>
                </MessageToolbar>
            </MessageBranch>
        </Message>
    ),
};
