import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import VideoPlayer from "./video-player";

/**
 * The controls come from `media-chrome`. The time display is rendered without its toggle, so it
 * has no button role and its name is the visible time. The source is empty, so only the chrome is shown.
 */
const meta = {
    args: { filename: "demo.mp4", mediaType: "video/mp4", url: "data:video/mp4;base64," },
    component: VideoPlayer,
    title: "UI/Files/VideoPlayer",
} satisfies Meta<typeof VideoPlayer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("demo.mp4")).toBeVisible();
    },
};

export const Unnamed: Story = { args: { filename: undefined } };
