import type { RowData } from "@tanstack/react-table";
import { getEmptyCellUpdates } from "@ui/hooks/data-grid/clipboard";
import { isHorizontalNavigation, SEARCH_SHORTCUT_KEY, VIEWPORT_OFFSET } from "@ui/hooks/data-grid/constants";
import type {
    DataGridCellMapRef,
    DataGridElementRef,
    DataGridPropsRef,
    DataGridRowMapRef,
    DataGridRowVirtualizerRef,
    DataGridStore,
    DataGridTableRef,
} from "@ui/hooks/data-grid/types";
import { getCellKey, parseCellKey, scrollCellIntoView } from "@ui/lib/data-grid";
import type { CellPosition, Direction, NavigationDirection, UpdateCell } from "@ui/types/data-grid";

export interface DataGridKeyDownContext<TData extends RowData> {
    blurCell: () => void;
    cellMapRef: DataGridCellMapRef;
    dataGridRef: DataGridElementRef;
    footerRef: DataGridElementRef;
    headerRef: DataGridElementRef;
    navigableColumnIds: string[];
    navigateCell: (direction: NavigationDirection) => void;
    onCellEditingStop: (options?: { direction?: NavigationDirection; moveToNextRow?: boolean }) => void;
    onCellsCopy: () => Promise<void>;
    onCellsCut: () => Promise<void>;
    onCellsPaste: (expandRows?: boolean) => Promise<void>;
    onDataUpdate: (updates: UpdateCell | UpdateCell[]) => void;
    onNavigateToNextMatch: () => void;
    onNavigateToPrevMatch: () => void;
    onRowsDelete: (rowIndices: number[]) => Promise<void>;
    onScrollToRow: (options: Partial<CellPosition>) => Promise<void>;
    onSearchOpenChange: (open: boolean) => void;
    onSelectionClear: () => void;
    propsRef: DataGridPropsRef<TData>;
    restoreFocus: (element: HTMLDivElement | null) => void;
    rowMapRef: DataGridRowMapRef;
    rowVirtualizerRef: DataGridRowVirtualizerRef;
    selectAll: () => void;
    selectRange: (start: CellPosition, end: CellPosition, isSelecting?: boolean) => void;
    store: DataGridStore;
    tableRef: DataGridTableRef<TData>;
    textDirection: Direction;
}

export const handleDataGridKeyDown = <TData extends RowData>(event: KeyboardEvent, context: DataGridKeyDownContext<TData>): void => {
    const {
        blurCell,
        cellMapRef,
        dataGridRef,
        footerRef,
        headerRef,
        navigableColumnIds,
        navigateCell,
        onCellEditingStop,
        onCellsCopy,
        onCellsCut,
        onCellsPaste,
        onDataUpdate,
        onNavigateToNextMatch,
        onNavigateToPrevMatch,
        onRowsDelete,
        onScrollToRow,
        onSearchOpenChange,
        onSelectionClear,
        propsRef,
        restoreFocus,
        rowMapRef,
        rowVirtualizerRef,
        selectAll,
        selectRange,
        store,
        tableRef,
        textDirection,
    } = context;

    const currentState = store.getState();
    const { altKey, ctrlKey, key, metaKey, shiftKey } = event;
    const isCtrlPressed = ctrlKey || metaKey;

    if (propsRef.current.enableSearch && isCtrlPressed && !shiftKey && key === SEARCH_SHORTCUT_KEY) {
        event.preventDefault();
        onSearchOpenChange(true);

        return;
    }

    if (propsRef.current.enableSearch && currentState.searchOpen && !currentState.editingCell) {
        if (key === "Enter") {
            event.preventDefault();

            if (shiftKey) {
                onNavigateToPrevMatch();
            } else {
                onNavigateToNextMatch();
            }

            return;
        }

        if (key === "Escape") {
            event.preventDefault();
            onSearchOpenChange(false);

            return;
        }

        return;
    }

    if (currentState.editingCell) {
        if (key === "Escape") {
            event.preventDefault();
            onCellEditingStop();

            return;
        }

        if (key === "Enter" && !shiftKey && !altKey) {
            event.preventDefault();
            onCellEditingStop({ moveToNextRow: true });

            return;
        }

        if (key === "Tab") {
            event.preventDefault();
            const direction = shiftKey ? "left" : "right";

            onCellEditingStop({ direction });

            return;
        }

        return;
    }

    if (!currentState.focusedCell) {
        return;
    }

    if (isCtrlPressed && !shiftKey && key === "a") {
        event.preventDefault();
        selectAll();

        return;
    }

    if (isCtrlPressed && !shiftKey && key === "c") {
        event.preventDefault();
        onCellsCopy();

        return;
    }

    if (isCtrlPressed && !shiftKey && key === "x" && !propsRef.current.readOnly) {
        event.preventDefault();
        onCellsCut();

        return;
    }

    if (propsRef.current.enablePaste && isCtrlPressed && !shiftKey && key === "v" && !propsRef.current.readOnly) {
        event.preventDefault();
        onCellsPaste();

        return;
    }

    if (isCtrlPressed && key === "Backspace" && !propsRef.current.readOnly && propsRef.current.onRowsDelete) {
        event.preventDefault();

        const rowIndices = new Set<number>();

        if (currentState.selectionState.selectedCells.size > 0) {
            for (const cellKey of currentState.selectionState.selectedCells) {
                const { rowIndex } = parseCellKey(cellKey);

                rowIndices.add(rowIndex);
            }
        } else if (currentState.focusedCell) {
            rowIndices.add(currentState.focusedCell.rowIndex);
        }

        if (rowIndices.size > 0) {
            onRowsDelete([...rowIndices]);
        }

        return;
    }

    if ((key === "Delete" || key === "Backspace") && !isCtrlPressed && !propsRef.current.readOnly) {
        const focusedCellKeys = currentState.focusedCell ? [getCellKey(currentState.focusedCell.rowIndex, currentState.focusedCell.columnId)] : [];
        const cellsToClear = currentState.selectionState.selectedCells.size > 0 ? [...currentState.selectionState.selectedCells] : focusedCellKeys;

        if (cellsToClear.length > 0) {
            event.preventDefault();

            const currentTable = tableRef.current;
            const tableColumns = currentTable?.getAllColumns() ?? [];

            const updates = getEmptyCellUpdates(cellsToClear, tableColumns);

            onDataUpdate(updates);

            if (currentState.selectionState.selectedCells.size > 0) {
                onSelectionClear();
            }

            if (currentState.cutCells.size > 0) {
                store.setState("cutCells", new Set());
            }
        }

        return;
    }

    if (key === "Enter" && shiftKey && !propsRef.current.readOnly && propsRef.current.onRowAdd) {
        event.preventDefault();
        const initialRowCount = propsRef.current.data.length;
        const currentColumnId = currentState.focusedCell.columnId;

        Promise.resolve(propsRef.current.onRowAdd())
            .then(async (result) => {
                if (result === null) {
                    return undefined;
                }

                onSelectionClear();

                const targetRowIndex = result.rowIndex ?? initialRowCount;
                const targetColumnId = result.columnId ?? currentColumnId;

                onScrollToRow({
                    columnId: targetColumnId,
                    rowIndex: targetRowIndex,
                });

                return undefined;
            })
            .catch(() => {
                // Callback threw an error, don't proceed with scroll/focus
            });

        return;
    }

    let direction: NavigationDirection | null = null;

    switch (key) {
        case "ArrowDown": {
            if (altKey && !isCtrlPressed && !shiftKey) {
                direction = "pagedown";
            } else if (isCtrlPressed && shiftKey) {
                const rowCount = tableRef.current?.getRowModel().rows.length || propsRef.current.data.length;
                const selectionEdge = currentState.selectionState.selectionRange?.end || currentState.focusedCell;
                const currentColIndex = navigableColumnIds.indexOf(selectionEdge.columnId);
                const selectionStart = currentState.selectionState.selectionRange?.start || currentState.focusedCell;

                selectRange(selectionStart, {
                    columnId: navigableColumnIds[currentColIndex] ?? selectionEdge.columnId,
                    rowIndex: Math.max(0, rowCount - 1),
                });

                const virtualizer = rowVirtualizerRef.current;

                if (virtualizer) {
                    virtualizer.scrollToIndex(Math.max(0, rowCount - 1), {
                        align: "end",
                    });
                }

                restoreFocus(dataGridRef.current);

                event.preventDefault();

                return;
            } else if (isCtrlPressed && !shiftKey) {
                direction = "ctrl+down";
            } else {
                direction = "down";
            }

            break;
        }
        case "ArrowLeft": {
            if (isCtrlPressed && shiftKey) {
                const selectionEdge = currentState.selectionState.selectionRange?.end || currentState.focusedCell;
                const selectionStart = currentState.selectionState.selectionRange?.start || currentState.focusedCell;
                const targetColumnId = textDirection === "rtl" ? navigableColumnIds[navigableColumnIds.length - 1] : navigableColumnIds[0];

                if (targetColumnId) {
                    selectRange(selectionStart, {
                        columnId: targetColumnId,
                        rowIndex: selectionEdge.rowIndex,
                    });

                    const container = dataGridRef.current;
                    const cellKey = getCellKey(selectionEdge.rowIndex, targetColumnId);
                    const targetCell = cellMapRef.current.get(cellKey);

                    if (container && targetCell) {
                        scrollCellIntoView({
                            container,
                            direction: "home",
                            isRtl: textDirection === "rtl",
                            tableRef,
                            targetCell,
                            viewportOffset: VIEWPORT_OFFSET,
                        });
                    }

                    restoreFocus(container);
                }

                event.preventDefault();

                return;
            }

            direction = isCtrlPressed && !shiftKey ? "home" : "left";
            break;
        }
        case "ArrowRight": {
            if (isCtrlPressed && shiftKey) {
                const selectionEdge = currentState.selectionState.selectionRange?.end || currentState.focusedCell;
                const selectionStart = currentState.selectionState.selectionRange?.start || currentState.focusedCell;
                const targetColumnId = textDirection === "rtl" ? navigableColumnIds[0] : navigableColumnIds[navigableColumnIds.length - 1];

                if (targetColumnId) {
                    selectRange(selectionStart, {
                        columnId: targetColumnId,
                        rowIndex: selectionEdge.rowIndex,
                    });

                    const container = dataGridRef.current;
                    const cellKey = getCellKey(selectionEdge.rowIndex, targetColumnId);
                    const targetCell = cellMapRef.current.get(cellKey);

                    if (container && targetCell) {
                        scrollCellIntoView({
                            container,
                            direction: "end",
                            isRtl: textDirection === "rtl",
                            tableRef,
                            targetCell,
                            viewportOffset: VIEWPORT_OFFSET,
                        });
                    }

                    restoreFocus(container);
                }

                event.preventDefault();

                return;
            }

            direction = isCtrlPressed && !shiftKey ? "end" : "right";
            break;
        }
        case "ArrowUp": {
            if (altKey && !isCtrlPressed && !shiftKey) {
                direction = "pageup";
            } else if (isCtrlPressed && shiftKey) {
                const selectionEdge = currentState.selectionState.selectionRange?.end || currentState.focusedCell;
                const currentColIndex = navigableColumnIds.indexOf(selectionEdge.columnId);
                const selectionStart = currentState.selectionState.selectionRange?.start || currentState.focusedCell;

                selectRange(selectionStart, {
                    columnId: navigableColumnIds[currentColIndex] ?? selectionEdge.columnId,
                    rowIndex: 0,
                });

                const virtualizer = rowVirtualizerRef.current;

                if (virtualizer) {
                    virtualizer.scrollToIndex(0, { align: "start" });
                }

                restoreFocus(dataGridRef.current);

                event.preventDefault();

                return;
            } else if (isCtrlPressed && !shiftKey) {
                direction = "ctrl+up";
            } else {
                direction = "up";
            }

            break;
        }
        case "End": {
            direction = isCtrlPressed ? "ctrl+end" : "end";
            break;
        }
        case "Escape": {
            event.preventDefault();

            if (currentState.selectionState.selectedCells.size > 0 || Object.keys(currentState.rowSelection).length > 0) {
                onSelectionClear();
            } else {
                blurCell();
            }

            return;
        }
        case "Home": {
            direction = isCtrlPressed ? "ctrl+home" : "home";
            break;
        }
        case "PageDown": {
            direction = altKey ? "pageright" : "pagedown";
            break;
        }
        case "PageUp": {
            direction = altKey ? "pageleft" : "pageup";
            break;
        }
        case "Tab": {
            event.preventDefault();

            if (textDirection === "rtl") {
                direction = event.shiftKey ? "right" : "left";
            } else {
                direction = event.shiftKey ? "left" : "right";
            }

            break;
        }
        default: {
            break;
        }
    }

    if (direction) {
        event.preventDefault();

        if (shiftKey && key !== "Tab" && currentState.focusedCell) {
            const selectionEdge = currentState.selectionState.selectionRange?.end || currentState.focusedCell;

            const currentColIndex = navigableColumnIds.indexOf(selectionEdge.columnId);
            let newRowIndex = selectionEdge.rowIndex;
            let newColumnId = selectionEdge.columnId;

            const isRtl = textDirection === "rtl";

            const rowCount = tableRef.current?.getRowModel().rows.length || propsRef.current.data.length;

            switch (direction) {
                case "down": {
                    newRowIndex = Math.min(rowCount - 1, selectionEdge.rowIndex + 1);
                    break;
                }
                case "end": {
                    if (navigableColumnIds.length > 0) {
                        newColumnId = navigableColumnIds[navigableColumnIds.length - 1] ?? newColumnId;
                    }

                    break;
                }
                case "home": {
                    if (navigableColumnIds.length > 0) {
                        newColumnId = navigableColumnIds[0] ?? newColumnId;
                    }

                    break;
                }
                case "left": {
                    if (isRtl) {
                        if (currentColIndex < navigableColumnIds.length - 1) {
                            const nextColumnId = navigableColumnIds[currentColIndex + 1];

                            if (nextColumnId) newColumnId = nextColumnId;
                        }
                    } else if (currentColIndex > 0) {
                        const prevColumnId = navigableColumnIds[currentColIndex - 1];

                        if (prevColumnId) newColumnId = prevColumnId;
                    }

                    break;
                }
                case "right": {
                    if (isRtl) {
                        if (currentColIndex > 0) {
                            const prevColumnId = navigableColumnIds[currentColIndex - 1];

                            if (prevColumnId) newColumnId = prevColumnId;
                        }
                    } else if (currentColIndex < navigableColumnIds.length - 1) {
                        const nextColumnId = navigableColumnIds[currentColIndex + 1];

                        if (nextColumnId) newColumnId = nextColumnId;
                    }

                    break;
                }
                case "up": {
                    newRowIndex = Math.max(0, selectionEdge.rowIndex - 1);
                    break;
                }
                default: {
                    break;
                }
            }

            const selectionStart = currentState.selectionState.selectionRange?.start || currentState.focusedCell;

            selectRange(selectionStart, {
                columnId: newColumnId,
                rowIndex: newRowIndex,
            });

            const container = dataGridRef.current;
            const targetRow = rowMapRef.current.get(newRowIndex);
            const cellKey = getCellKey(newRowIndex, newColumnId);
            const targetCell = cellMapRef.current.get(cellKey);

            if (newRowIndex !== selectionEdge.rowIndex && (direction === "up" || direction === "down")) {
                if (container && targetRow) {
                    const containerRect = container.getBoundingClientRect();
                    const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0;
                    const footerHeight = footerRef.current?.getBoundingClientRect().height ?? 0;

                    const viewportTop = containerRect.top + headerHeight + VIEWPORT_OFFSET;
                    const viewportBottom = containerRect.bottom - footerHeight - VIEWPORT_OFFSET;

                    const rowRect = targetRow.getBoundingClientRect();
                    const isFullyVisible = rowRect.top >= viewportTop && rowRect.bottom <= viewportBottom;

                    if (!isFullyVisible) {
                        const scrollNeeded = direction === "down" ? rowRect.bottom - viewportBottom : viewportTop - rowRect.top;

                        if (direction === "down") {
                            container.scrollTop += scrollNeeded;
                        } else {
                            container.scrollTop -= scrollNeeded;
                        }

                        restoreFocus(container);
                    }
                } else {
                    const virtualizer = rowVirtualizerRef.current;

                    if (virtualizer) {
                        const align = direction === "up" ? "start" : "end";

                        virtualizer.scrollToIndex(newRowIndex, { align });

                        restoreFocus(container);
                    }
                }
            }

            if (newColumnId !== selectionEdge.columnId && isHorizontalNavigation(direction) && container && targetCell) {
                scrollCellIntoView({
                    container,
                    direction,
                    isRtl,
                    tableRef,
                    targetCell,
                    viewportOffset: VIEWPORT_OFFSET,
                });
            }
        } else {
            if (currentState.selectionState.selectedCells.size > 0) {
                onSelectionClear();
            }

            navigateCell(direction);
        }
    }
};

export interface GlobalKeyDownContext<TData extends RowData> {
    dataGridRef: DataGridElementRef;
    onSearchOpenChange: (open: boolean) => void;
    onSelectionClear: () => void;
    propsRef: DataGridPropsRef<TData>;
    store: DataGridStore;
}

export const handleGlobalKeyDown = <TData extends RowData>(event: KeyboardEvent, context: GlobalKeyDownContext<TData>): void => {
    const { dataGridRef, onSearchOpenChange, onSelectionClear, propsRef, store } = context;

    const dataGridElement = dataGridRef.current;

    if (!dataGridElement) {
        return;
    }

    const { target } = event;

    if (!(target instanceof HTMLElement)) {
        return;
    }

    const { ctrlKey, key, metaKey, shiftKey } = event;
    const isCommandPressed = ctrlKey || metaKey;

    if (propsRef.current.enableSearch && isCommandPressed && !shiftKey && key === SEARCH_SHORTCUT_KEY) {
        const isInInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
        const isInDataGrid = dataGridElement.contains(target);
        const isInSearchInput = target.closest('[role="search"]') !== null;

        if (isInDataGrid || isInSearchInput || !isInInput) {
            event.preventDefault();
            event.stopPropagation();

            const nextSearchOpen = !store.getState().searchOpen;

            onSearchOpenChange(nextSearchOpen);

            if (nextSearchOpen && !isInDataGrid && !isInSearchInput) {
                requestAnimationFrame(() => {
                    dataGridElement.focus();
                });
            }

            return;
        }
    }

    const isInDataGrid = dataGridElement.contains(target);

    if (!isInDataGrid) {
        return;
    }

    if (key === "Escape") {
        const currentState = store.getState();
        const hasSelections = currentState.selectionState.selectedCells.size > 0 || Object.keys(currentState.rowSelection).length > 0;

        if (hasSelections) {
            event.preventDefault();
            event.stopPropagation();
            onSelectionClear();
        }
    }
};
