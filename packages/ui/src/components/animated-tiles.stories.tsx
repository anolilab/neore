import type { Meta, StoryObj } from "@storybook/react-vite";

import AnimatedTiles from "./animated-tiles";

const meta: Meta<typeof AnimatedTiles> = {
    args: { gradientColor: "#7c3aed", tileSize: 24 },
    argTypes: { cols: { control: { max: 8, min: 2, type: "number" } }, rows: { control: { max: 12, min: 2, type: "number" } } },
    component: AnimatedTiles,
    title: "UI/AnimatedTiles",
};

export default meta;

type Story = StoryObj<typeof AnimatedTiles>;

export const Default: Story = {};

export const Large: Story = { args: { tileSize: 36 } };

export const Compact: Story = { args: { cols: 4, rows: 6, tileSize: 20 } };
