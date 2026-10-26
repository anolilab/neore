import type { Column, RowData } from "@tanstack/react-table";
import type { DataGridStore, DataGridTableRef } from "@ui/hooks/data-grid/types";
import { getCellKey, getIsFileCellData, matchSelectOption, parseCellKey } from "@ui/lib/data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import type { CellOptions, UpdateCell } from "@ui/types/data-grid";

const DOMAIN_REGEX = /^[\w.-]+\.[a-z]{2,}(?:\/\S*)?$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}.*)?$/;
const TRUTHY_BOOLEANS = new Set(["1", "checked", "true", "yes"]);
const JSON_OR_BOOLEAN_FIRST_CHARS = new Set(["[", "f", "t", "{"]);
const VALID_BOOLEANS = new Set(["0", "1", "checked", "false", "no", "true", "unchecked", "yes"]);

/**
 * The cells a copy or cut acts on (the selection, or the focused cell), and
 * their tab-separated text. `undefined` when there is nothing to copy.
 */
export const getClipboardSelection = <TData extends RowData>(
    store: DataGridStore,
    tableRef: DataGridTableRef<TData>,
): { selectedCellsArray: string[]; tsvData: string } | undefined => {
    const currentState = store.getState();

    let selectedCellsArray: string[];

    if (currentState.selectionState.selectedCells.size === 0) {
        if (!currentState.focusedCell) {
            return undefined;
        }

        const focusedCellKey = getCellKey(currentState.focusedCell.rowIndex, currentState.focusedCell.columnId);

        selectedCellsArray = [focusedCellKey];
    } else {
        selectedCellsArray = [...currentState.selectionState.selectedCells];
    }

    const currentTable = tableRef.current;
    const rows = currentTable?.getRowModel().rows;

    if (!rows) {
        return undefined;
    }

    const selectedColumnIds: string[] = [];

    for (const cellKey of selectedCellsArray) {
        const { columnId } = parseCellKey(cellKey);

        if (columnId && !selectedColumnIds.includes(columnId)) {
            selectedColumnIds.push(columnId);
        }
    }

    const cellData = new Map<string, string>();

    for (const cellKey of selectedCellsArray) {
        const { columnId, rowIndex } = parseCellKey(cellKey);
        const row = rows[rowIndex];

        if (row) {
            const cell = row.getVisibleCells().find((c) => c.column.id === columnId);

            if (cell) {
                const value = cell.getValue();
                const cellVariant = cell.column.columnDef?.meta?.cell?.variant;

                let serializedValue: string;

                if (cellVariant === "file" || cellVariant === "multi-select") {
                    serializedValue = value ? JSON.stringify(value) : "";
                } else if (value instanceof Date) {
                    serializedValue = value.toISOString();
                } else {
                    serializedValue = String(value ?? "");
                }

                cellData.set(cellKey, serializedValue);
            }
        }
    }

    const rowIndices = new Set<number>();
    const colIndices = new Set<number>();

    for (const cellKey of selectedCellsArray) {
        const { columnId, rowIndex } = parseCellKey(cellKey);

        rowIndices.add(rowIndex);
        const colIndex = selectedColumnIds.indexOf(columnId);

        if (colIndex !== -1) {
            colIndices.add(colIndex);
        }
    }

    const sortedRowIndices = [...rowIndices].toSorted((a, b) => a - b);
    const sortedColIndices = [...colIndices].toSorted((a, b) => a - b);
    const sortedColumnIds = sortedColIndices.map((i) => selectedColumnIds[i]);

    const tsvData = sortedRowIndices
        .map((rowIndex) =>
            sortedColumnIds
                .map((columnId) => {
                    const cellKey = `${rowIndex}:${columnId}`;

                    return cellData.get(cellKey) ?? "";
                })
                .join("\t"),
        )
        .join("\n");

    return { selectedCellsArray, tsvData };
};

/** Turns one pasted string into the value its column stores, or says to skip it. */
export const parsePastedValue = (pastedValue: string, cellOptions: CellOptions | undefined): { processedValue: unknown; shouldSkip: boolean } => {
    const cellVariant = cellOptions?.variant;
    let processedValue: unknown = pastedValue;
    let shouldSkip = false;

    switch (cellVariant) {
        case "checkbox": {
            if (pastedValue) {
                const lower = pastedValue.toLowerCase();

                if (VALID_BOOLEANS.has(lower)) {
                    processedValue = TRUTHY_BOOLEANS.has(lower);
                } else {
                    shouldSkip = true;
                }
            } else {
                processedValue = false;
            }

            break;
        }

        case "date": {
            if (pastedValue) {
                const date = new Date(pastedValue);

                if (Number.isNaN(date.getTime())) shouldSkip = true;
                else processedValue = date;
            } else {
                processedValue = null;
            }

            break;
        }

        case "file": {
            if (pastedValue) {
                try {
                    const parsed = JSON.parse(pastedValue);

                    if (Array.isArray(parsed)) {
                        const validFiles = parsed.filter(getIsFileCellData);

                        if (parsed.length > 0 && validFiles.length === 0) {
                            shouldSkip = true;
                        } else {
                            processedValue = validFiles;
                        }
                    } else {
                        shouldSkip = true;
                    }
                } catch {
                    shouldSkip = true;
                }
            } else {
                processedValue = [];
            }

            break;
        }

        case "multi-select": {
            const options = cellOptions?.options ?? [];
            let values: string[] = [];

            try {
                const parsed = JSON.parse(pastedValue);

                if (Array.isArray(parsed)) {
                    values = parsed.filter((v): v is string => typeof v === "string");
                }
            } catch {
                values = pastedValue ? pastedValue.split(",").map((v) => v.trim()) : [];
            }

            const validated = values.map((v) => matchSelectOption(v, options)).filter(Boolean) as string[];

            if (values.length > 0 && validated.length === 0) {
                shouldSkip = true;
            } else {
                processedValue = validated;
            }

            break;
        }

        case "number": {
            if (pastedValue) {
                const parsedNumber = Number.parseFloat(pastedValue);

                if (Number.isNaN(parsedNumber)) shouldSkip = true;
                else processedValue = parsedNumber;
            } else {
                processedValue = null;
            }

            break;
        }

        case "select": {
            const options = cellOptions?.options ?? [];

            if (pastedValue) {
                const matched = matchSelectOption(pastedValue, options);

                if (matched) processedValue = matched;
                else shouldSkip = true;
            } else {
                processedValue = "";
            }

            break;
        }

        case "url": {
            if (pastedValue) {
                const firstChar = pastedValue[0];

                if (firstChar === "[" || firstChar === "{") {
                    shouldSkip = true;
                } else if (URL.canParse(pastedValue) || DOMAIN_REGEX.test(pastedValue)) {
                    processedValue = pastedValue;
                } else {
                    shouldSkip = true;
                }
            } else {
                processedValue = "";
            }

            break;
        }

        default: {
            if (!pastedValue) {
                processedValue = "";
                break;
            }

            if (ISO_DATE_REGEX.test(pastedValue)) {
                const date = new Date(pastedValue);

                if (!Number.isNaN(date.getTime())) {
                    processedValue = date.toLocaleDateString();
                    break;
                }
            }

            const firstChar = pastedValue[0];

            if (JSON_OR_BOOLEAN_FIRST_CHARS.has(firstChar ?? "")) {
                try {
                    const parsed = JSON.parse(pastedValue);

                    if (Array.isArray(parsed)) {
                        if (parsed.length > 0 && parsed.every(getIsFileCellData)) {
                            processedValue = parsed.map((f) => f.name).join(", ");
                        } else if (parsed.every((v) => typeof v === "string")) {
                            processedValue = (parsed as string[]).join(", ");
                        }
                    } else if (typeof parsed === "boolean") {
                        processedValue = parsed ? "Checked" : "Unchecked";
                    }
                } catch {
                    const lower = pastedValue.toLowerCase();

                    if (lower === "true" || lower === "false") {
                        processedValue = lower === "true" ? "Checked" : "Unchecked";
                    }
                }
            }
        }
    }

    return { processedValue, shouldSkip };
};

/** The value that clears a cell of the given variant. */
export const getEmptyCellValue = (cellVariant: CellOptions["variant"] | undefined): unknown => {
    let emptyValue: unknown = "";

    switch (cellVariant) {
        case "checkbox": {
            emptyValue = false;

            break;
        }
        case "date":
        case "number": {
            emptyValue = null;

            break;
        }
        case "file":
        case "multi-select": {
            emptyValue = [];

            break;
        }
        default: {
            break;
        }
    }

    return emptyValue;
};

/** One clearing update per cell key, for cut cells and the Delete key. */
export const getEmptyCellUpdates = <TData extends RowData>(
    cellKeys: Iterable<string>,
    tableColumns: Column<DataGridFeatures, TData, unknown>[],
): UpdateCell[] => {
    const updates: UpdateCell[] = [];

    for (const cellKey of cellKeys) {
        const { columnId, rowIndex } = parseCellKey(cellKey);

        const column = tableColumns.find((c) => c.id === columnId);
        const cellVariant = column?.columnDef?.meta?.cell?.variant;

        updates.push({ columnId, rowIndex, value: getEmptyCellValue(cellVariant) });
    }

    return updates;
};
