import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent } from "storybook/test";

import { Transcription, TranscriptionSegment } from "./transcription";

const SEGMENTS = [
    { endSecond: 2, startSecond: 0, text: "Welcome to the weekly update." },
    { endSecond: 5, startSecond: 2, text: "This week we shipped search." },
    { endSecond: 8, startSecond: 5, text: "Next week is offline mode." },
];

const meta = {
    args: {
        children: (segment, index) => <TranscriptionSegment index={index} key={segment.startSecond} segment={segment} />,
        segments: SEGMENTS,
    },
    component: Transcription,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Transcription",
} satisfies Meta<typeof Transcription>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    args: { currentTime: 3 },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "This week we shipped search." })).toHaveAttribute("data-active", "true");
    },
};

export const Seekable: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Next week is offline mode." }));
        await expect(canvas.getByRole("button", { name: "Next week is offline mode." })).toHaveAttribute("data-active", "true");
    },
    render: (args) => {
        const Player = () => {
            const [time, setTime] = useState(0);

            return <Transcription {...args} currentTime={time} onSeek={setTime} />;
        };

        return <Player />;
    },
};

export const SeekHandler: Story = { args: { currentTime: 0, onSeek: fn() } };

export const Empty: Story = { args: { segments: [] } };
