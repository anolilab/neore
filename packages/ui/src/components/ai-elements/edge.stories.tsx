import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { expect } from "storybook/test";

import Canvas from "./canvas";
import Edge from "./edge";
import { Node, NodeHeader, NodeTitle } from "./node";

const Box = ({ data }: { data: { label: string } }) => (
    <Node className="w-40" handles={{ source: true, target: true }}>
        <NodeHeader>
            <NodeTitle>{data.label}</NodeTitle>
        </NodeHeader>
    </Node>
);

const nodeTypes = { box: Box };
const edgeTypes = { animated: Edge.Animated, temporary: Edge.Temporary };

const nodes: FlowNode[] = [
    { data: { label: "From" }, id: "a", position: { x: 0, y: 0 }, type: "box" },
    { data: { label: "To" }, id: "b", position: { x: 320, y: 40 }, type: "box" },
];

const meta = {
    component: Canvas,
    decorators: [
        (Story) => (
            <div className="h-64 w-full">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Edge",
} satisfies Meta<typeof Canvas>;

export default meta;

type Story = StoryObj<typeof meta>;

const withEdge = (type: FlowEdge["type"]): FlowEdge[] => [{ id: "a-b", source: "a", target: "b", type }];

export const Animated: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("To")).toBeVisible();
    },
    render: () => <Canvas edges={withEdge("animated")} edgeTypes={edgeTypes} nodes={nodes} nodeTypes={nodeTypes} />,
};

export const Temporary: Story = {
    render: () => <Canvas edges={withEdge("temporary")} edgeTypes={edgeTypes} nodes={nodes} nodeTypes={nodeTypes} />,
};
