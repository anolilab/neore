"use client";

import type { RowData } from "@tanstack/react-table";
import {
    CheckboxCell,
    DateCell,
    FileCell,
    LongTextCell,
    MultiSelectCell,
    NumberCell,
    SelectCell,
    ShortTextCell,
    UrlCell,
} from "@ui/components/data-grid/data-grid-cell-variants";
import type { DataGridCellProps } from "@ui/types/data-grid";
import * as React from "react";

const DataGridCell = React.memo(DataGridCellImpl, (prev, next) => {
    // Fast path: check stable primitive props first
    if (prev.isFocused !== next.isFocused) {
        return false;
    }

    if (prev.isEditing !== next.isEditing) {
        return false;
    }

    if (prev.isSelected !== next.isSelected) {
        return false;
    }

    if (prev.isSearchMatch !== next.isSearchMatch) {
        return false;
    }

    if (prev.isActiveSearchMatch !== next.isActiveSearchMatch) {
        return false;
    }

    if (prev.readOnly !== next.readOnly) {
        return false;
    }

    if (prev.rowIndex !== next.rowIndex) {
        return false;
    }

    if (prev.columnId !== next.columnId) {
        return false;
    }

    if (prev.rowHeight !== next.rowHeight) {
        return false;
    }

    // Check cell value using row.original instead of getValue() for stability
    // getValue() is unstable and recreates on every render, breaking memoization
    const prevValue = (prev.cell.row.original as Record<string, unknown>)[prev.columnId];
    const nextValue = (next.cell.row.original as Record<string, unknown>)[next.columnId];

    if (prevValue !== nextValue) {
        return false;
    }

    // Check cell/row identity
    if (prev.cell.row.id !== next.cell.row.id) {
        return false;
    }

    return true;
}) as typeof DataGridCellImpl;

function DataGridCellImpl<TData extends RowData>({
    cell,
    columnId,
    isActiveSearchMatch,
    isEditing,
    isFocused,
    isSearchMatch,
    isSelected,
    readOnly,
    rowHeight,
    rowIndex,
    tableMeta,
}: DataGridCellProps<TData>) {
    const cellOptions = cell.column.columnDef.meta?.cell;
    const variant = cellOptions?.variant ?? "text";

    let Comp: React.ComponentType<DataGridCellProps<TData>>;

    switch (variant) {
        case "checkbox": {
            Comp = CheckboxCell;
            break;
        }
        case "date": {
            Comp = DateCell;
            break;
        }
        case "file": {
            Comp = FileCell;
            break;
        }
        case "long-text": {
            Comp = LongTextCell;
            break;
        }
        case "multi-select": {
            Comp = MultiSelectCell;
            break;
        }
        case "number": {
            Comp = NumberCell;
            break;
        }
        case "select": {
            Comp = SelectCell;
            break;
        }
        case "short-text": {
            Comp = ShortTextCell;
            break;
        }
        case "url": {
            Comp = UrlCell;
            break;
        }

        default: {
            Comp = ShortTextCell;
            break;
        }
    }

    return (
        <Comp
            cell={cell}
            columnId={columnId}
            isActiveSearchMatch={isActiveSearchMatch}
            isEditing={isEditing}
            isFocused={isFocused}
            isSearchMatch={isSearchMatch}
            isSelected={isSelected}
            readOnly={readOnly}
            rowHeight={rowHeight}
            rowIndex={rowIndex}
            tableMeta={tableMeta}
        />
    );
}

export default DataGridCell;
