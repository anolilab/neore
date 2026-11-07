import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { expect } from "storybook/test";

import Canvas from "./canvas";
import Connection from "./connection";
import Controls from "./controls";
import Edge from "./edge";
import { Node, NodeContent, NodeDescription, NodeHeader, NodeTitle } from "./node";
import Panel from "./panel";

const StepNode = ({ data }: { data: { description: string; label: string; source: boolean; target: boolean } }) => (
    <Node handles={{ source: data.source, target: data.target }}>
        <NodeHeader>
            <NodeTitle>{data.label}</NodeTitle>
            <NodeDescription>{data.description}</NodeDescription>
        </NodeHeader>
        <NodeContent>
            <p className="text-sm">A step in the workflow.</p>
        </NodeContent>
    </Node>
);

const nodeTypes = { step: StepNode };
const edgeTypes = { animated: Edge.Animated, temporary: Edge.Temporary };

const nodes: FlowNode[] = [
    { data: { description: "Receives the request", label: "Start", source: true, target: false }, id: "a", position: { x: 0, y: 0 }, type: "step" },
    { data: { description: "Calls the model", label: "Generate", source: true, target: true }, id: "b", position: { x: 450, y: 0 }, type: "step" },
    { data: { description: "Returns the answer", label: "Finish", source: false, target: true }, id: "c", position: { x: 900, y: 0 }, type: "step" },
];

const edges: FlowEdge[] = [
    { id: "a-b", source: "a", target: "b", type: "animated" },
    { id: "b-c", source: "b", target: "c", type: "temporary" },
];

const meta = {
    component: Canvas,
    decorators: [
        (Story) => (
            <div className="h-80 w-full">
                <Story />
            </div>
        ),
    ],
    title: "Chat/Canvas",
} satisfies Meta<typeof Canvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Generate")).toBeVisible();
    },
    render: () => <Canvas edges={edges} edgeTypes={edgeTypes} nodes={nodes} nodeTypes={nodeTypes} />,
};

export const WithControlsAndPanel: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Workflow")).toBeVisible();
    },
    render: () => (
        <Canvas connectionLineComponent={Connection} edges={edges} edgeTypes={edgeTypes} nodes={nodes} nodeTypes={nodeTypes}>
            <Controls />
            <Panel position="top-left">
                <span className="px-2 text-sm">Workflow</span>
            </Panel>
        </Canvas>
    ),
};

export const Empty: Story = {
    render: () => <Canvas edges={[]} nodes={[]} />,
};
