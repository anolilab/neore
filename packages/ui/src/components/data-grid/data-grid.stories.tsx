import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ColumnDef } from "@tanstack/react-table";
import type { UseDataGridProps } from "@ui/hooks/use-data-grid";
import { useDataGrid } from "@ui/hooks/use-data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import { expect } from "storybook/test";

import DataGrid from "./data-grid";
import getDataGridSelectColumn from "./data-grid-select-column";

interface Task {
    done: boolean;
    due: string;
    id: string;
    notes: string;
    priority: string;
    title: string;
    votes: number;
}

const TASKS: Task[] = [
    { done: true, due: "2026-11-02", id: "t1", notes: "Shipped in the last release.", priority: "high", title: "Write release notes", votes: 4 },
    { done: false, due: "2026-11-09", id: "t2", notes: "Waiting on design review.", priority: "medium", title: "Review onboarding copy", votes: 2 },
    { done: false, due: "2026-11-12", id: "t3", notes: "Needs a fixture for the empty state.", priority: "low", title: "Add empty state stories", votes: 7 },
    { done: false, due: "2026-11-14", id: "t4", notes: "Check the mobile layout as well.", priority: "high", title: "Fix sidebar overflow", votes: 5 },
    { done: true, due: "2026-11-01", id: "t5", notes: "Done.", priority: "low", title: "Rotate API keys", votes: 1 },
];

const PRIORITY_OPTIONS = [
    { label: "High", value: "high" },
    { label: "Medium", value: "medium" },
    { label: "Low", value: "low" },
];

const COLUMNS: ColumnDef<DataGridFeatures, Task, unknown>[] = [
    getDataGridSelectColumn<Task>(),
    { accessorKey: "title", id: "title", meta: { cell: { variant: "short-text" }, label: "Title" }, size: 220 },
    { accessorKey: "priority", id: "priority", meta: { cell: { options: PRIORITY_OPTIONS, variant: "select" }, label: "Priority" }, size: 140 },
    { accessorKey: "votes", id: "votes", meta: { cell: { max: 99, min: 0, variant: "number" }, label: "Votes" }, size: 100 },
    { accessorKey: "due", id: "due", meta: { cell: { variant: "date" }, label: "Due" }, size: 150 },
    { accessorKey: "done", id: "done", meta: { cell: { variant: "checkbox" }, label: "Done" }, size: 90 },
    { accessorKey: "notes", id: "notes", meta: { cell: { variant: "long-text" }, label: "Notes" }, size: 260 },
];

interface HarnessProps extends Partial<Pick<UseDataGridProps<Task>, "dir" | "enableSearch" | "readOnly" | "rowHeight">> {
    addRows?: boolean;
    data?: Task[];
    height?: number;
    stretchColumns?: boolean;
}

const Harness = ({ addRows = false, data = TASKS, height = 360, stretchColumns, ...options }: HarnessProps) => {
    const { table, ...gridProps } = useDataGrid<Task>({
        columns: COLUMNS,
        data,
        getRowId: (row) => row.id,
        onRowAdd: addRows ? () => null : undefined,
        ...options,
    });

    return <DataGrid {...gridProps} height={height} stretchColumns={stretchColumns} table={table} />;
};

const meta = {
    component: Harness,
    title: "UI/Data grid/Data grid",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("grid", { name: "Data grid" })).toBeVisible();
        await expect(await canvas.findByText("Write release notes")).toBeVisible();
    },
};

export const ReadOnly: Story = {
    args: { readOnly: true },
};

export const WithAddRow: Story = {
    args: { addRows: true },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("gridcell", { name: "Add row" })).toBeVisible();
    },
};

export const StretchedColumns: Story = {
    args: { stretchColumns: true },
};

export const TallRows: Story = {
    args: { rowHeight: "tall" },
};

export const WithSearch: Story = {
    args: { enableSearch: true },
};

export const Empty: Story = {
    args: { data: [] },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("grid", { name: "Data grid" })).toBeVisible();
        await expect(canvas.queryByText("Write release notes")).toBeNull();
    },
};

export const RightToLeft: Story = {
    args: { dir: "rtl" },
};
