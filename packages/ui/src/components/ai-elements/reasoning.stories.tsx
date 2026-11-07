import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor } from "storybook/test";

import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";

const TEXT = "The user asks for a summary. First I list the main points, then I shorten them to one sentence each.";

const meta = {
    component: Reasoning,
    decorators: [
        (Story) => (
            <div className="w-[32rem]">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Reasoning",
} satisfies Meta<typeof Reasoning>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Streaming: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button")).toHaveTextContent("Thinking...");
    },
    render: () => (
        <Reasoning isStreaming>
            <ReasoningTrigger />
            <ReasoningContent>{TEXT}</ReasoningContent>
        </Reasoning>
    ),
};

export const Finished: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button")).toHaveTextContent("Thought for 8 seconds");
    },
    render: () => (
        <Reasoning defaultOpen={false} duration={8}>
            <ReasoningTrigger />
            <ReasoningContent>{TEXT}</ReasoningContent>
        </Reasoning>
    ),
};

export const Expanded: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Copy reasoning" })).toBeVisible();
    },
    render: () => (
        <Reasoning defaultOpen={false} duration={3} open>
            <ReasoningTrigger />
            <ReasoningContent>{TEXT}</ReasoningContent>
        </Reasoning>
    ),
};

export const ExpandOnClick: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: /Thought for 5 seconds/ }));
        await waitFor(() => expect(canvas.getByRole("button", { name: "Collapse" })).toBeVisible());
    },
    render: () => (
        <Reasoning defaultOpen={false} duration={5}>
            <ReasoningTrigger />
            <ReasoningContent>{TEXT}</ReasoningContent>
        </Reasoning>
    ),
};

export const CustomMessage: Story = {
    render: () => (
        <Reasoning defaultOpen={false} duration={2}>
            <ReasoningTrigger getThinkingMessage={(_streaming, seconds) => <span>Worked for {seconds}s</span>} />
            <ReasoningContent>{TEXT}</ReasoningContent>
        </Reasoning>
    ),
};
