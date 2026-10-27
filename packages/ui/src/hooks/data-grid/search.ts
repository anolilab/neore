import type { RowData } from "@tanstack/react-table";
import type { DataGridTableRef } from "@ui/hooks/data-grid/types";
import type { CellPosition } from "@ui/types/data-grid";

/** Every visible cell whose text contains `query` (case-insensitive), in row order. */
export const findSearchMatches = <TData extends RowData>(query: string, tableRef: DataGridTableRef<TData>, columnIds: string[]): CellPosition[] => {
    const matches: CellPosition[] = [];
    const currentTable = tableRef.current;
    const rows = currentTable?.getRowModel().rows ?? [];

    const lowerQuery = query.toLowerCase();

    for (const [rowIndex, row] of rows.entries()) {
        if (!row) {
            continue;
        }

        for (const columnId of columnIds) {
            const cell = row.getVisibleCells().find((c) => c.column.id === columnId);

            if (!cell) {
                continue;
            }

            const value = cell.getValue();
            const stringValue = String(value ?? "").toLowerCase();

            if (stringValue.includes(lowerQuery)) {
                matches.push({ columnId, rowIndex });
            }
        }
    }

    return matches;
};
