import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import {
    AudioPlayer,
    AudioPlayerControlBar,
    AudioPlayerDurationDisplay,
    AudioPlayerElement,
    AudioPlayerMuteButton,
    AudioPlayerPlayButton,
    AudioPlayerSeekBackwardButton,
    AudioPlayerSeekForwardButton,
    AudioPlayerTimeDisplay,
    AudioPlayerTimeRange,
    AudioPlayerVolumeRange,
} from "./audio-player";

// Thirty seconds of silence: 8 kHz, 8-bit mono WAV header plus a body of 0x80 samples, served as a blob URL.
const silence = (): string => {
    const rate = 8000;
    const size = rate * 30;
    const bytes = new Uint8Array(44 + size).fill(0x80);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => {
        for (let index = 0; index < value.length; index++) {
            view.setUint8(offset + index, value.codePointAt(index) ?? 0);
        }
    };

    text(0, "RIFF");
    view.setUint32(4, 36 + size, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    text(36, "data");
    view.setUint32(40, size, true);

    return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
};

const meta = {
    component: AudioPlayer,
    decorators: [
        (Story) => (
            <div className="w-[34rem]">
                <Story />
            </div>
        ),
    ],
    title: "Chat/AudioPlayer",
} satisfies Meta<typeof AudioPlayer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        await expect(canvasElement.querySelector("media-play-button")).not.toBeNull();
    },
    render: () => (
        <AudioPlayer>
            <AudioPlayerElement src={silence()} />
            <AudioPlayerControlBar>
                <AudioPlayerPlayButton />
                <AudioPlayerSeekBackwardButton />
                <AudioPlayerSeekForwardButton />
                <AudioPlayerTimeDisplay />
                <AudioPlayerTimeRange />
                <AudioPlayerDurationDisplay />
                <AudioPlayerMuteButton />
                <AudioPlayerVolumeRange />
            </AudioPlayerControlBar>
        </AudioPlayer>
    ),
};

export const Compact: Story = {
    render: () => (
        <AudioPlayer>
            <AudioPlayerElement src={silence()} />
            <AudioPlayerControlBar>
                <AudioPlayerPlayButton />
                <AudioPlayerTimeRange />
                <AudioPlayerDurationDisplay />
            </AudioPlayerControlBar>
        </AudioPlayer>
    ),
};
