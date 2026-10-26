import type { DataGridCellMapRef, DataGridElementRef, DataGridStore } from "@ui/hooks/data-grid/types";
import { getCellKey, getIsInPopover } from "@ui/lib/data-grid";
import type * as React from "react";

export interface FocusOutRestoreContext {
    cellMapRef: DataGridCellMapRef;
    dataGridRef: DataGridElementRef;
    focusGuardRef: React.RefObject<boolean>;
    store: DataGridStore;
}

/** Pulls focus back into the grid when a virtualized cell unmounts under it. Returns the cleanup. */
export const restoreFocusOnFocusOut = (context: FocusOutRestoreContext): (() => void) | undefined => {
    const { cellMapRef, dataGridRef, focusGuardRef, store } = context;

    const container = dataGridRef.current;

    if (!container) {
        return undefined;
    }

    const onFocusOut = (event: FocusEvent) => {
        if (focusGuardRef.current) {
            return;
        }

        const currentContainer = dataGridRef.current;

        if (!currentContainer) {
            return;
        }

        const currentState = store.getState();

        if (!currentState.focusedCell || currentState.editingCell) {
            return;
        }

        const { relatedTarget } = event;

        const isFocusMovingOutsideGrid = !relatedTarget || !currentContainer.contains(relatedTarget as Node);

        const isFocusMovingToPopover = getIsInPopover(relatedTarget);

        if (isFocusMovingOutsideGrid && !isFocusMovingToPopover) {
            const { columnId, rowIndex } = currentState.focusedCell;
            const cellKey = getCellKey(rowIndex, columnId);
            const cellElement = cellMapRef.current.get(cellKey);

            requestAnimationFrame(() => {
                if (focusGuardRef.current) {
                    return;
                }

                if (cellElement && document.body.contains(cellElement)) {
                    cellElement.focus();
                } else {
                    currentContainer.focus();
                }
            });
        }
    };

    container.addEventListener("focusout", onFocusOut);

    return () => {
        container.removeEventListener("focusout", onFocusOut);
    };
};

export interface OutsideClickContext {
    blurCell: () => void;
    dataGridRef: DataGridElementRef;
    onSelectionClear: () => void;
    store: DataGridStore;
}

/** Blurs the focused cell and clears the selection on a mousedown outside the grid. Returns the cleanup. */
export const clearOnOutsideClick = (context: OutsideClickContext): (() => void) => {
    const { blurCell, dataGridRef, onSelectionClear, store } = context;

    const onOutsideClick = (event: MouseEvent) => {
        if (event.button === 2) {
            return;
        }

        if (dataGridRef.current && !dataGridRef.current.contains(event.target as Node)) {
            const elements = document.elementsFromPoint(event.clientX, event.clientY);

            // Compensate for event.target bubbling up
            const isInsidePopover = elements.some((element) => getIsInPopover(element));

            if (!isInsidePopover) {
                blurCell();
                const currentState = store.getState();

                if (currentState.selectionState.selectedCells.size > 0 || Object.keys(currentState.rowSelection).length > 0) {
                    onSelectionClear();
                }
            }
        }
    };

    document.addEventListener("mousedown", onOutsideClick);

    return () => {
        document.removeEventListener("mousedown", onOutsideClick);
    };
};

/** Suppresses text selection and the native context menu while a cell drag-selection runs. Returns the cleanup. */
export const suppressNativeSelectionWhileSelecting = (store: DataGridStore): (() => void) => {
    const onSelectStart = (event: Event) => {
        event.preventDefault();
    };

    const onContextMenu = (event: Event) => {
        event.preventDefault();
    };

    const onCleanup = () => {
        document.removeEventListener("selectstart", onSelectStart);
        document.removeEventListener("contextmenu", onContextMenu);
        document.body.style.userSelect = "";
    };

    const onUnsubscribe = store.subscribe(() => {
        const currentState = store.getState();

        if (currentState.selectionState.isSelecting) {
            document.addEventListener("selectstart", onSelectStart);
            document.addEventListener("contextmenu", onContextMenu);
            document.body.style.userSelect = "none";
        } else {
            onCleanup();
        }
    });

    return () => {
        onCleanup();
        onUnsubscribe();
    };
};
