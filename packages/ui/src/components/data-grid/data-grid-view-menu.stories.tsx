import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ColumnDef } from "@tanstack/react-table";
import { useDataGrid } from "@ui/hooks/use-data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import DataGridViewMenu from "./data-grid-view-menu";

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

const NO_COLUMNS: string[] = [];

interface HarnessProps {
    disabled?: boolean;
    hiddenColumns?: string[];
}

const Harness = ({ disabled, hiddenColumns = NO_COLUMNS }: HarnessProps) => {
    const { table } = useDataGrid<Item>({
        columns: COLUMNS,
        data: ITEMS,
        initialState: { columnVisibility: Object.fromEntries(hiddenColumns.map((id) => [id, false])) },
    });

    return <DataGridViewMenu disabled={disabled} table={table} />;
};

const meta = {
    component: Harness,
    title: "UI/Data grid/Data grid view menu",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

// The trigger is hidden below the lg breakpoint, so the popover is only opened where it is shown.
const openIfVisible = async (canvas: { findByRole: (role: "combobox", options: { name: string }) => Promise<HTMLElement> }) => {
    const trigger = await canvas.findByRole("combobox", { name: "Toggle columns" });

    if (getComputedStyle(trigger).display === "none") {
        return;
    }

    await userEvent.click(trigger);
    const element = await screen.findByPlaceholderText("Search columns...");

    await waitFor(() => expect(element).toBeVisible());
};

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("combobox", { hidden: true, name: "Toggle columns" })).toBeInTheDocument();
    },
};

export const Open: Story = {
    play: async ({ canvas }) => {
        await openIfVisible(canvas);
    },
};

export const WithHiddenColumns: Story = {
    args: { hiddenColumns: ["city"] },
    play: async ({ canvas }) => {
        await openIfVisible(canvas);
    },
};

export const Disabled: Story = {
    args: { disabled: true },
};
