"use client";

import type { ColumnDef, RowData } from "@tanstack/react-table";
import { DataGridSelectCell, DataGridSelectHeader } from "@ui/components/data-grid/data-grid-select-cells";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";

const getDataGridSelectColumn = <TData extends RowData>({
    enableHiding = false,
    enableResizing = false,
    enableSorting = false,
    size = 40,
    ...props
}: Partial<ColumnDef<DataGridFeatures, TData>> = {}): ColumnDef<DataGridFeatures, TData> => {
    return {
        cell: DataGridSelectCell,
        enableHiding,
        enableResizing,
        enableSorting,
        header: DataGridSelectHeader,
        id: "select",
        size,
        ...props,
    };
};

export default getDataGridSelectColumn;
