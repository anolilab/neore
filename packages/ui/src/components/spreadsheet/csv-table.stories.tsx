import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent } from "storybook/test";

import type { CsvTableProps, SortConfig } from "./csv-table";
import { CsvTable } from "./csv-table";

const HEADERS = ["name", "city", "age", "member"];

const DATA: Record<string, unknown>[] = [
    { age: 31, city: "Berlin", member: true, name: "Ada" },
    { age: 27, city: "Lisbon", member: false, name: "Grace" },
    { age: 45, city: "Oslo", member: true, name: "Linus" },
    { age: 52, city: "Boston", member: true, name: "Margaret" },
];

const Harness = ({ onSort, sortConfig: initialSort, ...props }: CsvTableProps) => {
    const [sortConfig, setSortConfig] = useState<SortConfig>(initialSort);

    return (
        <CsvTable
            {...props}
            onSort={(column) => {
                onSort(column);
                setSortConfig((current) => {
                    return { column, direction: current.column === column && current.direction === "asc" ? "desc" : "asc" };
                });
            }}
            sortConfig={sortConfig}
        />
    );
};

const meta = {
    args: { data: DATA, headers: HEADERS, onSort: fn(), sortConfig: { column: "", direction: null } },
    component: Harness,
    title: "UI/Files/CSV table",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Berlin")).toBeVisible();
    },
};

export const SortedAscending: Story = {
    args: { sortConfig: { column: "age", direction: "asc" } },
};

export const SortByClick: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /name/i }));
        await expect(args.onSort).toHaveBeenCalledWith("name");
    },
};

export const NoSearchResults: Story = {
    args: { data: [], onClearSearch: fn(), searchTerm: "Zurich" },
};

export const EmptyData: Story = {
    args: { data: [] },
};
