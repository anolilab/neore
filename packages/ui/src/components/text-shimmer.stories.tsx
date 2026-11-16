import type { Meta, StoryObj } from "@storybook/react-vite";

import TextShimmer from "./text-shimmer";

const meta: Meta<typeof TextShimmer> = {
    args: { children: "Thinking..." },
    component: TextShimmer,
    title: "UI/TextShimmer",
};

export default meta;

type Story = StoryObj<typeof TextShimmer>;

export const Default: Story = {};

export const Slow: Story = { args: { duration: 4 } };

export const AsHeading: Story = { args: { as: "h3", children: "Generating your report", className: "text-lg font-medium" } };
