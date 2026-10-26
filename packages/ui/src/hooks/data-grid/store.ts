import type { RowData } from "@tanstack/react-table";
import type { DataGridState, DataGridStore, UseDataGridProps } from "@ui/hooks/data-grid/types";
import type { RowHeightValue } from "@ui/types/data-grid";
import * as React from "react";

export const createInitialDataGridState = <TData extends RowData>(
    initialState: UseDataGridProps<TData>["initialState"],
    rowHeightProp: RowHeightValue,
): DataGridState => {
    return {
        columnFilters: initialState?.columnFilters ?? [],
        contextMenu: {
            open: false,
            x: 0,
            y: 0,
        },
        cutCells: new Set(),
        editingCell: null,
        focusedCell: null,
        lastClickedRowIndex: null,
        matchIndex: -1,
        pasteDialog: {
            clipboardText: "",
            open: false,
            rowsNeeded: 0,
        },
        rowHeight: rowHeightProp,
        rowSelection: initialState?.rowSelection ?? {},
        searchMatches: [],
        searchOpen: false,
        searchQuery: "",
        selectionState: {
            isSelecting: false,
            selectedCells: new Set(),
            selectionRange: null,
        },
        sorting: initialState?.sorting ?? [],
    };
};

export const createDataGridStore = (stateRef: React.RefObject<DataGridState>, listenersRef: React.RefObject<Set<() => void>>): DataGridStore => {
    let isBatching = false;
    let pendingNotification = false;

    const store: DataGridStore = {
        batch: (function_) => {
            if (isBatching) {
                function_();

                return;
            }

            isBatching = true;
            const wasPending = pendingNotification;

            pendingNotification = false;

            try {
                function_();
            } finally {
                isBatching = false;

                if (pendingNotification || wasPending) {
                    pendingNotification = false;
                    store.notify();
                }
            }
        },
        getState: () => stateRef.current,
        notify: () => {
            for (const listener of listenersRef.current) {
                listener();
            }
        },
        setState: (key, value) => {
            if (Object.is(stateRef.current[key], value)) {
                return;
            }

            stateRef.current[key] = value;

            if (isBatching) {
                pendingNotification = true;
            } else if (!pendingNotification) {
                pendingNotification = true;
                queueMicrotask(() => {
                    pendingNotification = false;
                    store.notify();
                });
            }
        },
        subscribe: (callback) => {
            listenersRef.current.add(callback);

            return () => listenersRef.current.delete(callback);
        },
    };

    return store;
};

export const useStore = <T>(store: DataGridStore, selector: (state: DataGridState) => T): T => {
    const getSnapshot = React.useCallback(() => selector(store.getState()), [store, selector]);

    return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
};
