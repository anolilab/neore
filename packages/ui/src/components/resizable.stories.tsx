import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./resizable";

const meta = {
    component: ResizablePanelGroup,
    render: (args) => (
        <ResizablePanelGroup {...args} className="h-48 w-96 rounded-md border">
            <ResizablePanel defaultSize={40}>
                <div className="flex h-full items-center justify-center p-4 text-sm">Threads</div>
            </ResizablePanel>
            <ResizableHandle aria-label="Resize threads" />
            <ResizablePanel defaultSize={60}>
                <div className="flex h-full items-center justify-center p-4 text-sm">Conversation</div>
            </ResizablePanel>
        </ResizablePanelGroup>
    ),
    title: "UI/Resizable",
} satisfies Meta<typeof ResizablePanelGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("separator", { name: "Resize threads" })).toBeVisible();
    },
};

export const Vertical: Story = {
    args: { orientation: "vertical" },
    render: (args) => (
        <div className="h-48 w-96">
            <ResizablePanelGroup {...args} className="rounded-md border">
                <ResizablePanel defaultSize={50}>
                    <p className="p-2 text-sm">Editor</p>
                </ResizablePanel>
                <ResizableHandle aria-label="Resize editor" />
                <ResizablePanel defaultSize={50}>
                    <p className="p-2 text-sm">Terminal</p>
                </ResizablePanel>
            </ResizablePanelGroup>
        </div>
    ),
};

export const WithHandle: Story = {
    render: (args) => (
        <ResizablePanelGroup {...args} className="h-48 w-96 rounded-md border">
            <ResizablePanel defaultSize={50}>
                <div className="flex h-full items-center justify-center text-sm">Left</div>
            </ResizablePanel>
            <ResizableHandle aria-label="Resize panels" withHandle />
            <ResizablePanel defaultSize={50}>
                <div className="flex h-full items-center justify-center text-sm">Right</div>
            </ResizablePanel>
        </ResizablePanelGroup>
    ),
};
