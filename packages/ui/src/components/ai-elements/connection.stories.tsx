import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FC } from "react";
import { expect } from "storybook/test";

import Connection from "./connection";

// The line only reads the four coordinates, so the rest of the props xyflow passes while dragging are left out.
const Line = Connection as FC<Record<"fromX" | "fromY" | "toX" | "toY", number>>;

// The connection line is drawn while a link is dragged between two handles; here it is rendered directly in an SVG.
const ConnectionPreview = () => (
    <svg aria-label="Connection line" className="bg-card h-32 w-80 rounded border" role="img">
        <Line fromX={20} fromY={100} toX={280} toY={30} />
    </svg>
);

const meta = {
    component: ConnectionPreview,
    title: "Chat/Connection",
} satisfies Meta<typeof ConnectionPreview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("img", { name: "Connection line" })).toBeVisible();
    },
};
