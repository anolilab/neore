import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import Canvas from "./canvas";
import Panel from "./panel";

const meta = {
    component: Panel,
    decorators: [
        (Story) => (
            <div className="h-64 w-full">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Panel",
} satisfies Meta<typeof Panel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TopLeft: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Top left")).toBeVisible();
    },
    render: () => (
        <Canvas edges={[]} nodes={[]}>
            <Panel position="top-left">
                <span className="px-2 text-sm">Top left</span>
            </Panel>
        </Canvas>
    ),
};

export const BottomRight: Story = {
    render: () => (
        <Canvas edges={[]} nodes={[]}>
            <Panel position="bottom-right">
                <span className="px-2 text-sm">Bottom right</span>
            </Panel>
        </Canvas>
    ),
};
