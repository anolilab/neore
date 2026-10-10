import type { Cell, RowData, TableFeatures, TableMeta } from "@tanstack/react-table";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";

export type Direction = "ltr" | "rtl";

export type RowHeightValue = "short" | "medium" | "tall" | "extra-tall";

export interface CellSelectOption {
    count?: number;
    icon?: React.FC<React.SVGProps<SVGSVGElement>>;
    label: string;
    value: string;
}

export type CellOptions =
    | {
          variant: "short-text";
      }
    | {
          variant: "long-text";
      }
    | {
          max?: number;
          min?: number;
          step?: number;
          variant: "number";
      }
    | {
          options: CellSelectOption[];
          variant: "select";
      }
    | {
          options: CellSelectOption[];
          variant: "multi-select";
      }
    | {
          variant: "checkbox";
      }
    | {
          variant: "date";
      }
    | {
          variant: "url";
      }
    | {
          accept?: string;
          maxFiles?: number;
          maxFileSize?: number;
          multiple?: boolean;
          variant: "file";
      };

export interface UpdateCell {
    columnId: string;
    rowIndex: number;
    value: unknown;
}

declare module "@tanstack/react-table" {
    // biome-ignore lint/correctness/noUnusedVariables: the type parameters exist to match the upstream declaration
    interface ColumnMeta<TFeatures extends TableFeatures, TData extends RowData, TValue> {
        cell?: CellOptions;
        label?: string;
    }

    // biome-ignore lint/correctness/noUnusedVariables: the type parameters exist to match the upstream declaration
    interface TableMeta<TFeatures extends TableFeatures, TData extends RowData> {
        cellMapRef?: React.RefObject<Map<string, HTMLDivElement>>;
        contextMenu?: ContextMenuState;
        dataGridRef?: React.RefObject<HTMLElement | null>;
        editingCell?: CellPosition | null;
        focusedCell?: CellPosition | null;
        getIsActiveSearchMatch?: (rowIndex: number, columnId: string) => boolean;
        getIsCellSelected?: (rowIndex: number, columnId: string) => boolean;
        getIsSearchMatch?: (rowIndex: number, columnId: string) => boolean;
        onCellClick?: (rowIndex: number, columnId: string, event?: React.MouseEvent) => void;
        onCellContextMenu?: (rowIndex: number, columnId: string, event: React.MouseEvent) => void;
        onCellDoubleClick?: (rowIndex: number, columnId: string) => void;
        onCellEditingStart?: (rowIndex: number, columnId: string) => void;
        onCellEditingStop?: (options?: { direction?: NavigationDirection; moveToNextRow?: boolean }) => void;
        onCellMouseDown?: (rowIndex: number, columnId: string, event: React.MouseEvent) => void;
        onCellMouseEnter?: (rowIndex: number, columnId: string, event: React.MouseEvent) => void;
        onCellMouseUp?: () => void;
        onCellsCopy?: () => void;
        onCellsCut?: () => void;
        onCellsPaste?: (expand?: boolean) => void;
        onColumnClick?: (columnId: string) => void;
        onContextMenuOpenChange?: (open: boolean) => void;
        onDataUpdate?: (params: UpdateCell | UpdateCell[]) => void;
        onFilesDelete?: (params: { columnId: string; fileIds: string[]; rowIndex: number }) => void | Promise<void>;
        onFilesUpload?: (params: { columnId: string; files: File[]; rowIndex: number }) => Promise<FileCellData[]>;
        onPasteDialogOpenChange?: (open: boolean) => void;
        onRowHeightChange?: (value: RowHeightValue) => void;
        onRowsDelete?: (rowIndices: number[]) => void | Promise<void>;
        onRowSelect?: (rowIndex: number, checked: boolean, shiftKey: boolean) => void;
        onSelectionClear?: () => void;
        pasteDialog?: PasteDialogState;
        readOnly?: boolean;
        rowHeight?: RowHeightValue;
        searchOpen?: boolean;
        selectionState?: SelectionState;
    }
}

export interface CellPosition {
    columnId: string;
    rowIndex: number;
}

export interface CellRange {
    end: CellPosition;
    start: CellPosition;
}

export interface SelectionState {
    isSelecting: boolean;
    selectedCells: Set<string>;
    selectionRange: CellRange | null;
}

export interface ContextMenuState {
    open: boolean;
    x: number;
    y: number;
}

export interface PasteDialogState {
    clipboardText: string;
    open: boolean;
    rowsNeeded: number;
}

export type NavigationDirection =
    "up" | "down" | "left" | "right" | "home" | "end" | "ctrl+up" | "ctrl+down" | "ctrl+home" | "ctrl+end" | "pageup" | "pagedown" | "pageleft" | "pageright";

export interface SearchState {
    matchIndex: number;
    onNavigateToNextMatch: () => void;
    onNavigateToPrevMatch: () => void;
    onSearch: (query: string) => void;
    onSearchOpenChange: (open: boolean) => void;
    onSearchQueryChange: (query: string) => void;
    searchMatches: CellPosition[];
    searchOpen: boolean;
    searchQuery: string;
}

export interface DataGridCellProps<TData extends RowData> {
    cell: Cell<DataGridFeatures, TData, unknown>;
    columnId: string;
    isActiveSearchMatch: boolean;
    isEditing: boolean;
    isFocused: boolean;
    isSearchMatch: boolean;
    isSelected: boolean;
    readOnly: boolean;
    rowHeight: RowHeightValue;
    rowIndex: number;
    tableMeta: TableMeta<DataGridFeatures, TData>;
}

export interface FileCellData {
    id: string;
    name: string;
    size: number;
    type: string;
    url?: string;
}

export type TextFilterOperator = "contains" | "notContains" | "equals" | "notEquals" | "startsWith" | "endsWith" | "isEmpty" | "isNotEmpty";

export type NumberFilterOperator =
    "equals" | "notEquals" | "lessThan" | "lessThanOrEqual" | "greaterThan" | "greaterThanOrEqual" | "isBetween" | "isEmpty" | "isNotEmpty";

export type DateFilterOperator = "equals" | "notEquals" | "before" | "after" | "onOrBefore" | "onOrAfter" | "isBetween" | "isEmpty" | "isNotEmpty";

export type SelectFilterOperator = "is" | "isNot" | "isAnyOf" | "isNoneOf" | "isEmpty" | "isNotEmpty";

export type BooleanFilterOperator = "isTrue" | "isFalse";

export type FilterOperator = TextFilterOperator | NumberFilterOperator | DateFilterOperator | SelectFilterOperator | BooleanFilterOperator;

export interface FilterValue {
    endValue?: string | number;
    operator: FilterOperator;
    value?: string | number | string[];
}
