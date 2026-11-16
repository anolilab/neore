import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { ChatMessage } from "../types/message";
import MessageList from "./message-list";

const MESSAGES: ChatMessage[] = [
    { id: "m1", parts: [{ text: "What does the retry policy do?", type: "text" }], role: "user" },
    {
        id: "m2",
        parts: [{ text: "It retries a failed request up to three times, waiting longer after each failure.", type: "text" }],
        role: "assistant",
        status: "success",
    },
    { id: "m3", parts: [{ text: "Can the delay be changed?", type: "text" }], role: "user" },
    {
        id: "m4",
        parts: [{ text: "Yes. Set `retryDelayMs` in the client options.", type: "text" }],
        role: "assistant",
        status: "success",
    },
];

const meta: Meta<typeof MessageList> = {
    args: { messages: MESSAGES, onBranchMessage: fn(), onCopyMessage: fn(), onRegenerateMessage: fn() },
    component: MessageList,
    decorators: [
        (Story) => (
            <div className="h-[28rem] max-w-2xl rounded-lg border">
                <Story />
            </div>
        ),
    ],
    title: "Chat/MessageList",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("What does the retry policy do?")).toBeVisible();
        await expect(await canvas.findByText(/Set/u)).toBeVisible();
    },
};

export const Empty: Story = {
    args: { messages: [] },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Start a conversation")).toBeVisible();
    },
};

export const Streaming: Story = {
    args: {
        isStreaming: true,
        messages: [...MESSAGES.slice(0, 3), { id: "m4", parts: [{ text: "Yes. Set `retryDelayMs`", type: "text" }], role: "assistant", status: "streaming" }],
    },
};

export const LoadEarlier: Story = {
    args: { hasMore: true, onLoadMore: fn() },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Load earlier messages" }));
        await expect(args.onLoadMore).toHaveBeenCalledOnce();
    },
};

export const FailedReply: Story = {
    args: {
        messages: [...MESSAGES.slice(0, 1), { error: "The model is overloaded.", id: "m2", parts: [], role: "assistant", status: "failed" }],
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("The model is overloaded.")).toBeVisible();
    },
};
