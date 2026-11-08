import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReactFlowProvider } from "@xyflow/react";
import { expect } from "storybook/test";

import { Node, NodeAction, NodeContent, NodeDescription, NodeFooter, NodeHeader, NodeTitle } from "./node";

const meta = {
    args: { handles: { source: true, target: true } },
    component: Node,
    decorators: [
        (Story) => (
            <ReactFlowProvider>
                <div className="w-96">
                    <Story />
                </div>
            </ReactFlowProvider>
        ),
    ],
    title: "Chat/Node",
} satisfies Meta<typeof Node>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Generate")).toBeVisible();
    },
    render: (args) => (
        <Node {...args}>
            <NodeHeader>
                <NodeTitle>Generate</NodeTitle>
                <NodeDescription>Calls the model</NodeDescription>
            </NodeHeader>
            <NodeContent>
                <p className="text-sm">Sends the prompt and streams the reply.</p>
            </NodeContent>
            <NodeFooter>
                <span className="text-muted-foreground text-xs">Last run 2 minutes ago</span>
            </NodeFooter>
        </Node>
    ),
};

export const WithAction: Story = {
    render: (args) => (
        <Node {...args}>
            <NodeHeader>
                <NodeTitle>Search</NodeTitle>
                <NodeAction>
                    <span className="text-muted-foreground text-xs">Beta</span>
                </NodeAction>
            </NodeHeader>
            <NodeContent>
                <p className="text-sm">Looks up related documents.</p>
            </NodeContent>
        </Node>
    ),
};

export const SourceOnly: Story = {
    args: { handles: { source: true, target: false } },
    render: (args) => (
        <Node {...args}>
            <NodeHeader>
                <NodeTitle>Start</NodeTitle>
            </NodeHeader>
        </Node>
    ),
};
