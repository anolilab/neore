import type { Meta, StoryObj } from "@storybook/react-vite";

import { Skeleton } from "./skeleton";

const meta = {
    component: Skeleton,
    title: "UI/Skeleton",
} satisfies Meta<typeof Skeleton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Line: Story = { args: { className: "h-4 w-64" } };

export const Circle: Story = { args: { className: "size-10 rounded-full" } };

export const CardPlaceholder: Story = {
    render: () => (
        <div className="flex w-72 items-center gap-3">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
            </div>
        </div>
    ),
};
