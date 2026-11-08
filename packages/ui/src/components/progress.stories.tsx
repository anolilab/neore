import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue } from "./progress";

const meta = {
    args: { "aria-label": "Upload progress", value: 40 },
    component: Progress,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    title: "UI/Progress",
} satisfies Meta<typeof Progress>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("progressbar", { name: "Upload progress" })).toHaveAttribute("aria-valuenow", "40");
    },
};

export const Empty: Story = { args: { value: 0 } };

export const Complete: Story = { args: { value: 100 } };

export const Indeterminate: Story = { args: { value: null } };

export const WithLabelAndValue: Story = {
    args: { "aria-label": undefined, value: 65 },
    render: (args) => (
        <Progress {...args}>
            <div className="flex justify-between">
                <ProgressLabel>Storage</ProgressLabel>
                <ProgressValue />
            </div>
            <ProgressTrack>
                <ProgressIndicator />
            </ProgressTrack>
        </Progress>
    ),
};
