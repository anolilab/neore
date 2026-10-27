import type { ColumnFiltersState, RowData, RowSelectionState, SortingState, TableOptions, useTable } from "@tanstack/react-table";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import type {
    CellPosition,
    ContextMenuState,
    Direction,
    FileCellData,
    PasteDialogState,
    RowHeightValue,
    SelectionState,
    UpdateCell,
} from "@ui/types/data-grid";
import type * as React from "react";

export interface DataGridState {
    columnFilters: ColumnFiltersState;
    contextMenu: ContextMenuState;
    cutCells: Set<string>;
    editingCell: CellPosition | null;
    focusedCell: CellPosition | null;
    lastClickedRowIndex: number | null;
    matchIndex: number;
    pasteDialog: PasteDialogState;
    rowHeight: RowHeightValue;
    rowSelection: RowSelectionState;
    searchMatches: CellPosition[];
    searchOpen: boolean;
    searchQuery: string;
    selectionState: SelectionState;
    sorting: SortingState;
}

export interface DataGridStore {
    batch: (function_: () => void) => void;
    getState: () => DataGridState;
    notify: () => void;
    setState: <K extends keyof DataGridState>(key: K, value: DataGridState[K]) => void;
    subscribe: (callback: () => void) => () => void;
}

export interface UseDataGridProps<TData extends RowData> extends Omit<TableOptions<DataGridFeatures, TData>, "features"> {
    autoFocus?: boolean | Partial<CellPosition>;
    dir?: Direction;
    enableColumnSelection?: boolean;
    enablePaste?: boolean;
    enableSearch?: boolean;
    onDataChange?: (data: TData[]) => void;
    onFilesDelete?: (params: { columnId: string; fileIds: string[]; rowIndex: number }) => void | Promise<void>;
    onFilesUpload?: (params: { columnId: string; files: File[]; rowIndex: number }) => Promise<FileCellData[]>;
    onPaste?: (updates: UpdateCell[]) => void | Promise<void>;
    onRowAdd?: (event?: React.MouseEvent<HTMLDivElement>) => Partial<CellPosition> | Promise<Partial<CellPosition> | null> | null;
    onRowHeightChange?: (rowHeight: RowHeightValue) => void;
    onRowsAdd?: (count: number) => void | Promise<void>;
    onRowsDelete?: (rows: TData[], rowIndices: number[]) => void | Promise<void>;
    overscan?: number;
    readOnly?: boolean;
    rowHeight?: RowHeightValue;
}

export type DataGridTable<TData extends RowData> = ReturnType<typeof useTable<DataGridFeatures, TData>>;

export type DataGridTableRef<TData extends RowData> = React.RefObject<DataGridTable<TData> | null>;

export type DataGridPropsRef<TData extends RowData> = React.RefObject<Omit<UseDataGridProps<TData>, "dir" | "overscan" | "rowHeight">>;

export type DataGridRowVirtualizer = Virtualizer<HTMLDivElement, Element>;

export type DataGridRowVirtualizerRef = React.RefObject<DataGridRowVirtualizer | null>;

export type DataGridElementRef = React.RefObject<HTMLDivElement | null>;

export type DataGridRowMapRef = React.RefObject<Map<number, HTMLDivElement>>;

export type DataGridCellMapRef = React.RefObject<Map<string, HTMLDivElement>>;
