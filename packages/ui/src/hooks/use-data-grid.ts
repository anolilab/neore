"use client";

import { useDirection } from "@base-ui/react/direction-provider";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type {
    ColumnDef,
    ColumnFiltersState,
    RowData,
    RowSelectionState,
    SortingState,
    TableMeta,
    TableOptions,
    TableState,
    Updater,
} from "@tanstack/react-table";
import { functionalUpdate, useTable } from "@tanstack/react-table";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getClipboardSelection, getEmptyCellUpdates, parsePastedValue } from "@ui/hooks/data-grid/clipboard";
import { DEFAULT_ROW_HEIGHT, MAX_COLUMN_SIZE, MIN_COLUMN_SIZE, NON_NAVIGABLE_COLUMN_IDS, OVERSCAN } from "@ui/hooks/data-grid/constants";
import { clearOnOutsideClick, restoreFocusOnFocusOut, suppressNativeSelectionWhileSelecting } from "@ui/hooks/data-grid/effects";
import { handleDataGridKeyDown, handleGlobalKeyDown } from "@ui/hooks/data-grid/keyboard";
import { navigateToCell } from "@ui/hooks/data-grid/navigation";
import { handleCellClick } from "@ui/hooks/data-grid/pointer";
import { scrollToRowAndFocus } from "@ui/hooks/data-grid/scroll";
import { findSearchMatches } from "@ui/hooks/data-grid/search";
import { createDataGridStore, createInitialDataGridState, useStore } from "@ui/hooks/data-grid/store";
import type { DataGridState, DataGridStore, UseDataGridProps } from "@ui/hooks/data-grid/types";
import { useAsRef } from "@ui/hooks/use-as-ref";
import { useIsomorphicLayoutEffect } from "@ui/hooks/use-isomorphic-layout-effect";
import { useLazyRef } from "@ui/hooks/use-lazy-ref";
import { getCellKey, getRowHeightValue, parseCellKey } from "@ui/lib/data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import { dataGridFeatures } from "@ui/lib/data-grid-features";
import type { CellPosition, NavigationDirection, RowHeightValue, SearchState, UpdateCell } from "@ui/types/data-grid";
import * as React from "react";
import { toast } from "sonner";

const useDataGrid = <TData extends RowData>({
    columns,
    data,
    dir: textDirectionProp,
    initialState,
    overscan = OVERSCAN,
    rowHeight: rowHeightProp = DEFAULT_ROW_HEIGHT,
    ...props
}: UseDataGridProps<TData>) => {
    const { t } = useLingui();
    const textDirectionFromProvider = useDirection();
    const textDirection = textDirectionProp ?? textDirectionFromProvider;
    const dataGridRef = React.useRef<HTMLDivElement>(null);
    const tableRef = React.useRef<ReturnType<typeof useTable<DataGridFeatures, TData>>>(null);
    const rowVirtualizerRef = React.useRef<Virtualizer<HTMLDivElement, Element>>(null);
    const headerRef = React.useRef<HTMLDivElement>(null);
    const rowMapRef = React.useRef<Map<number, HTMLDivElement>>(new Map());
    const cellMapRef = React.useRef<Map<string, HTMLDivElement>>(new Map());
    const footerRef = React.useRef<HTMLDivElement>(null);
    const focusGuardRef = React.useRef(false);

    const propsRef = useAsRef({
        ...props,
        columns,
        data,
        initialState,
    });

    const listenersRef = useLazyRef(() => new Set<() => void>());

    const stateRef = useLazyRef<DataGridState>(() => createInitialDataGridState(initialState, rowHeightProp));

    const store = React.useMemo<DataGridStore>(() => createDataGridStore(stateRef, listenersRef), [listenersRef, stateRef]);

    const focusedCell = useStore(store, (state) => state.focusedCell);
    const editingCell = useStore(store, (state) => state.editingCell);
    const selectionState = useStore(store, (state) => state.selectionState);
    const searchQuery = useStore(store, (state) => state.searchQuery);
    const searchMatches = useStore(store, (state) => state.searchMatches);
    const matchIndex = useStore(store, (state) => state.matchIndex);
    const searchOpen = useStore(store, (state) => state.searchOpen);
    const sorting = useStore(store, (state) => state.sorting);
    const columnFilters = useStore(store, (state) => state.columnFilters);
    const rowSelection = useStore(store, (state) => state.rowSelection);
    const rowHeight = useStore(store, (state) => state.rowHeight);
    const contextMenu = useStore(store, (state) => state.contextMenu);
    const pasteDialog = useStore(store, (state) => state.pasteDialog);

    const rowHeightValue = getRowHeightValue(rowHeight);

    const prevCellSelectionMapRef = useLazyRef(() => new Map<number, Set<string>>());

    // Memoize per-row selection sets to prevent unnecessary row re-renders
    // Each row gets a stable Set reference that only changes when its cells' selection changes
    const cellSelectionMap = React.useMemo(() => {
        const { selectedCells } = selectionState;

        if (selectedCells.size === 0) {
            prevCellSelectionMapRef.current.clear();

            return null;
        }

        const newRowCells = new Map<number, Set<string>>();

        for (const cellKey of selectedCells) {
            const { rowIndex } = parseCellKey(cellKey);
            let rowSet = newRowCells.get(rowIndex);

            if (!rowSet) {
                rowSet = new Set<string>();
                newRowCells.set(rowIndex, rowSet);
            }

            rowSet.add(cellKey);
        }

        const stableMap = new Map<number, Set<string>>();

        for (const [rowIndex, newSet] of newRowCells) {
            const prevSet = prevCellSelectionMapRef.current.get(rowIndex);

            if (prevSet && prevSet.size === newSet.size && [...newSet].every((key) => prevSet.has(key))) {
                stableMap.set(rowIndex, prevSet);
            } else {
                stableMap.set(rowIndex, newSet);
            }
        }

        prevCellSelectionMapRef.current = stableMap;

        return stableMap;
    }, [selectionState.selectedCells, prevCellSelectionMapRef]);

    const columnIds = React.useMemo(
        () =>
            columns
                .map((c) => {
                    if (c.id) {
                        return c.id;
                    }

                    if ("accessorKey" in c) {
                        return c.accessorKey as string;
                    }

                    return undefined;
                })
                .filter((id): id is string => Boolean(id)),
        [columns],
    );

    const navigableColumnIds = React.useMemo(() => columnIds.filter((c) => !NON_NAVIGABLE_COLUMN_IDS.has(c)), [columnIds]);

    const onDataUpdate = React.useCallback(
        (updates: UpdateCell | UpdateCell[]) => {
            if (propsRef.current.readOnly) {
                return;
            }

            const updateArray = Array.isArray(updates) ? updates : [updates];

            if (updateArray.length === 0) {
                return;
            }

            const currentTable = tableRef.current;
            const currentData = propsRef.current.data;
            const rows = currentTable?.getRowModel().rows;

            const rowUpdatesMap = new Map<number, Omit<UpdateCell, "rowIndex">[]>();

            for (const update of updateArray) {
                if (!rows || !currentTable) {
                    const existingUpdates = rowUpdatesMap.get(update.rowIndex) ?? [];

                    existingUpdates.push({
                        columnId: update.columnId,
                        value: update.value,
                    });
                    rowUpdatesMap.set(update.rowIndex, existingUpdates);
                } else {
                    const row = rows[update.rowIndex];

                    if (!row) {
                        continue;
                    }

                    const originalData = row.original;
                    const originalRowIndex = currentData.indexOf(originalData);

                    const targetIndex = originalRowIndex === -1 ? update.rowIndex : originalRowIndex;

                    const existingUpdates = rowUpdatesMap.get(targetIndex) ?? [];

                    existingUpdates.push({
                        columnId: update.columnId,
                        value: update.value,
                    });
                    rowUpdatesMap.set(targetIndex, existingUpdates);
                }
            }

            const tableRowCount = rows?.length ?? currentData.length;
            const newData: TData[] = [];

            for (let i = 0; i < tableRowCount; i++) {
                const rowUpdates = rowUpdatesMap.get(i);
                const existingRow = currentData[i];
                const tableRow = rows?.[i];

                if (rowUpdates) {
                    const baseRow = existingRow ?? tableRow?.original ?? ({} as TData);
                    const updatedRow = { ...baseRow } as Record<string, unknown>;

                    for (const { columnId, value } of rowUpdates) {
                        updatedRow[columnId] = value;
                    }

                    newData[i] = updatedRow as TData;
                } else {
                    newData[i] = existingRow ?? tableRow?.original ?? ({} as TData);
                }
            }

            propsRef.current.onDataChange?.(newData);
        },
        [propsRef],
    );

    const getIsCellSelected = React.useCallback(
        (rowIndex: number, columnId: string) => {
            const currentSelectionState = store.getState().selectionState;

            return currentSelectionState.selectedCells.has(getCellKey(rowIndex, columnId));
        },
        [store],
    );

    const onSelectionClear = React.useCallback(() => {
        store.batch(() => {
            store.setState("selectionState", {
                isSelecting: false,
                selectedCells: new Set(),
                selectionRange: null,
            });
            store.setState("rowSelection", {});
        });
    }, [store]);

    const selectAll = React.useCallback(() => {
        const allCells = new Set<string>();
        const currentTable = tableRef.current;
        const rows = currentTable?.getRowModel().rows ?? [];
        const rowCount = rows.length ?? propsRef.current.data.length;

        for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
            for (const columnId of columnIds) {
                allCells.add(getCellKey(rowIndex, columnId));
            }
        }

        const firstColumnId = columnIds[0];
        const lastColumnId = columnIds[columnIds.length - 1];

        store.setState("selectionState", {
            isSelecting: false,
            selectedCells: allCells,
            selectionRange:
                columnIds.length > 0 && rowCount > 0 && firstColumnId && lastColumnId
                    ? {
                          end: { columnId: lastColumnId, rowIndex: rowCount - 1 },
                          start: { columnId: firstColumnId, rowIndex: 0 },
                      }
                    : null,
        });
    }, [columnIds, propsRef, store]);

    const selectColumn = React.useCallback(
        (columnId: string) => {
            const currentTable = tableRef.current;
            const rows = currentTable?.getRowModel().rows ?? [];
            const rowCount = rows.length ?? propsRef.current.data.length;

            if (rowCount === 0) {
                return;
            }

            const selectedCells = new Set<string>();

            for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
                selectedCells.add(getCellKey(rowIndex, columnId));
            }

            store.setState("selectionState", {
                isSelecting: false,
                selectedCells,
                selectionRange: {
                    end: { columnId, rowIndex: rowCount - 1 },
                    start: { columnId, rowIndex: 0 },
                },
            });
        },
        [propsRef, store],
    );

    const selectRange = React.useCallback(
        (start: CellPosition, end: CellPosition, isSelecting = false) => {
            const startColIndex = columnIds.indexOf(start.columnId);
            const endColIndex = columnIds.indexOf(end.columnId);

            const minRow = Math.min(start.rowIndex, end.rowIndex);
            const maxRow = Math.max(start.rowIndex, end.rowIndex);
            const minCol = Math.min(startColIndex, endColIndex);
            const maxCol = Math.max(startColIndex, endColIndex);

            const selectedCells = new Set<string>();

            for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex++) {
                for (let colIndex = minCol; colIndex <= maxCol; colIndex++) {
                    const columnId = columnIds[colIndex];

                    if (columnId) {
                        selectedCells.add(getCellKey(rowIndex, columnId));
                    }
                }
            }

            store.setState("selectionState", {
                isSelecting,
                selectedCells,
                selectionRange: { end, start },
            });
        },
        [columnIds, store],
    );

    const onCellsCopy = React.useCallback(async () => {
        const clipboardSelection = getClipboardSelection(store, tableRef);

        if (!clipboardSelection) {
            return;
        }

        const { selectedCellsArray, tsvData } = clipboardSelection;

        try {
            await navigator.clipboard.writeText(tsvData);

            const stateAfterCopy = store.getState();

            if (stateAfterCopy.cutCells.size > 0) {
                store.setState("cutCells", new Set());
            }

            const count = selectedCellsArray.length;

            // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
            toast.success(t`${plural(count, { one: "# cell copied", other: "# cells copied" })}`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t`Failed to copy to clipboard`);
        }
    }, [store, t]);

    const onCellsCut = React.useCallback(async () => {
        if (propsRef.current.readOnly) {
            return;
        }

        const clipboardSelection = getClipboardSelection(store, tableRef);

        if (!clipboardSelection) {
            return;
        }

        const { selectedCellsArray, tsvData } = clipboardSelection;

        try {
            await navigator.clipboard.writeText(tsvData);

            store.setState("cutCells", new Set(selectedCellsArray));

            const count = selectedCellsArray.length;

            // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
            toast.success(t`${plural(count, { one: "# cell cut", other: "# cells cut" })}`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t`Failed to cut to clipboard`);
        }
    }, [store, propsRef, t]);

    const restoreFocus = React.useCallback((element: HTMLDivElement | null) => {
        if (element && document.activeElement !== element) {
            requestAnimationFrame(() => {
                element.focus();
            });
        }
    }, []);

    const onCellsPaste = React.useCallback(
        async (expandRows = false) => {
            if (propsRef.current.readOnly) {
                return;
            }

            const currentState = store.getState();

            if (!currentState.focusedCell) {
                return;
            }

            const currentTable = tableRef.current;
            const rows = currentTable?.getRowModel().rows;

            if (!rows) {
                return;
            }

            try {
                let { clipboardText } = currentState.pasteDialog;

                if (!clipboardText) {
                    clipboardText = await navigator.clipboard.readText();

                    if (!clipboardText) {
                        return;
                    }
                }

                const pastedRows = clipboardText.split("\n").filter((row) => row.length > 0);
                const pastedData = pastedRows.map((row) => row.split("\t"));

                const startRowIndex = currentState.focusedCell.rowIndex;
                const startColIndex = navigableColumnIds.indexOf(currentState.focusedCell.columnId);

                if (startColIndex === -1) {
                    return;
                }

                const rowCount = rows.length ?? propsRef.current.data.length;
                const rowsNeeded = startRowIndex + pastedData.length - rowCount;

                if (rowsNeeded > 0 && !expandRows && propsRef.current.onRowAdd && !currentState.pasteDialog.clipboardText) {
                    store.setState("pasteDialog", {
                        clipboardText,
                        open: true,
                        rowsNeeded,
                    });

                    return;
                }

                if (expandRows && rowsNeeded > 0) {
                    const expectedRowCount = rowCount + rowsNeeded;

                    if (propsRef.current.onRowsAdd) {
                        await propsRef.current.onRowsAdd(rowsNeeded);
                    } else if (propsRef.current.onRowAdd) {
                        for (let i = 0; i < rowsNeeded; i++) {
                            await propsRef.current.onRowAdd();
                        }
                    }

                    let attempts = 0;
                    const maxAttempts = 50;
                    let currentTableRowCount = tableRef.current?.getRowModel().rows.length ?? 0;

                    while (currentTableRowCount < expectedRowCount && attempts < maxAttempts) {
                        await new Promise((resolve) => {
                            setTimeout(resolve, 100);
                        });
                        currentTableRowCount = tableRef.current?.getRowModel().rows.length ?? 0;
                        attempts++;
                    }
                }

                const updates: UpdateCell[] = [];
                const tableColumns = currentTable?.getAllColumns() ?? [];
                let cellsUpdated = 0;
                let endRowIndex = startRowIndex;
                let endColIndex = startColIndex;

                const updatedTable = tableRef.current;
                const updatedRows = updatedTable?.getRowModel().rows;
                const currentRowCount = updatedRows?.length ?? 0;

                let cellsSkipped = 0;

                const columnMap = new Map(tableColumns.map((c) => [c.id, c]));

                for (const [pasteRowIndex, pasteRow] of pastedData.entries()) {
                    if (!pasteRow) {
                        continue;
                    }

                    const targetRowIndex = startRowIndex + pasteRowIndex;

                    if (targetRowIndex >= currentRowCount) {
                        break;
                    }

                    for (const [pasteColIndex, element] of pasteRow.entries()) {
                        const targetColIndex = startColIndex + pasteColIndex;

                        if (targetColIndex >= navigableColumnIds.length) {
                            break;
                        }

                        const targetColumnId = navigableColumnIds[targetColIndex];

                        if (!targetColumnId) {
                            continue;
                        }

                        const pastedValue = element ?? "";
                        const column = columnMap.get(targetColumnId);
                        const cellOptions = column?.columnDef?.meta?.cell;

                        const { processedValue, shouldSkip } = parsePastedValue(pastedValue, cellOptions);

                        if (shouldSkip) {
                            cellsSkipped++;
                            endRowIndex = Math.max(endRowIndex, targetRowIndex);
                            endColIndex = Math.max(endColIndex, targetColIndex);
                            continue;
                        }

                        updates.push({
                            columnId: targetColumnId,
                            rowIndex: targetRowIndex,
                            value: processedValue,
                        });
                        cellsUpdated++;

                        endRowIndex = Math.max(endRowIndex, targetRowIndex);
                        endColIndex = Math.max(endColIndex, targetColIndex);
                    }
                }

                if (updates.length > 0) {
                    if (propsRef.current.onPaste) {
                        await propsRef.current.onPaste(updates);
                    }

                    const allUpdates = [...updates];

                    if (currentState.cutCells.size > 0) {
                        for (const update of getEmptyCellUpdates(currentState.cutCells, tableColumns)) {
                            allUpdates.push(update);
                        }

                        store.setState("cutCells", new Set());
                    }

                    onDataUpdate(allUpdates);

                    if (cellsSkipped > 0) {
                        toast.success(
                            // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
                            t`${plural(cellsUpdated, { one: `# cell pasted, ${cellsSkipped} skipped`, other: `# cells pasted, ${cellsSkipped} skipped` })}`,
                        );
                    } else {
                        // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
                        toast.success(t`${plural(cellsUpdated, { one: "# cell pasted", other: "# cells pasted" })}`);
                    }

                    const endColumnId = navigableColumnIds[endColIndex];

                    if (endColumnId) {
                        selectRange(
                            {
                                columnId: currentState.focusedCell.columnId,
                                rowIndex: startRowIndex,
                            },
                            { columnId: endColumnId, rowIndex: endRowIndex },
                        );
                    }

                    restoreFocus(dataGridRef.current);
                } else if (cellsSkipped > 0) {
                    toast.error(
                        // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
                        t`${plural(cellsSkipped, { one: "# cell skipped pasting for invalid data", other: "# cells skipped pasting for invalid data" })}`,
                    );
                }

                if (currentState.pasteDialog.open) {
                    store.setState("pasteDialog", {
                        clipboardText: "",
                        open: false,
                        rowsNeeded: 0,
                    });
                }
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t`Failed to paste. Please try again.`);
            }
        },
        [store, navigableColumnIds, propsRef, onDataUpdate, selectRange, restoreFocus, t],
    );

    // Release focus guard after delay to allow async data re-renders to settle.
    // 300ms accounts for db sync and virtualized cell mounting.
    const releaseFocusGuard = React.useCallback((immediate = false) => {
        if (immediate) {
            focusGuardRef.current = false;

            return;
        }

        setTimeout(() => {
            focusGuardRef.current = false;
        }, 300);
    }, []);

    const focusCellWrapper = React.useCallback(
        (rowIndex: number, columnId: string) => {
            focusGuardRef.current = true;

            requestAnimationFrame(() => {
                const cellKey = getCellKey(rowIndex, columnId);
                const cellWrapperElement = cellMapRef.current.get(cellKey);

                if (!cellWrapperElement) {
                    const container = dataGridRef.current;

                    if (container) {
                        container.focus();
                    }

                    releaseFocusGuard();

                    return;
                }

                cellWrapperElement.focus();
                releaseFocusGuard();
            });
        },
        [releaseFocusGuard],
    );

    const focusCell = React.useCallback(
        (rowIndex: number, columnId: string) => {
            store.batch(() => {
                store.setState("focusedCell", { columnId, rowIndex });
                store.setState("editingCell", null);
            });

            const currentState = store.getState();

            if (currentState.searchOpen) {
                return;
            }

            focusCellWrapper(rowIndex, columnId);
        },
        [store, focusCellWrapper],
    );

    const onRowsDelete = React.useCallback(
        async (rowIndices: number[]) => {
            if (propsRef.current.readOnly || !propsRef.current.onRowsDelete || rowIndices.length === 0) {
                return;
            }

            const currentTable = tableRef.current;
            const rows = currentTable?.getRowModel().rows;

            if (!rows || rows.length === 0) {
                return;
            }

            const currentState = store.getState();
            const currentFocusedColumn = currentState.focusedCell?.columnId ?? navigableColumnIds[0];

            const minDeletedRowIndex = Math.min(...rowIndices);

            const rowsToDelete: TData[] = [];

            for (const rowIndex of rowIndices) {
                const row = rows[rowIndex];

                if (row) {
                    rowsToDelete.push(row.original);
                }
            }

            await propsRef.current.onRowsDelete(rowsToDelete, rowIndices);

            store.batch(() => {
                store.setState("selectionState", {
                    isSelecting: false,
                    selectedCells: new Set(),
                    selectionRange: null,
                });
                store.setState("rowSelection", {});
                store.setState("editingCell", null);
            });

            requestAnimationFrame(() => {
                const tableAfterDelete = tableRef.current;
                const currentRows = tableAfterDelete?.getRowModel().rows ?? [];
                const newRowCount = currentRows.length ?? propsRef.current.data.length;

                if (newRowCount > 0 && currentFocusedColumn) {
                    const targetRowIndex = Math.min(minDeletedRowIndex, newRowCount - 1);

                    focusCell(targetRowIndex, currentFocusedColumn);
                }
            });
        },
        [propsRef, store, navigableColumnIds, focusCell],
    );

    const navigateCell = React.useCallback(
        (direction: NavigationDirection) => {
            navigateToCell(direction, {
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
            });
        },
        [textDirection, store, navigableColumnIds, focusCell, propsRef, rowHeight],
    );

    const onCellEditingStart = React.useCallback(
        (rowIndex: number, columnId: string) => {
            if (propsRef.current.readOnly) {
                return;
            }

            store.batch(() => {
                store.setState("focusedCell", { columnId, rowIndex });
                store.setState("editingCell", { columnId, rowIndex });
            });
        },
        [store, propsRef],
    );

    const onCellEditingStop = React.useCallback(
        (options?: { direction?: NavigationDirection; moveToNextRow?: boolean }) => {
            const currentState = store.getState();
            const currentEditing = currentState.editingCell;

            store.setState("editingCell", null);

            if (options?.moveToNextRow && currentEditing) {
                const { columnId, rowIndex } = currentEditing;
                const currentTable = tableRef.current;
                const rows = currentTable?.getRowModel().rows ?? [];
                const rowCount = rows.length ?? propsRef.current.data.length;

                const nextRowIndex = rowIndex + 1;

                if (nextRowIndex < rowCount) {
                    requestAnimationFrame(() => {
                        focusCell(nextRowIndex, columnId);
                    });
                }
            } else if (options?.direction && currentEditing) {
                const { columnId, rowIndex } = currentEditing;

                focusCell(rowIndex, columnId);
                requestAnimationFrame(() => {
                    navigateCell(options.direction ?? "right");
                });
            } else if (currentEditing) {
                const { columnId, rowIndex } = currentEditing;

                focusCellWrapper(rowIndex, columnId);
            }
        },
        [store, propsRef, focusCell, navigateCell, focusCellWrapper],
    );

    const onSearchOpenChange = React.useCallback(
        (open: boolean) => {
            if (open) {
                store.setState("searchOpen", true);

                return;
            }

            const currentState = store.getState();
            const currentMatch = currentState.matchIndex >= 0 && currentState.searchMatches[currentState.matchIndex];

            store.batch(() => {
                store.setState("searchOpen", false);
                store.setState("searchQuery", "");
                store.setState("searchMatches", []);
                store.setState("matchIndex", -1);

                if (currentMatch) {
                    store.setState("focusedCell", {
                        columnId: currentMatch.columnId,
                        rowIndex: currentMatch.rowIndex,
                    });
                }
            });

            if (dataGridRef.current && document.activeElement !== dataGridRef.current) {
                dataGridRef.current.focus();
            }
        },
        [store],
    );

    const onSearch = React.useCallback(
        (query: string) => {
            if (!query.trim()) {
                store.batch(() => {
                    store.setState("searchMatches", []);
                    store.setState("matchIndex", -1);
                });

                return;
            }

            const matches = findSearchMatches(query, tableRef, columnIds);

            store.batch(() => {
                store.setState("searchMatches", matches);
                store.setState("matchIndex", matches.length > 0 ? 0 : -1);
            });

            if (matches.length > 0 && matches[0]) {
                const firstMatch = matches[0];

                rowVirtualizerRef.current?.scrollToIndex(firstMatch.rowIndex, {
                    align: "center",
                });
            }
        },
        [columnIds, store],
    );

    const onSearchQueryChange = React.useCallback((query: string) => store.setState("searchQuery", query), [store]);

    const onNavigateToPrevMatch = React.useCallback(() => {
        const currentState = store.getState();

        if (currentState.searchMatches.length === 0) {
            return;
        }

        const prevIndex = (currentState.matchIndex < 1 ? currentState.searchMatches.length : currentState.matchIndex) - 1;
        const match = currentState.searchMatches[prevIndex];

        if (match) {
            rowVirtualizerRef.current?.scrollToIndex(match.rowIndex, {
                align: "center",
            });

            requestAnimationFrame(() => {
                store.setState("matchIndex", prevIndex);
                requestAnimationFrame(() => {
                    focusCell(match.rowIndex, match.columnId);
                });
            });
        }
    }, [store, focusCell]);

    const onNavigateToNextMatch = React.useCallback(() => {
        const currentState = store.getState();

        if (currentState.searchMatches.length === 0) {
            return;
        }

        const nextIndex = (currentState.matchIndex + 1) % currentState.searchMatches.length;
        const match = currentState.searchMatches[nextIndex];

        if (match) {
            rowVirtualizerRef.current?.scrollToIndex(match.rowIndex, {
                align: "center",
            });

            requestAnimationFrame(() => {
                store.setState("matchIndex", nextIndex);
                requestAnimationFrame(() => {
                    focusCell(match.rowIndex, match.columnId);
                });
            });
        }
    }, [store, focusCell]);

    const getIsSearchMatch = React.useCallback(
        (rowIndex: number, columnId: string) => {
            const currentSearchMatches = store.getState().searchMatches;

            return currentSearchMatches.some((match) => match.rowIndex === rowIndex && match.columnId === columnId);
        },
        [store],
    );

    const getIsActiveSearchMatch = React.useCallback(
        (rowIndex: number, columnId: string) => {
            const currentState = store.getState();

            if (currentState.matchIndex < 0) {
                return false;
            }

            const currentMatch = currentState.searchMatches[currentState.matchIndex];

            return currentMatch?.rowIndex === rowIndex && currentMatch?.columnId === columnId;
        },
        [store],
    );

    // Compute search match data for targeted row re-renders
    // Maps rowIndex -> Set of columnIds that have matches in that row
    const searchMatchesByRow = React.useMemo(() => {
        if (searchMatches.length === 0) {
            return null;
        }

        const rowMap = new Map<number, Set<string>>();

        for (const match of searchMatches) {
            let columnSet = rowMap.get(match.rowIndex);

            if (!columnSet) {
                columnSet = new Set<string>();
                rowMap.set(match.rowIndex, columnSet);
            }

            columnSet.add(match.columnId);
        }

        return rowMap;
    }, [searchMatches]);

    const activeSearchMatch = React.useMemo<CellPosition | null>(() => {
        if (matchIndex < 0 || searchMatches.length === 0) {
            return null;
        }

        return searchMatches[matchIndex] ?? null;
    }, [searchMatches, matchIndex]);

    const blurCell = React.useCallback(() => {
        const currentState = store.getState();

        if (currentState.editingCell && document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }

        store.batch(() => {
            store.setState("focusedCell", null);
            store.setState("editingCell", null);
        });
    }, [store]);

    const onCellClick = React.useCallback(
        (rowIndex: number, columnId: string, event?: React.MouseEvent) => {
            handleCellClick(rowIndex, columnId, event, {
                cellMapRef,
                dataGridRef,
                focusCell,
                onCellEditingStart,
                onSelectionClear,
                selectRange,
                store,
                tableRef,
                textDirection,
            });
        },
        [store, focusCell, onCellEditingStart, selectRange, onSelectionClear, textDirection],
    );

    const onCellDoubleClick = React.useCallback(
        (rowIndex: number, columnId: string, event?: React.MouseEvent) => {
            if (event?.defaultPrevented) {
                return;
            }

            onCellEditingStart(rowIndex, columnId);
        },
        [onCellEditingStart],
    );

    const onCellMouseDown = React.useCallback(
        (rowIndex: number, columnId: string, event: React.MouseEvent) => {
            if (event.button === 2) {
                return;
            }

            event.preventDefault();

            if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
                store.batch(() => {
                    store.setState("selectionState", {
                        isSelecting: true,
                        selectedCells: new Set(),
                        selectionRange: {
                            end: { columnId, rowIndex },
                            start: { columnId, rowIndex },
                        },
                    });
                    store.setState("rowSelection", {});
                });
            }
        },
        [store],
    );

    const onCellMouseEnter = React.useCallback(
        (rowIndex: number, columnId: string, _event: React.MouseEvent) => {
            const currentState = store.getState();

            if (currentState.selectionState.isSelecting && currentState.selectionState.selectionRange) {
                const { start } = currentState.selectionState.selectionRange;
                const end = { columnId, rowIndex };

                if (currentState.focusedCell?.rowIndex !== start.rowIndex || currentState.focusedCell?.columnId !== start.columnId) {
                    focusCell(start.rowIndex, start.columnId);
                }

                selectRange(start, end, true);
            }
        },
        [store, selectRange, focusCell],
    );

    const onCellMouseUp = React.useCallback(() => {
        const currentState = store.getState();

        store.setState("selectionState", {
            ...currentState.selectionState,
            isSelecting: false,
        });
    }, [store]);

    const onCellContextMenu = React.useCallback(
        (rowIndex: number, columnId: string, event: React.MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const currentState = store.getState();
            const cellKey = getCellKey(rowIndex, columnId);
            const isTargetCellSelected = currentState.selectionState.selectedCells.has(cellKey);

            if (!isTargetCellSelected) {
                store.batch(() => {
                    store.setState("selectionState", {
                        isSelecting: false,
                        selectedCells: new Set([cellKey]),
                        selectionRange: {
                            end: { columnId, rowIndex },
                            start: { columnId, rowIndex },
                        },
                    });
                    store.setState("focusedCell", { columnId, rowIndex });
                });
            }

            store.setState("contextMenu", {
                open: true,
                x: event.clientX,
                y: event.clientY,
            });
        },
        [store],
    );

    const onContextMenuOpenChange = React.useCallback(
        (open: boolean) => {
            if (open) {
                return;
            }

            const currentMenu = store.getState().contextMenu;

            store.setState("contextMenu", {
                open: false,
                x: currentMenu.x,
                y: currentMenu.y,
            });
        },
        [store],
    );

    const onSortingChange = React.useCallback(
        (updater: Updater<SortingState>) => {
            const currentState = store.getState();
            const newSorting = functionalUpdate(updater, currentState.sorting);

            store.setState("sorting", newSorting);

            propsRef.current.onSortingChange?.(newSorting);
        },
        [store, propsRef],
    );

    const onColumnFiltersChange = React.useCallback(
        (updater: Updater<ColumnFiltersState>) => {
            const currentState = store.getState();
            const newColumnFilters = functionalUpdate(updater, currentState.columnFilters);

            store.setState("columnFilters", newColumnFilters);

            propsRef.current.onColumnFiltersChange?.(newColumnFilters);
        },
        [store, propsRef],
    );

    const onRowSelectionChange = React.useCallback(
        (updater: Updater<RowSelectionState>) => {
            const currentState = store.getState();
            const newRowSelection = functionalUpdate(updater, currentState.rowSelection);

            const selectedRows = Object.keys(newRowSelection).filter((key) => newRowSelection[key]);

            const selectedCells = new Set<string>();
            const rows = tableRef.current?.getRowModel().rows ?? [];

            for (const rowId of selectedRows) {
                const rowIndex = rows.findIndex((r) => r.id === rowId);

                if (rowIndex === -1) {
                    continue;
                }

                for (const columnId of columnIds) {
                    selectedCells.add(getCellKey(rowIndex, columnId));
                }
            }

            store.batch(() => {
                store.setState("rowSelection", newRowSelection);
                store.setState("selectionState", {
                    isSelecting: false,
                    selectedCells,
                    selectionRange: null,
                });
                store.setState("focusedCell", null);
                store.setState("editingCell", null);
            });
        },
        [store, columnIds],
    );

    const onRowSelect = React.useCallback(
        (rowIndex: number, selected: boolean, shiftKey: boolean) => {
            const currentState = store.getState();
            const rows = tableRef.current?.getRowModel().rows ?? [];
            const currentRow = rows[rowIndex];

            if (!currentRow) {
                return;
            }

            // A plain click is the shift-click range with both ends on the same
            // row, so there is one loop rather than two bodies that have to be
            // kept in agreement.
            const isRange = shiftKey && currentState.lastClickedRowIndex !== null;
            const anchorIndex = isRange ? currentState.lastClickedRowIndex! : rowIndex;

            // v9 narrowed `RowSelectionState` to `Record<string, true>`: a row is
            // selected by the PRESENCE of its key, so deselecting means deleting
            // the entry rather than writing `false`. Writing `false` would leave
            // the row reading as selected.
            const newRowSelection: RowSelectionState = { ...currentState.rowSelection };

            for (let index = Math.min(anchorIndex, rowIndex); index <= Math.max(anchorIndex, rowIndex); index += 1) {
                const row = rows[index];

                if (!row) {
                    continue;
                }

                if (selected) {
                    newRowSelection[row.id] = true;
                } else {
                    delete newRowSelection[row.id];
                }
            }

            onRowSelectionChange(newRowSelection);

            store.setState("lastClickedRowIndex", rowIndex);
        },
        [store, onRowSelectionChange],
    );

    const onRowHeightChange = React.useCallback(
        (updater: Updater<RowHeightValue>) => {
            const currentState = store.getState();
            const newRowHeight = functionalUpdate(updater, currentState.rowHeight);

            store.setState("rowHeight", newRowHeight);
            propsRef.current.onRowHeightChange?.(newRowHeight);
        },
        [store, propsRef],
    );

    const onColumnClick = React.useCallback(
        (columnId: string) => {
            if (!propsRef.current.enableColumnSelection) {
                onSelectionClear();

                return;
            }

            selectColumn(columnId);
        },
        [propsRef, selectColumn, onSelectionClear],
    );

    const onPasteDialogOpenChange = React.useCallback(
        (open: boolean) => {
            if (!open) {
                store.setState("pasteDialog", {
                    clipboardText: "",
                    open: false,
                    rowsNeeded: 0,
                });
            }
        },
        [store],
    );

    const defaultColumn: Partial<ColumnDef<DataGridFeatures, TData>> = React.useMemo(() => {
        return {
            maxSize: MAX_COLUMN_SIZE,
            // Note: cell is rendered directly in DataGridRow to bypass flexRender's
            // unstable cell.getContext() (see TanStack Table issue #4794)
            minSize: MIN_COLUMN_SIZE,
        };
    }, []);

    const tableMeta = React.useMemo<TableMeta<DataGridFeatures, TData>>(() => {
        return {
            ...propsRef.current.meta,
            cellMapRef,
            get contextMenu() {
                return store.getState().contextMenu;
            },
            dataGridRef,
            get editingCell() {
                return store.getState().editingCell;
            },
            // Use getters for frequently changing state values to avoid recreating meta
            get focusedCell() {
                return store.getState().focusedCell;
            },
            getIsActiveSearchMatch,
            getIsCellSelected,
            getIsSearchMatch,
            onCellClick,
            onCellContextMenu,
            onCellDoubleClick,
            onCellEditingStart,
            onCellEditingStop,
            onCellMouseDown,
            onCellMouseEnter,
            onCellMouseUp,
            onCellsCopy,
            onCellsCut,
            onCellsPaste,
            onColumnClick,
            onContextMenuOpenChange,
            onDataUpdate,
            onFilesDelete: propsRef.current.onFilesDelete || undefined,
            onFilesUpload: propsRef.current.onFilesUpload || undefined,
            onPasteDialogOpenChange,
            onRowHeightChange,
            onRowsDelete: propsRef.current.onRowsDelete ? onRowsDelete : undefined,
            onRowSelect,
            onSelectionClear,
            get pasteDialog() {
                return store.getState().pasteDialog;
            },
            get readOnly() {
                return propsRef.current.readOnly;
            },
            get rowHeight() {
                return store.getState().rowHeight;
            },
            get searchOpen() {
                return store.getState().searchOpen;
            },
            get selectionState() {
                return store.getState().selectionState;
            },
        };
    }, [
        propsRef,
        store,
        getIsCellSelected,
        getIsSearchMatch,
        getIsActiveSearchMatch,
        onRowHeightChange,
        onRowSelect,
        onDataUpdate,
        onRowsDelete,
        onColumnClick,
        onCellClick,
        onCellDoubleClick,
        onCellMouseDown,
        onCellMouseEnter,
        onCellMouseUp,
        onCellContextMenu,
        onCellEditingStart,
        onCellEditingStop,
        onCellsCopy,
        onCellsCut,
        onCellsPaste,
        onSelectionClear,
        onContextMenuOpenChange,
        onPasteDialogOpenChange,
    ]);

    // Memoize state object to reduce shallow equality checks
    const tableState = React.useMemo<Partial<TableState<DataGridFeatures>>>(() => {
        return {
            ...propsRef.current.state,
            columnFilters,
            rowSelection,
            sorting,
        };
    }, [propsRef, sorting, columnFilters, rowSelection]);

    const tableOptions = React.useMemo<TableOptions<DataGridFeatures, TData>>(() => {
        return {
            ...propsRef.current,
            columnResizeDirection: textDirection,
            columnResizeMode: "onChange",
            columns,
            data,
            defaultColumn,
            // The core row model is automatic in v9, and the filtered/sorted ones
            // are registered as feature slots in `dataGridFeatures` rather than
            // passed here.
            features: dataGridFeatures,
            initialState: propsRef.current.initialState,
            meta: tableMeta,
            onColumnFiltersChange,
            onRowSelectionChange,
            onSortingChange,
            state: tableState,
        };
    }, [propsRef, data, columns, defaultColumn, tableState, textDirection, onRowSelectionChange, onSortingChange, onColumnFiltersChange, tableMeta]);

    const table = useTable(tableOptions);

    if (!tableRef.current) {
        tableRef.current = table;
    }

    // biome-ignore lint/correctness/useExhaustiveDependencies: columnResizing and columnSizing are used for calculating the column size vars
    const columnSizeVariables = React.useMemo(() => {
        const headers = table.getFlatHeaders();
        const colSizes: { [key: string]: number } = {};

        for (const header of headers) {
            colSizes[`--header-${header.id}-size`] = header.getSize();
            colSizes[`--col-${header.column.id}-size`] = header.column.getSize();
        }

        return colSizes;
    }, [table.store.state.columnResizing, table.store.state.columnSizing]);

    const rowVirtualizer = useVirtualizer({
        count: table.getRowModel().rows.length,
        estimateSize: () => rowHeightValue,
        getScrollElement: () => dataGridRef.current,
        measureElement:
            typeof window !== "undefined" && !navigator.userAgent.includes("Firefox") ? (element) => element?.getBoundingClientRect().height : undefined,
        overscan,
    });

    if (!rowVirtualizerRef.current) {
        rowVirtualizerRef.current = rowVirtualizer;
    }

    const onScrollToRow = React.useCallback(
        async (options: Partial<CellPosition>) => {
            await scrollToRowAndFocus(options, {
                cellMapRef,
                dataGridRef,
                focusGuardRef,
                footerRef,
                headerRef,
                propsRef,
                releaseFocusGuard,
                rowMapRef,
                rowVirtualizer,
                store,
            });
        },
        [rowVirtualizer, propsRef, store, releaseFocusGuard],
    );

    const onRowAdd = React.useCallback(
        async (event?: React.MouseEvent<HTMLDivElement>) => {
            if (propsRef.current.readOnly || !propsRef.current.onRowAdd) {
                return;
            }

            const initialRowCount = propsRef.current.data.length;

            let result: Partial<CellPosition> | null;

            try {
                result = await propsRef.current.onRowAdd(event);
            } catch {
                // Callback threw an error, don't proceed with scroll/focus
                return;
            }

            if (result === null || event?.defaultPrevented) {
                return;
            }

            onSelectionClear();

            // Trust the returned rowIndex from the callback
            // onScrollToRow will handle retries if the row isn't rendered yet
            const targetRowIndex = result.rowIndex ?? initialRowCount;
            const targetColumnId = result.columnId;

            onScrollToRow({
                columnId: targetColumnId,
                rowIndex: targetRowIndex,
            });
        },
        [propsRef, onScrollToRow, onSelectionClear],
    );

    const onDataGridKeyDown = React.useCallback(
        (event: KeyboardEvent) => {
            handleDataGridKeyDown(event, {
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
            });
        },
        [
            textDirection,
            store,
            propsRef,
            blurCell,
            navigateCell,
            selectAll,
            onCellsCopy,
            onCellsCut,
            onCellsPaste,
            onDataUpdate,
            onSelectionClear,
            navigableColumnIds,
            selectRange,
            onSearchOpenChange,
            onNavigateToNextMatch,
            onNavigateToPrevMatch,
            onCellEditingStop,
            onRowsDelete,
            restoreFocus,
            onScrollToRow,
        ],
    );

    const searchState = React.useMemo<SearchState | undefined>(() => {
        if (!propsRef.current.enableSearch) {
            return undefined;
        }

        return {
            matchIndex,
            onNavigateToNextMatch,
            onNavigateToPrevMatch,
            onSearch,
            onSearchOpenChange,
            onSearchQueryChange,
            searchMatches,
            searchOpen,
            searchQuery,
        };
    }, [
        propsRef,
        searchMatches,
        matchIndex,
        searchOpen,
        onSearchOpenChange,
        searchQuery,
        onSearchQueryChange,
        onSearch,
        onNavigateToNextMatch,
        onNavigateToPrevMatch,
    ]);

    React.useEffect(() => {
        const dataGridElement = dataGridRef.current;

        if (!dataGridElement) {
            return undefined;
        }

        dataGridElement.addEventListener("keydown", onDataGridKeyDown);

        return () => {
            dataGridElement.removeEventListener("keydown", onDataGridKeyDown);
        };
    }, [onDataGridKeyDown]);

    React.useEffect(() => {
        const onGlobalKeyDown = (event: KeyboardEvent) => {
            handleGlobalKeyDown(event, { dataGridRef, onSearchOpenChange, onSelectionClear, propsRef, store });
        };

        globalThis.addEventListener("keydown", onGlobalKeyDown, { capture: true });

        return () => {
            globalThis.removeEventListener("keydown", onGlobalKeyDown, true);
        };
    }, [propsRef, onSearchOpenChange, store, onSelectionClear]);

    React.useEffect(() => {
        const currentState = store.getState();
        const { autoFocus } = propsRef.current;

        if (autoFocus && data.length > 0 && columns.length > 0 && !currentState.focusedCell && navigableColumnIds.length > 0) {
            const rafId = requestAnimationFrame(() => {
                if (typeof autoFocus === "object") {
                    const { columnId, rowIndex } = autoFocus;

                    if (columnId) {
                        focusCell(rowIndex ?? 0, columnId);
                    }

                    return;
                }

                const firstColumnId = navigableColumnIds[0];

                if (firstColumnId) {
                    focusCell(0, firstColumnId);
                }
            });

            return () => cancelAnimationFrame(rafId);
        }

        return undefined;
    }, [store, propsRef, data, columns, navigableColumnIds, focusCell]);

    // Restore focus to container when virtualized cells are unmounted
    React.useEffect(() => restoreFocusOnFocusOut({ cellMapRef, dataGridRef, focusGuardRef, store }), [store]);

    React.useEffect(() => clearOnOutsideClick({ blurCell, dataGridRef, onSelectionClear, store }), [store, blurCell, onSelectionClear]);

    React.useEffect(() => suppressNativeSelectionWhileSelecting(store), [store]);

    useIsomorphicLayoutEffect(() => {
        const rafId = requestAnimationFrame(() => {
            rowVirtualizer.measure();
        });

        return () => cancelAnimationFrame(rafId);
    }, [
        rowHeight,
        table.store.state.columnFilters,
        table.store.state.columnOrder,
        table.store.state.columnPinning,
        table.store.state.columnSizing,
        table.store.state.columnVisibility,
        table.store.state.rowSelection,
        table.store.state.sorting,
    ]);

    // Calculate virtual values outside of child render to avoid flushSync issues
    const virtualTotalSize = rowVirtualizer.getTotalSize();
    const virtualItems = rowVirtualizer.getVirtualItems();
    const { measureElement } = rowVirtualizer;

    return React.useMemo(() => {
        return {
            activeSearchMatch,
            cellSelectionMap,
            columns,
            columnSizeVars: columnSizeVariables,
            contextMenu,
            dataGridRef,
            dir: textDirection,
            editingCell,
            focusedCell,
            footerRef,
            headerRef,
            measureElement,
            onRowAdd: propsRef.current.onRowAdd ? onRowAdd : undefined,
            pasteDialog,
            rowHeight,
            rowMapRef,
            searchMatchesByRow,
            searchState,
            table,
            tableMeta,
            virtualItems,
            virtualTotalSize,
        };
    }, [
        propsRef,
        textDirection,
        table,
        tableMeta,
        virtualTotalSize,
        virtualItems,
        measureElement,
        columns,
        columnSizeVariables,
        searchState,
        searchMatchesByRow,
        activeSearchMatch,
        cellSelectionMap,
        focusedCell,
        editingCell,
        rowHeight,
        contextMenu,
        pasteDialog,
        onRowAdd,
    ]);
};

export { useDataGrid };

export type { UseDataGridProps } from "@ui/hooks/data-grid/types";
