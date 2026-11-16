import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import Composer from "./composer";

const meta: Meta<typeof Composer> = {
    args: { onSend: fn() },
    component: Composer,
    decorators: [
        (Story) => (
            <div className="max-w-2xl">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Composer",
};

export default meta;

type Story = StoryObj<typeof meta>;

/** Enter sends the trimmed text; Shift+Enter adds a line. */
export const Default: Story = {
    play: async ({ args, canvas }) => {
        const input = canvas.getByRole("textbox", { name: "Message input" });
        const send = canvas.getByRole("button", { name: "Send message" });

        await expect(send).toBeDisabled();
        await userEvent.type(input, "  Summarize the design doc{Shift>}{Enter}{/Shift}with action items  ");
        await expect(send).toBeEnabled();
        await userEvent.keyboard("{Enter}");
        await expect(args.onSend).toHaveBeenCalledWith("Summarize the design doc\nwith action items", { shouldAutoContinue: false });
        await expect(input).toHaveValue("");
    },
};

export const SendWithButton: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.type(canvas.getByRole("textbox", { name: "Message input" }), "Hello");
        await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
        await expect(args.onSend).toHaveBeenCalledOnce();
    },
};

export const CustomPlaceholder: Story = { args: { placeholder: "Ask about this page..." } };

/** A draft loaded from outside fills the input and takes focus. */
export const WithDraft: Story = {
    args: { draft: { id: 1, text: "Explain how the retry policy works" } },
    play: async ({ canvas }) => {
        const input = canvas.getByRole("textbox", { name: "Message input" });

        await expect(input).toHaveValue("Explain how the retry policy works");
        await expect(input).toHaveFocus();
    },
};

/** While a reply streams the input is locked and the send button spins. */
export const Streaming: Story = {
    args: { isStreaming: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("textbox", { name: "Message input" })).toBeDisabled();
        await expect(canvas.getByRole("button", { name: "Generating response" })).toBeDisabled();
    },
};

export const Disabled: Story = { args: { disabled: true } };

export const DeepWorkOff: Story = {
    args: { onAutoContinueChange: fn(), showAutoContinue: true },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Enable deep work mode" }));
        await expect(args.onAutoContinueChange).toHaveBeenCalledWith(true);
    },
};

export const DeepWorkOn: Story = {
    args: { onAutoContinueChange: fn(), shouldAutoContinue: true, showAutoContinue: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Disable deep work mode" })).toHaveAttribute("aria-pressed", "true");
        await expect(canvas.getByText("Up to 25 iterations")).toBeVisible();
    },
};
