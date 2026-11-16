import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";

import AudioWaveformPlayer from "./audio-waveform-player";

/** Two seconds of a fading 440 Hz tone as a 16-bit mono WAV, so the waveform has something to draw. */
const toneUrl = (): string => {
    const sampleRate = 8000;
    const samples = sampleRate * 2;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const writeText = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index += 1) {
            view.setUint8(offset + index, text.codePointAt(index) ?? 0);
        }
    };

    writeText(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, samples * 2, true);

    for (let index = 0; index < samples; index += 1) {
        const fade = 1 - index / samples;

        view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12_000 * fade), true);
    }

    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
};

const meta = {
    args: { filename: "tone.wav", url: "data:audio/wav;base64," },
    component: AudioWaveformPlayer,
    loaders: [
        async () => {
            return { url: toneUrl() };
        },
    ],
    title: "UI/Files/AudioWaveformPlayer",
} satisfies Meta<typeof AudioWaveformPlayer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        const play = await canvas.findByRole("button", { name: "Play" });

        await expect(play).toBeVisible();
        await expect(canvas.getByText("tone.wav")).toBeVisible();
    },
    render: (args, { loaded }) => <AudioWaveformPlayer {...args} url={loaded.url as string} />,
};

/** The button stays disabled until the audio has been decoded. */
export const Ready: Story = {
    play: async ({ canvas, step }) => {
        const play = await canvas.findByRole("button", { name: "Play" });

        await step("wait for the waveform", async () => {
            await waitFor(() => expect(play).toBeEnabled(), { timeout: 5000 });
        });
    },
    render: (args, { loaded }) => <AudioWaveformPlayer {...args} url={loaded.url as string} />,
};

export const Unnamed: Story = {
    args: { filename: undefined },
    render: (args, { loaded }) => <AudioWaveformPlayer {...args} url={loaded.url as string} />,
};

/** Audio that cannot be decoded shows the error card. */
export const Failed: Story = {
    args: { url: "data:audio/wav;base64,AAAA" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Failed to load audio")).toBeVisible();
    },
};
