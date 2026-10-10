"use client";

import { useLingui } from "@lingui/react/macro";
import type { CellContext, RowData, Table } from "@tanstack/react-table";
import { Checkbox } from "@ui/components/checkbox";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import cn from "@ui/utils/cn";
import * as React from "react";

const DataGridSelectCheckbox = ({ className, ...props }: React.ComponentProps<typeof Checkbox>) => (
    <Checkbox
        className={cn("hover:border-primary/40 relative transition-[shadow,border] after:absolute after:-inset-2.5 after:content-['']", className)}
        {...props}
    />
);

const DataGridSelectHeader = <TData extends RowData>({ table }: { table: Table<DataGridFeatures, TData> }) => {
    const { t } = useLingui();
    const onCheckedChange = React.useCallback((value: boolean) => table.toggleAllPageRowsSelected(value), [table]);

    return (
        <DataGridSelectCheckbox
            aria-label={t`Select all`}
            checked={table.getIsAllPageRowsSelected()}
            indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
            onCheckedChange={onCheckedChange}
        />
    );
};

const DataGridSelectCell = <TData extends RowData>({ row, table }: Pick<CellContext<DataGridFeatures, TData, unknown>, "row" | "table">) => {
    const { t } = useLingui();
    const onRowSelect = table.options.meta?.onRowSelect;

    const onCheckedChange = React.useCallback(
        (value: boolean) => {
            if (onRowSelect) {
                onRowSelect(row.index, value, false);
            } else {
                row.toggleSelected(value);
            }
        },
        [onRowSelect, row],
    );

    const onClick = React.useCallback(
        (event: React.MouseEvent) => {
            if (!event.shiftKey) {
                return;
            }

            event.preventDefault();
            onRowSelect?.(row.index, !row.getIsSelected(), true);
        },
        [onRowSelect, row],
    );

    return <DataGridSelectCheckbox aria-label={t`Select row`} checked={row.getIsSelected()} onCheckedChange={onCheckedChange} onClick={onClick} />;
};

export { DataGridSelectCell, DataGridSelectCheckbox, DataGridSelectHeader };
