import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { JsonViewer } from "./json-viewer";

const CONFIG = {
    features: { beta: false, dictation: true },
    limits: { messagesPerDay: 200, tokensPerMessage: 8192 },
    models: ["gpt-5", "claude-sonnet-4.5", "gemini-2.5-flash"],
    name: "workspace",
    owner: null,
};

const meta = {
    args: { data: CONFIG, onCopy: fn() },
    component: JsonViewer,
    decorators: [
        (Story) => (
            <div className="max-w-xl rounded-lg border p-3">
                <Story />
            </div>
        ),
    ],
    title: "UI/Files/JsonViewer",
} satisfies Meta<typeof JsonViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText('"workspace"')).toBeVisible();
        await expect(canvas.getByRole("button", { name: "limits: 2 items, object" })).toHaveAttribute("aria-expanded", "true");
    },
};

export const Collapsed: Story = {
    args: { defaultExpandDepth: 0 },
    play: async ({ canvas }) => {
        const root = canvas.getByRole("button", { name: "root: 5 items, object" });

        await expect(root).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(root);
        await expect(root).toHaveAttribute("aria-expanded", "true");
    },
};

export const FullyExpanded: Story = {
    args: { defaultExpandDepth: 5 },
    play: async ({ canvas }) => {
        await expect(canvas.getByText('"claude-sonnet-4.5"')).toBeVisible();
    },
};

/** A JSON string is parsed first. */
export const FromString: Story = { args: { data: JSON.stringify(CONFIG), rootName: "config" } };

export const Primitive: Story = { args: { data: 42, rootName: "answer" } };

/** Lists past `maxItems` are cut, with a button for the rest. */
export const LongArray: Story = {
    args: { data: Array.from({ length: 12 }, (_, index) => index * 3), maxItems: 5, rootName: "values" },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /7 more items/u }));
        await expect(canvas.getByText("33")).toBeVisible();
    },
};
