import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "./checkpoint";

const meta = {
    component: Checkpoint,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Checkpoint",
} satisfies Meta<typeof Checkpoint>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Restore checkpoint" })).toBeVisible();
    },
    render: () => (
        <Checkpoint>
            <CheckpointIcon />
            <CheckpointTrigger>Restore checkpoint</CheckpointTrigger>
        </Checkpoint>
    ),
};

export const WithTooltip: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Restore checkpoint" }));
    },
    render: () => {
        const onClick = fn();

        return (
            <Checkpoint>
                <CheckpointIcon />
                <CheckpointTrigger onClick={onClick} tooltip="Return the conversation to this point">
                    Restore checkpoint
                </CheckpointTrigger>
            </Checkpoint>
        );
    },
};

export const CustomIcon: Story = {
    render: () => (
        <Checkpoint>
            <CheckpointIcon>
                <span aria-hidden="true">#</span>
            </CheckpointIcon>
            <CheckpointTrigger variant="outline">Checkpoint 2</CheckpointTrigger>
        </Checkpoint>
    ),
};
