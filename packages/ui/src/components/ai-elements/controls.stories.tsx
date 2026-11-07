import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import Canvas from "./canvas";
import Controls from "./controls";

const meta = {
    component: Controls,
    decorators: [
        (Story) => (
            <div className="h-64 w-full">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Controls",
} satisfies Meta<typeof Controls>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: /zoom in/i })).toBeVisible();
    },
    render: () => (
        <Canvas edges={[]} nodes={[]}>
            <Controls />
        </Canvas>
    ),
};

export const WithoutInteractiveToggle: Story = {
    render: () => (
        <Canvas edges={[]} nodes={[]}>
            <Controls showInteractive={false} />
        </Canvas>
    ),
};
