import type { GatewayModel } from "@neore/ai/models";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import type { ChatMessage } from "../types/message";
import type { Thread } from "../types/thread";
import type { AutoContinueState } from "./auto-continue-status";
import ChatView from "./chat-view";

const model = (fixture: Partial<GatewayModel> & Pick<GatewayModel, "id" | "mode" | "name" | "provider">): GatewayModel => {
    return { enabled: true, modelApiId: fixture.id, regions: ["US"], supportsFileInput: false, supportsMultimodal: false, supportsTools: true, ...fixture };
};

const CLAUDE = model({ displayProvider: "Anthropic", id: "anthropic/claude-sonnet-4.5", mode: "text", name: "Claude Sonnet 4.5", provider: "openrouter" });
const GPT = model({ displayProvider: "OpenAI", id: "openai/gpt-5", mode: "text", name: "GPT-5", provider: "openrouter" });

const THREAD: Thread = { _creationTime: Date.UTC(2026, 10, 5, 9), _id: "thread-1", title: "Retry policy questions" };

const MESSAGES: ChatMessage[] = [
    { id: "m1", parts: [{ text: "What does the retry policy do?", type: "text" }], role: "user" },
    {
        id: "m2",
        model: CLAUDE.id,
        parts: [{ text: "It retries a failed request up to three times, waiting longer after each failure.", type: "text" }],
        role: "assistant",
        status: "success",
    },
];

const DEEP_WORK: AutoContinueState = {
    active: true,
    iteration: 4,
    maxIterations: 25,
    status: "executing_tools",
    toolCalls: [
        { status: "complete", toolName: "web_search" },
        { status: "running", toolName: "read_page" },
    ],
};

const meta: Meta<typeof ChatView> = {
    args: {
        availableModels: [CLAUDE, GPT],
        isStreaming: false,
        messages: MESSAGES,
        onSelectModel: fn(),
        onSendMessage: fn(),
        selectedModelId: CLAUDE.id,
        thread: THREAD,
    },
    component: ChatView,
    decorators: [
        (Story) => (
            <div className="h-[36rem] max-w-3xl overflow-hidden rounded-lg border">
                <Story />
            </div>
        ),
    ],
    title: "Chat/ChatView",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
    play: async ({ args, canvas }) => {
        await expect(await canvas.findByRole("heading", { name: "Retry policy questions" })).toBeVisible();
        await userEvent.type(canvas.getByRole("textbox", { name: "Message input" }), "Thanks!{Enter}");
        await expect(args.onSendMessage).toHaveBeenCalledWith("Thanks!", { shouldAutoContinue: false });
    },
};

export const NewThread: Story = {
    args: { messages: [], thread: { ...THREAD, title: undefined } },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("heading", { name: "New Chat" })).toBeVisible();
        await expect(canvas.getByText("Start a conversation")).toBeVisible();
    },
};

export const WithBackButton: Story = {
    args: { onBack: fn() },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Go back" }));
        await expect(args.onBack).toHaveBeenCalledOnce();
    },
};

export const Streaming: Story = {
    args: {
        isStreaming: true,
        messages: [...MESSAGES, { id: "m3", parts: [], role: "assistant", status: "pending" }],
    },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Generating response" })).toBeDisabled();
    },
};

export const DeepWork: Story = {
    args: { autoContinueState: DEEP_WORK, onAutoContinueChange: fn(), onCancelAutoContinue: fn(), shouldAutoContinue: true, showAutoContinue: true },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Cancel deep work" }));
        await expect(args.onCancelAutoContinue).toHaveBeenCalledOnce();
    },
};

export const WithComposerSlotAndHeaderActions: Story = {
    args: {
        composerSlot: <p className="text-muted-foreground px-3 pt-2 text-xs">notes.pdf attached</p>,
        headerActions: (
            <button className="rounded-md border px-2 py-1 text-xs" type="button">
                Share
            </button>
        ),
    },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("notes.pdf attached")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Share" })).toBeVisible();
    },
};

export const EarlierMessages: Story = { args: { hasMoreMessages: true, onLoadMoreMessages: fn() } };
