import type { Meta, StoryObj } from "@storybook/react-vite";

import { DataGridSkeleton, DataGridSkeletonGrid, DataGridSkeletonToolbar } from "./data-grid-skeleton";

const meta = {
    args: { children: null },
    component: DataGridSkeleton,
    decorators: [
        (Story) => (
            <div className="h-96">
                <Story />
            </div>
        ),
    ],
    title: "UI/Data grid/Data grid skeleton",
} satisfies Meta<typeof DataGridSkeleton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: () => (
        <DataGridSkeleton className="h-full">
            <DataGridSkeletonGrid />
        </DataGridSkeleton>
    ),
};

export const WithToolbar: Story = {
    render: () => (
        <DataGridSkeleton className="h-full">
            <DataGridSkeletonToolbar />
            <DataGridSkeletonGrid />
        </DataGridSkeleton>
    ),
};

export const ToolbarAlignedStart: Story = {
    render: () => (
        <DataGridSkeleton className="h-full">
            <DataGridSkeletonToolbar actionCount={2} align="start" />
            <DataGridSkeletonGrid />
        </DataGridSkeleton>
    ),
};
