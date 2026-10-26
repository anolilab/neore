import type { RowData } from "@tanstack/react-table";
import {
    getScrollAlign,
    HORIZONTAL_PAGE_SIZE,
    SCROLL_ALIGN_END_DIRECTIONS,
    VERTICAL_NAVIGATION_DIRECTIONS,
    VIEWPORT_OFFSET,
} from "@ui/hooks/data-grid/constants";
import type {
    DataGridCellMapRef,
    DataGridElementRef,
    DataGridPropsRef,
    DataGridRowMapRef,
    DataGridRowVirtualizerRef,
    DataGridStore,
    DataGridTableRef,
} from "@ui/hooks/data-grid/types";
import { getCellKey, getRowHeightValue, getScrollDirection, scrollCellIntoView } from "@ui/lib/data-grid";
import type { Direction, NavigationDirection, RowHeightValue } from "@ui/types/data-grid";

export interface NavigateCellContext<TData extends RowData> {
    cellMapRef: DataGridCellMapRef;
    dataGridRef: DataGridElementRef;
    focusCell: (rowIndex: number, columnId: string) => void;
    footerRef: DataGridElementRef;
    headerRef: DataGridElementRef;
    navigableColumnIds: string[];
    propsRef: DataGridPropsRef<TData>;
    rowHeight: RowHeightValue;
    rowMapRef: DataGridRowMapRef;
    rowVirtualizerRef: DataGridRowVirtualizerRef;
    store: DataGridStore;
    tableRef: DataGridTableRef<TData>;
    textDirection: Direction;
}

export const navigateToCell = <TData extends RowData>(direction: NavigationDirection, context: NavigateCellContext<TData>): void => {
    const {
        cellMapRef,
        dataGridRef,
        focusCell,
        footerRef,
        headerRef,
        navigableColumnIds,
        propsRef,
        rowHeight,
        rowMapRef,
        rowVirtualizerRef,
        store,
        tableRef,
        textDirection,
    } = context;

    const currentState = store.getState();

    if (!currentState.focusedCell) {
        return;
    }

    const { columnId, rowIndex } = currentState.focusedCell;
    const currentColIndex = navigableColumnIds.indexOf(columnId);
    const rowVirtualizer = rowVirtualizerRef.current;
    const currentTable = tableRef.current;
    const rows = currentTable?.getRowModel().rows ?? [];
    const rowCount = rows.length ?? propsRef.current.data.length;

    let newRowIndex = rowIndex;
    let newColumnId = columnId;

    const isRtl = textDirection === "rtl";

    switch (direction) {
        case "ctrl+down": {
            newRowIndex = Math.max(0, rowCount - 1);
            break;
        }
        case "ctrl+end": {
            newRowIndex = Math.max(0, rowCount - 1);

            if (navigableColumnIds.length > 0) {
                newColumnId = navigableColumnIds[navigableColumnIds.length - 1] ?? columnId;
            }

            break;
        }
        case "ctrl+home": {
            newRowIndex = 0;

            if (navigableColumnIds.length > 0) {
                newColumnId = navigableColumnIds[0] ?? columnId;
            }

            break;
        }
        case "ctrl+up": {
            newRowIndex = 0;
            break;
        }
        case "down": {
            newRowIndex = Math.min(rowCount - 1, rowIndex + 1);
            break;
        }
        case "end": {
            if (navigableColumnIds.length > 0) {
                newColumnId = navigableColumnIds[navigableColumnIds.length - 1] ?? columnId;
            }

            break;
        }
        case "home": {
            if (navigableColumnIds.length > 0) {
                newColumnId = navigableColumnIds[0] ?? columnId;
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
        case "pagedown": {
            if (rowVirtualizer) {
                const visibleRange = rowVirtualizer.getVirtualItems();
                const pageSize = visibleRange.length ?? 10;

                newRowIndex = Math.min(rowCount - 1, rowIndex + pageSize);
            } else {
                newRowIndex = Math.min(rowCount - 1, rowIndex + 10);
            }

            break;
        }
        case "pageleft": {
            if (currentColIndex > 0) {
                const targetIndex = Math.max(0, currentColIndex - HORIZONTAL_PAGE_SIZE);
                const targetColumnId = navigableColumnIds[targetIndex];

                if (targetColumnId) newColumnId = targetColumnId;
            }

            break;
        }
        case "pageright": {
            if (currentColIndex < navigableColumnIds.length - 1) {
                const targetIndex = Math.min(navigableColumnIds.length - 1, currentColIndex + HORIZONTAL_PAGE_SIZE);
                const targetColumnId = navigableColumnIds[targetIndex];

                if (targetColumnId) newColumnId = targetColumnId;
            }

            break;
        }
        case "pageup": {
            if (rowVirtualizer) {
                const visibleRange = rowVirtualizer.getVirtualItems();
                const pageSize = visibleRange.length ?? 10;

                newRowIndex = Math.max(0, rowIndex - pageSize);
            } else {
                newRowIndex = Math.max(0, rowIndex - 10);
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
            newRowIndex = Math.max(0, rowIndex - 1);
            break;
        }
        default: {
            break;
        }
    }

    if (newRowIndex !== rowIndex || newColumnId !== columnId) {
        focusCell(newRowIndex, newColumnId);

        // Calculate and apply scrolls synchronously to avoid flashing
        const container = dataGridRef.current;

        if (!container) {
            return;
        }

        const targetRow = rowMapRef.current.get(newRowIndex);
        const cellKey = getCellKey(newRowIndex, newColumnId);
        const targetCell = cellMapRef.current.get(cellKey);

        // If target row is not rendered, scroll it into view first
        if (!targetRow) {
            if (rowVirtualizer) {
                const align = getScrollAlign(direction);

                rowVirtualizer.scrollToIndex(newRowIndex, { align });

                // Wait for row to render before horizontal scroll
                if (newColumnId !== columnId) {
                    requestAnimationFrame(() => {
                        const cellKeyRetry = getCellKey(newRowIndex, newColumnId);
                        const targetCellRetry = cellMapRef.current.get(cellKeyRetry);

                        if (targetCellRetry) {
                            const scrollDirection = getScrollDirection(direction);

                            scrollCellIntoView({
                                container,
                                direction: scrollDirection,
                                isRtl: textDirection === "rtl",
                                tableRef,
                                targetCell: targetCellRetry,
                                viewportOffset: VIEWPORT_OFFSET,
                            });
                        }
                    });
                }
            } else {
                // Fallback: use direct scroll calculation when virtualizer is not available
                const fallbackRowHeightValue = getRowHeightValue(rowHeight);
                const estimatedScrollTop = newRowIndex * fallbackRowHeightValue;

                container.scrollTop = estimatedScrollTop;
            }

            return;
        }

        // Vertical scrolling for rendered rows that changed
        if (newRowIndex !== rowIndex && targetRow) {
            requestAnimationFrame(() => {
                const containerRect = container.getBoundingClientRect();
                const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0;
                const footerHeight = footerRef.current?.getBoundingClientRect().height ?? 0;
                const viewportTop = containerRect.top + headerHeight + VIEWPORT_OFFSET;
                const viewportBottom = containerRect.bottom - footerHeight - VIEWPORT_OFFSET;

                const rowRect = targetRow.getBoundingClientRect();
                const isFullyVisible = rowRect.top >= viewportTop && rowRect.bottom <= viewportBottom;

                if (!isFullyVisible) {
                    // Only apply vertical scroll for vertical navigation
                    const isVerticalNavigation = VERTICAL_NAVIGATION_DIRECTIONS.has(direction);

                    if (isVerticalNavigation) {
                        if (SCROLL_ALIGN_END_DIRECTIONS.has(direction)) {
                            container.scrollTop += rowRect.bottom - viewportBottom;
                        } else {
                            container.scrollTop -= viewportTop - rowRect.top;
                        }
                    }
                }
            });
        }

        // Horizontal scrolling for rendered cells
        if (newColumnId !== columnId && targetCell) {
            requestAnimationFrame(() => {
                const scrollDirection = getScrollDirection(direction);

                scrollCellIntoView({
                    container,
                    direction: scrollDirection,
                    isRtl: textDirection === "rtl",
                    tableRef,
                    targetCell,
                    viewportOffset: VIEWPORT_OFFSET,
                });
            });
        }
    }
};
