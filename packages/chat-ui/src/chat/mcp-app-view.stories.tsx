import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import McpAppView from "./mcp-app-view";

const meta = {
    args: {
        lunoraSiteUrl: "http://localhost:6006",
        part: { errorText: "The server closed the connection.", state: "output-error", toolCallId: "call-1", type: "tool-mcp_maps__show_map" },
        resourceUri: "ui://maps/show-map",
        serverName: "maps",
        toolName: "show_map",
    },
    component: McpAppView,
    decorators: [
        (Story) => (
            <div className="max-w-xl">
                <Story />
            </div>
        ),
    ],
    title: "Chat/McpAppView",
} satisfies Meta<typeof McpAppView>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Only the error state: a working view loads its app in a sandboxed frame from an
 * external host, which a story must not reach.
 */
export const ToolFailed: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("The server closed the connection.")).toBeVisible();
    },
};

export const ToolFailedWithoutMessage: Story = {
    args: { part: { state: "output-error", toolCallId: "call-2", type: "tool-mcp_maps__show_map" } },
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Tool call failed")).toBeVisible();
    },
};
