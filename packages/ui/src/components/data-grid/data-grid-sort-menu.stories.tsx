import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { useDataGrid } from "@ui/hooks/use-data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import DataGridSortMenu from "./data-grid-sort-menu";

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

const NO_SORTING: SortingState = [];

interface HarnessProps {
    disabled?: boolean;
    sorting?: SortingState;
}

const Harness = ({ disabled, sorting = NO_SORTING }: HarnessProps) => {
    const { table } = useDataGrid<Item>({ columns: COLUMNS, data: ITEMS, initialState: { sorting } });

    return <DataGridSortMenu disabled={disabled} table={table} />;
};

const meta = {
    component: Harness,
    title: "UI/Data grid/Data grid sort menu",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: /Sort/ })).toBeVisible();
    },
};

export const OpenWithoutSorts: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /Sort/ }));
        const element = await screen.findByRole("dialog");

        await waitFor(() => expect(element).toBeVisible());
    },
};

export const OpenWithSorts: Story = {
    args: {
        sorting: [
            { desc: false, id: "name" },
            { desc: true, id: "age" },
        ],
    },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /Sort/ }));
        const element = await screen.findByRole("dialog");

        await waitFor(() => expect(element).toBeVisible());
    },
};

export const Disabled: Story = {
    args: { disabled: true },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: /Sort/ })).toBeDisabled();
    },
};
