import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Node as FlowNode } from "@xyflow/react";
import { expect } from "storybook/test";

import { Button } from "../button";
import Canvas from "./canvas";
import { Node, NodeHeader, NodeTitle } from "./node";
import Toolbar from "./toolbar";

const ToolbarNode = () => (
    <Node handles={{ source: false, target: false }}>
        <Toolbar isVisible>
            <Button size="xs" variant="ghost">
                Duplicate
            </Button>
            <Button size="xs" variant="ghost">
                Delete
            </Button>
        </Toolbar>
        <NodeHeader>
            <NodeTitle>Generate</NodeTitle>
        </NodeHeader>
    </Node>
);

const nodes: FlowNode[] = [{ data: {}, id: "a", position: { x: 0, y: 0 }, type: "toolbar" }];

const meta = {
    component: Toolbar,
    decorators: [
        (Story) => (
            <div className="h-64 w-full">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Toolbar",
} satisfies Meta<typeof Toolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Duplicate" })).toBeVisible();
    },
    render: () => <Canvas edges={[]} nodes={nodes} nodeTypes={{ toolbar: ToolbarNode }} />,
};
