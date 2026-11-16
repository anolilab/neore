import type { Meta, StoryObj } from "@storybook/react-vite";

import { Separator } from "./separator";

const meta = {
    argTypes: { orientation: { control: "inline-radio", options: ["horizontal", "vertical"] } },
    component: Separator,
    title: "UI/Separator",
} satisfies Meta<typeof Separator>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
    render: (args) => (
        <div className="w-72 space-y-2 text-sm">
            <p>Above</p>
            <Separator {...args} />
            <p>Below</p>
        </div>
    ),
};

export const Vertical: Story = {
    args: { orientation: "vertical" },
    render: (args) => (
        <div className="flex h-5 items-center gap-3 text-sm">
            <span>Docs</span>
            <Separator {...args} />
            <span>Blog</span>
            <Separator {...args} />
            <span>Changelog</span>
        </div>
    ),
};
