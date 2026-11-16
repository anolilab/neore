import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import Shimmer from "./shimmer";

const meta = {
    args: { children: "Thinking..." },
    component: Shimmer,
    title: "Chat/Shimmer",
} satisfies Meta<typeof Shimmer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("status")).toHaveTextContent("Thinking...");
    },
};

export const Slow: Story = { args: { children: "Searching the web...", duration: 4 } };

export const Heading: Story = { args: { as: "h2", children: "Generating a plan...", className: "text-xl font-semibold" } };

export const WideSpread: Story = { args: { children: "Reading the documents...", spread: 5 } };
