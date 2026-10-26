import type { RowData } from "@tanstack/react-table";
import { NON_NAVIGABLE_COLUMN_IDS, SCROLL_SYNC_RETRY_COUNT, VIEWPORT_OFFSET } from "@ui/hooks/data-grid/constants";
import type {
    DataGridCellMapRef,
    DataGridElementRef,
    DataGridPropsRef,
    DataGridRowMapRef,
    DataGridRowVirtualizer,
    DataGridStore,
} from "@ui/hooks/data-grid/types";
import { getCellKey } from "@ui/lib/data-grid";
import type { CellPosition } from "@ui/types/data-grid";
import type * as React from "react";

export interface ScrollToRowContext<TData extends RowData> {
    cellMapRef: DataGridCellMapRef;
    dataGridRef: DataGridElementRef;
    focusGuardRef: React.RefObject<boolean>;
    footerRef: DataGridElementRef;
    headerRef: DataGridElementRef;
    propsRef: DataGridPropsRef<TData>;
    releaseFocusGuard: (immediate?: boolean) => void;
    rowMapRef: DataGridRowMapRef;
    rowVirtualizer: DataGridRowVirtualizer;
    store: DataGridStore;
}

export const scrollToRowAndFocus = async <TData extends RowData>(options: Partial<CellPosition>, context: ScrollToRowContext<TData>): Promise<void> => {
    const { cellMapRef, dataGridRef, focusGuardRef, footerRef, headerRef, propsRef, releaseFocusGuard, rowMapRef, rowVirtualizer, store } = context;

    const rowIndex = options?.rowIndex ?? 0;
    const columnId = options?.columnId;

    focusGuardRef.current = true;

    const navigableId = propsRef.current.columns
        .map((c) => {
            if (c.id) {
                return c.id;
            }

            if ("accessorKey" in c) {
                return c.accessorKey as string;
            }

            return undefined;
        })
        .filter((id): id is string => Boolean(id))
        .find((c) => !NON_NAVIGABLE_COLUMN_IDS.has(c));

    const targetColumnId = columnId ?? navigableId;

    if (!targetColumnId) {
        releaseFocusGuard(true);

        return;
    }

    const onScrollAndFocus = async (retryCount: number) => {
        if (!targetColumnId) {
            return;
        }

        const currentRowCount = propsRef.current.data.length;

        // If the requested row doesn't exist yet, wait for data to update
        if (rowIndex >= currentRowCount && retryCount > 0) {
            await new Promise((resolve) => {
                setTimeout(resolve, 50);
            });
            await onScrollAndFocus(retryCount - 1);

            return;
        }

        const safeRowIndex = Math.min(rowIndex, Math.max(0, currentRowCount - 1));

        const isBottomHalf = safeRowIndex > currentRowCount / 2;

        rowVirtualizer.scrollToIndex(safeRowIndex, {
            align: isBottomHalf ? "end" : "start",
        });

        await new Promise((resolve) => {
            requestAnimationFrame(resolve);
        });

        // Adjust scroll position to account for sticky header/footer
        const container = dataGridRef.current;
        const targetRow = rowMapRef.current.get(safeRowIndex);

        if (container && targetRow) {
            const containerRect = container.getBoundingClientRect();
            const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0;
            const footerHeight = footerRef.current?.getBoundingClientRect().height ?? 0;

            const viewportTop = containerRect.top + headerHeight + VIEWPORT_OFFSET;
            const viewportBottom = containerRect.bottom - footerHeight - VIEWPORT_OFFSET;

            const rowRect = targetRow.getBoundingClientRect();
            const isFullyVisible = rowRect.top >= viewportTop && rowRect.bottom <= viewportBottom;

            if (!isFullyVisible) {
                if (rowRect.top < viewportTop) {
                    // Row is partially hidden by header - scroll up
                    container.scrollTop -= viewportTop - rowRect.top;
                } else if (rowRect.bottom > viewportBottom) {
                    // Row is partially hidden by footer - scroll down
                    container.scrollTop += rowRect.bottom - viewportBottom;
                }
            }
        }

        store.batch(() => {
            store.setState("focusedCell", {
                columnId: targetColumnId,
                rowIndex: safeRowIndex,
            });
            store.setState("editingCell", null);
        });

        const cellKey = getCellKey(safeRowIndex, targetColumnId);
        const cellElement = cellMapRef.current.get(cellKey);

        if (cellElement) {
            cellElement.focus();
            releaseFocusGuard();
        } else if (retryCount > 0) {
            await new Promise((resolve) => {
                requestAnimationFrame(resolve);
            });
            await onScrollAndFocus(retryCount - 1);
        } else {
            dataGridRef.current?.focus();
            releaseFocusGuard();
        }
    };

    await onScrollAndFocus(SCROLL_SYNC_RETRY_COUNT);
};
