import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { ScrollArea } from "./scroll-area";

const lines = Array.from({ length: 30 }, (_, index) => `Conversation ${index + 1}`);

const meta = {
    component: ScrollArea,
    render: (args) => (
        <ScrollArea {...args} className="h-48 w-64 rounded-md border">
            <ul className="p-3 text-sm">
                {lines.map((line) => (
                    <li className="py-1" key={line}>
                        {line}
                    </li>
                ))}
            </ul>
        </ScrollArea>
    ),
    title: "UI/Scroll area",
} satisfies Meta<typeof ScrollArea>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByText("Conversation 1")).toBeVisible();
    },
};

export const WithFade: Story = { args: { scrollFade: true } };

export const WithGutter: Story = { args: { scrollbarGutter: true } };

export const Horizontal: Story = {
    render: (args) => (
        <ScrollArea {...args} className="w-64 rounded-md border">
            <div className="flex w-[600px] gap-2 p-3 text-sm whitespace-nowrap">
                {lines.slice(0, 8).map((line) => (
                    <span className="bg-muted rounded px-2 py-1" key={line}>
                        {line}
                    </span>
                ))}
            </div>
        </ScrollArea>
    ),
};
