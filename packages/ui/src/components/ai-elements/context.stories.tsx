import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import {
    Context,
    ContextCacheUsage,
    ContextContent,
    ContextContentBody,
    ContextContentFooter,
    ContextContentHeader,
    ContextInputUsage,
    ContextOutputUsage,
    ContextReasoningUsage,
    ContextTrigger,
} from "./context";

const USAGE = {
    cachedInputTokens: 10_000,
    inputTokenDetails: { cacheReadTokens: 10_000, cacheWriteTokens: undefined, noCacheTokens: 32_000 },
    inputTokens: 42_000,
    outputTokenDetails: { reasoningTokens: 2000, textTokens: 4000 },
    outputTokens: 6000,
    reasoningTokens: 2000,
    totalTokens: 48_000,
};

const meta: Meta<typeof Context> = {
    args: { maxTokens: 200_000, usedTokens: 48_000 },
    component: Context,
    decorators: [
        (Story) => (
            <div className="flex h-64 w-72 justify-end">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Context",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("24%")).toBeVisible();
    },
    render: (args) => (
        <Context {...args}>
            <ContextTrigger />
        </Context>
    ),
};

export const Open: Story = {
    args: { defaultOpen: true, hideCosts: true, usage: USAGE },
    render: (args) => (
        <Context {...args}>
            <ContextTrigger />
            <ContextContent>
                <ContextContentHeader />
                <ContextContentBody>
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextReasoningUsage />
                    <ContextCacheUsage />
                </ContextContentBody>
                <ContextContentFooter />
            </ContextContent>
        </Context>
    ),
};

export const NearlyFull: Story = {
    args: { defaultOpen: true, hideCosts: true, usedTokens: 190_000 },
    render: (args) => (
        <Context {...args}>
            <ContextTrigger />
            <ContextContent>
                <ContextContentHeader />
            </ContextContent>
        </Context>
    ),
};
