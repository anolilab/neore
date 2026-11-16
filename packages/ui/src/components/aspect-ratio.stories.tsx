import type { Meta, StoryObj } from "@storybook/react-vite";

import { AspectRatio } from "./aspect-ratio";

const meta = {
    args: { ratio: 16 / 9 },
    component: AspectRatio,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    render: ({ ratio, ...args }) => (
        <AspectRatio className="bg-muted flex items-center justify-center rounded-lg text-sm" ratio={ratio} {...args}>
            {ratio.toFixed(2)}
        </AspectRatio>
    ),
    title: "UI/AspectRatio",
} satisfies Meta<typeof AspectRatio>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Widescreen: Story = {};

export const Square: Story = { args: { ratio: 1 } };

export const Portrait: Story = { args: { ratio: 3 / 4 } };
