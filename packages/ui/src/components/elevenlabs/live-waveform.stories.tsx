import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import LiveWaveform from "./live-waveform";

/**
 * Every story leaves `active` off: an active waveform opens the microphone, which a story cannot do.
 * The idle and processing states draw without one.
 */
const meta = {
    args: { height: 64 },
    component: LiveWaveform,
    decorators: [
        (Story) => (
            <div className="bg-muted/50 w-96 rounded-lg border p-2">
                <Story />
            </div>
        ),
    ],
    title: "UI/Voice/LiveWaveform",
} satisfies Meta<typeof LiveWaveform>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("img", { name: "Audio waveform idle" })).toBeVisible();
    },
};

export const Processing: Story = {
    args: { processing: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("img", { name: "Processing audio" })).toBeVisible();
    },
};

export const ScrollingMode: Story = { args: { mode: "scrolling", processing: true } };

export const Compact: Story = { args: { barGap: 1, barRadius: 4, barWidth: 2, fadeEdges: false, height: 20, processing: true } };

export const WideBars: Story = { args: { barGap: 4, barRadius: 3, barWidth: 8, height: 96, processing: true } };
