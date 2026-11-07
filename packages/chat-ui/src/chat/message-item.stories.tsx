import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { ChatMessage } from "../types/message";
import MessageItem from "./message-item";

const USER: ChatMessage = { id: "u1", parts: [{ text: "Can you outline the release steps?", type: "text" }], role: "user" };

const ASSISTANT: ChatMessage = {
    id: "a1",
    model: "anthropic/claude-sonnet-4.5",
    parts: [{ text: "Freeze the branch, run the suite, then tag and publish.", type: "text" }],
    role: "assistant",
    status: "success",
};

/** A 1x1 transparent PNG, so an attachment has an image without a request. */
// eslint-disable-next-line no-secrets/no-secrets -- an image payload, not a secret
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

const meta: Meta<typeof MessageItem> = {
    args: { isLast: true, message: ASSISTANT, onBranch: fn(), onCopy: fn(), onPin: fn(), onRegenerate: fn() },
    component: MessageItem,
    decorators: [
        (Story) => (
            <div className="max-w-2xl">
                <Story />
            </div>
        ),
    ],
    title: "Chat/MessageItem",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Assistant: Story = {
    play: async ({ args, canvas }) => {
        await expect(await canvas.findByText(/Freeze the branch/u)).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "Copy message" }));
        await expect(args.onCopy).toHaveBeenCalledOnce();
        await userEvent.click(canvas.getByRole("button", { name: "Regenerate response" }));
        await expect(args.onRegenerate).toHaveBeenCalledOnce();
    },
};

export const User: Story = {
    args: { message: USER },
    play: async ({ args, canvas }) => {
        await expect(canvas.getByText("Can you outline the release steps?")).toBeVisible();
        await userEvent.click(canvas.getByRole("button", { name: "Branch from here" }));
        await expect(args.onBranch).toHaveBeenCalledOnce();
    },
};

export const UserWithImage: Story = {
    args: { message: { ...USER, parts: [{ filename: "diagram.png", mediaType: "image/png", type: "file", url: PIXEL }, ...USER.parts] } },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("img", { name: "diagram.png" })).toBeVisible();
    },
};

export const UserImageFlagged: Story = {
    args: { message: { ...USER, parts: [{ mediaType: "image/png", nsfwStatus: "blocked", type: "file", url: PIXEL }, ...USER.parts] } },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Flagged for review")).toBeVisible();
    },
};

export const UserWithPage: Story = {
    args: {
        message: {
            ...USER,
            parts: [
                {
                    providerMetadata: {
                        neore: { pageContext: { kind: "page", title: "Release process", url: "https://example.com/release" } },
                    },
                    text: JSON.stringify({ pageText: "Freeze, test, tag, publish." }),
                    type: "text",
                },
                ...USER.parts,
            ],
        },
    },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Release process")).toBeVisible();
    },
};

/** Usage shows a stats line under the reply. */
export const WithUsage: Story = {
    args: { message: { ...ASSISTANT, usage: { completionTokens: 480, durationMs: 6000, promptTokens: 1200, totalTokens: 1680, ttftMs: 640 } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("80 tok/s")).toBeVisible();
        await expect(canvas.getByText("1.7K tokens")).toBeVisible();
        await expect(canvas.getByText("640ms TTFT")).toBeVisible();
    },
};

export const Streaming: Story = {
    args: { isStreaming: true, message: { ...ASSISTANT, parts: [{ text: "Freeze the branch, then", type: "text" }], status: "streaming" } },
};

/** A group-chat reply is labelled with its speaker. */
export const GroupChatSpeaker: Story = {
    args: { message: { ...ASSISTANT, speakerName: "Researcher" } },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Researcher")).toBeVisible();
    },
};

export const NotLast: Story = {
    args: { isLast: false },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/Freeze the branch/u)).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Regenerate response" })).toBeNull();
    },
};

/** System and tool messages are not rendered. */
export const SystemMessageHidden: Story = {
    args: { message: { id: "s1", parts: [{ text: "You are a helpful assistant.", type: "text" }], role: "system" } },
    play: async ({ canvas }) => {
        await expect(canvas.queryByText("You are a helpful assistant.")).toBeNull();
    },
};
