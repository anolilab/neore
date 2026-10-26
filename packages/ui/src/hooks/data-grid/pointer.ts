import type { RowData } from "@tanstack/react-table";
import { VIEWPORT_OFFSET } from "@ui/hooks/data-grid/constants";
import type { DataGridCellMapRef, DataGridElementRef, DataGridStore, DataGridTableRef } from "@ui/hooks/data-grid/types";
import { getCellKey, scrollCellIntoView } from "@ui/lib/data-grid";
import type { CellPosition, Direction } from "@ui/types/data-grid";
import type * as React from "react";

export interface CellClickContext<TData extends RowData> {
    cellMapRef: DataGridCellMapRef;
    dataGridRef: DataGridElementRef;
    focusCell: (rowIndex: number, columnId: string) => void;
    onCellEditingStart: (rowIndex: number, columnId: string) => void;
    onSelectionClear: () => void;
    selectRange: (start: CellPosition, end: CellPosition, isSelecting?: boolean) => void;
    store: DataGridStore;
    tableRef: DataGridTableRef<TData>;
    textDirection: Direction;
}

export const handleCellClick = <TData extends RowData>(
    rowIndex: number,
    columnId: string,
    event: React.MouseEvent | undefined,
    context: CellClickContext<TData>,
): void => {
    const { cellMapRef, dataGridRef, focusCell, onCellEditingStart, onSelectionClear, selectRange, store, tableRef, textDirection } = context;

    if (event?.button === 2) {
        return;
    }

    const currentState = store.getState();
    const currentFocused = currentState.focusedCell;

    const scrollToCell = () => {
        requestAnimationFrame(() => {
            const container = dataGridRef.current;
            const cellKey = getCellKey(rowIndex, columnId);
            const targetCell = cellMapRef.current.get(cellKey);

            if (container && targetCell) {
                scrollCellIntoView({
                    container,
                    isRtl: textDirection === "rtl",
                    tableRef,
                    targetCell,
                    viewportOffset: VIEWPORT_OFFSET,
                });
            }
        });
    };

    if (event) {
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const cellKey = getCellKey(rowIndex, columnId);
            const newSelectedCells = new Set(currentState.selectionState.selectedCells);

            if (newSelectedCells.has(cellKey)) {
                newSelectedCells.delete(cellKey);
            } else {
                newSelectedCells.add(cellKey);
            }

            store.setState("selectionState", {
                isSelecting: false,
                selectedCells: newSelectedCells,
                selectionRange: null,
            });
            focusCell(rowIndex, columnId);
            scrollToCell();

            return;
        }

        if (event.shiftKey && currentState.focusedCell) {
            event.preventDefault();
            selectRange(currentState.focusedCell, { columnId, rowIndex });
            scrollToCell();

            return;
        }
    }

    const hasSelectedCells = currentState.selectionState.selectedCells.size > 0;
    const hasSelectedRows = Object.keys(currentState.rowSelection).length > 0;

    if (hasSelectedCells && !currentState.selectionState.isSelecting) {
        const cellKey = getCellKey(rowIndex, columnId);
        const isClickingSelectedCell = currentState.selectionState.selectedCells.has(cellKey);

        if (isClickingSelectedCell) {
            focusCell(rowIndex, columnId);
            scrollToCell();

            return;
        }

        onSelectionClear();
    } else if (hasSelectedRows && columnId !== "select") {
        onSelectionClear();
    }

    if (currentFocused?.rowIndex === rowIndex && currentFocused?.columnId === columnId) {
        onCellEditingStart(rowIndex, columnId);
    } else {
        focusCell(rowIndex, columnId);
        scrollToCell();
    }
};
