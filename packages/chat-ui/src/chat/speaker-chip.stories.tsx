import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import SpeakerChip, { SpeakerAvatar } from "./speaker-chip";

const meta = {
    args: { name: "Researcher" },
    component: SpeakerChip,
    title: "Chat/SpeakerChip",
} satisfies Meta<typeof SpeakerChip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Researcher")).toBeVisible();
    },
};

export const LongName: Story = {
    args: { className: "max-w-48", name: "Senior security reviewer for infrastructure changes" },
};

/** Each name generates its own face, so a group's speakers differ at a glance. */
export const Speakers: Story = {
    render: () => (
        <div className="flex flex-col gap-2">
            {["Researcher", "Editor", "Critic", "Planner"].map((name) => (
                <SpeakerChip key={name} name={name} />
            ))}
        </div>
    ),
};

export const AvatarOnly: Story = {
    render: () => (
        <div className="flex items-center gap-2">
            <SpeakerAvatar name="Researcher" size="sm" />
            <SpeakerAvatar name="Researcher" size="default" />
        </div>
    ),
};
