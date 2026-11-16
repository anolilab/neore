import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";

import { FabricCanvasEditor } from "./fabric-canvas-editor";

const DESIGN: Record<string, unknown> = {
    objects: [
        { fill: "#3b82f6", height: 120, left: 60, top: 60, type: "Rect", width: 200 },
        { fill: "#ef4444", left: 340, radius: 50, top: 80, type: "Circle" },
    ],
    version: "6.0.0",
};

const meta = {
    args: { height: 420, width: 640 },
    component: FabricCanvasEditor,
    title: "UI/Editors/Fabric canvas editor",
} satisfies Meta<typeof FabricCanvasEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(canvasElement.querySelector("canvas.upper-canvas")).not.toBeNull(), { timeout: 10_000 });
    },
};

export const WithDesign: Story = {
    args: { canvasJson: DESIGN },
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(canvasElement.querySelector("canvas.upper-canvas")).not.toBeNull(), { timeout: 10_000 });
    },
};

export const DarkChrome: Story = {
    args: { canvasJson: DESIGN, darkMode: true },
};

export const ReadOnly: Story = {
    args: { canvasJson: DESIGN, readOnly: true },
};

export const CustomBackground: Story = {
    args: { backgroundColor: "#fef3c7", canvasJson: DESIGN },
};
