import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import type { ChatMessage, MessagePart, ToolPart } from "../types/message";
import MessageContent from "./message-content";

const message = (parts: MessagePart[], overrides?: Partial<ChatMessage>): ChatMessage => {
    return { id: "msg-1", parts, role: "assistant", status: "success", ...overrides };
};

const searchCall: ToolPart = {
    input: { query: "storybook accessibility addon" },
    output: { results: 3, top: "Accessibility tests | Storybook docs" },
    state: "output-available",
    toolCallId: "call-1",
    type: "tool-web_search",
};

const readCall: ToolPart = {
    input: { url: "https://storybook.js.org/docs/writing-tests/accessibility-testing" },
    output: "Accessibility tests run axe against each story.",
    state: "output-available",
    toolCallId: "call-2",
    type: "tool-read_page",
};

const MARKDOWN = [
    "Here is a short plan:",
    "",
    "1. Write a story for each state.",
    "2. Query by **role** and accessible name.",
    "3. Let the a11y check run.",
    "",
    "```ts",
    "export const Default: Story = {};",
    "```",
].join("\n");

const meta: Meta<typeof MessageContent> = {
    args: { message: message([{ text: MARKDOWN, type: "text" }]) },
    component: MessageContent,
    decorators: [
        (Story) => (
            <div className="max-w-2xl">
                <Story />
            </div>
        ),
    ],
    title: "Chat/MessageContent",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Markdown: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Here is a short plan:")).toBeVisible();
        await expect(canvas.getByText("role")).toBeVisible();
    },
};

export const WithReasoning: Story = {
    args: {
        message: message([
            { text: "The user wants a plan, so list the steps in order.", type: "reasoning" },
            { text: "Start with one story per state.", type: "text" },
        ]),
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Start with one story per state.")).toBeVisible();
    },
};

export const ToolCall: Story = {
    args: { message: message([searchCall, { text: "I found three results.", type: "text" }]) },
    play: async ({ canvas }) => {
        const header = await canvas.findByRole("button", { name: /web_search/u });

        await expect(header).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(header);
        await expect(await canvas.findByText(/storybook accessibility addon/u)).toBeVisible();
    },
};

export const ToolCallRunning: Story = {
    args: { message: message([{ ...searchCall, output: undefined, state: "input-available" }], { status: "streaming" }) },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Running...")).toBeVisible();
    },
};

export const ToolCallFailed: Story = {
    args: { message: message([{ ...searchCall, errorText: "The search provider timed out.", output: undefined, state: "output-error" }]) },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /web_search/u }));
        await expect(await canvas.findByText("The search provider timed out.")).toBeVisible();
    },
};

/** Two or more finished tool calls fold into one summary line. */
export const FoldedToolCalls: Story = {
    args: { message: message([searchCall, readCall, { text: "Done.", type: "text" }]) },
    play: async ({ canvas }) => {
        await expect(await canvas.findByTestId("tool-group-trigger")).toHaveTextContent("Used 2 tools");
    },
};

export const WithSources: Story = {
    args: {
        message: message([
            { sourceId: "s1", title: "Accessibility tests", type: "source-url", url: "https://storybook.js.org/docs/writing-tests/accessibility-testing" },
            { sourceId: "s2", title: "axe-core rules", type: "source-url", url: "https://dequeuniversity.com/rules/axe/" },
            { text: "Storybook runs axe on each story.", type: "text" },
        ]),
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Storybook runs axe on each story.")).toBeVisible();
    },
};

/** Nothing has arrived yet. */
export const Thinking: Story = {
    args: { isStreaming: true, message: message([], { status: "pending" }) },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Thinking...")).toBeVisible();
    },
};

export const Failed: Story = {
    args: { message: message([], { error: "The model is overloaded. Try again in a moment.", status: "failed" }) },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("The model is overloaded. Try again in a moment.")).toBeVisible();
    },
};

export const FailedWithoutDetails: Story = {
    args: { message: message([], { status: "failed" }) },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("An error occurred while generating the response.")).toBeVisible();
    },
};
