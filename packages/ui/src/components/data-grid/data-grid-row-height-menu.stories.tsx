import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ColumnDef } from "@tanstack/react-table";
import { useDataGrid } from "@ui/hooks/use-data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import type { RowHeightValue } from "@ui/types/data-grid";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import DataGridRowHeightMenu from "./data-grid-row-height-menu";

interface Item {
    age: number;
    city: string;
    name: string;
}

const ITEMS: Item[] = [
    { age: 31, city: "Berlin", name: "Ada" },
    { age: 27, city: "Lisbon", name: "Grace" },
    { age: 45, city: "Oslo", name: "Linus" },
];

const COLUMNS: ColumnDef<DataGridFeatures, Item, unknown>[] = [
    { accessorKey: "name", id: "name", meta: { cell: { variant: "short-text" }, label: "Name" } },
    { accessorKey: "city", id: "city", meta: { cell: { variant: "short-text" }, label: "City" } },
    { accessorKey: "age", id: "age", meta: { cell: { variant: "number" }, label: "Age" } },
];

interface HarnessProps {
    disabled?: boolean;
    rowHeight?: RowHeightValue;
}

const Harness = ({ disabled, rowHeight = "short" }: HarnessProps) => {
    const { table } = useDataGrid<Item>({ columns: COLUMNS, data: ITEMS, rowHeight });

    return <DataGridRowHeightMenu disabled={disabled} table={table} />;
};

const meta = {
    component: Harness,
    title: "UI/Data grid/Data grid row height menu",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("combobox")).toBeVisible();
    },
};

export const TallSelected: Story = {
    args: { rowHeight: "tall" },
};

export const Open: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("combobox"));
        await waitFor(() => {
            expect(screen.getByRole("option", { name: "Extra Tall" })).toBeVisible();
        });
    },
};

export const Disabled: Story = {
    args: { disabled: true },
};
