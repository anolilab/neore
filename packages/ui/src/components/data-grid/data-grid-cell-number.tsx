"use client";

import type { RowData } from "@tanstack/react-table";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import type { DataGridCellProps } from "@ui/types/data-grid";
import * as React from "react";

export const NumberCell = <TData extends RowData>({
    cell,
    columnId,
    isActiveSearchMatch,
    isEditing,
    isFocused,
    isSearchMatch,
    isSelected,
    readOnly,
    rowHeight,
    rowIndex,
    tableMeta,
}: DataGridCellProps<TData>) => {
    const initialValue = cell.getValue() as number;
    const [value, setValue] = React.useState(String(initialValue ?? ""));
    const inputRef = React.useRef<HTMLInputElement>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);

    const cellOptions = cell.column.columnDef.meta?.cell;
    const numberCellOptions = cellOptions?.variant === "number" ? cellOptions : null;
    const min = numberCellOptions?.min;
    const max = numberCellOptions?.max;
    const step = numberCellOptions?.step;

    const prevIsEditingRef = React.useRef(isEditing);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(String(initialValue ?? ""));
    }

    const onBlur = React.useCallback(() => {
        const numberValue = value === "" ? null : Number(value);

        if (!readOnly && numberValue !== initialValue) {
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: numberValue });
        }

        tableMeta?.onCellEditingStop?.();
    }, [tableMeta, rowIndex, columnId, initialValue, value, readOnly]);

    const onChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        setValue(event.target.value);
    }, []);

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing) {
                switch (event.key) {
                    case "Enter": {
                        event.preventDefault();
                        const numberValue = value === "" ? null : Number(value);

                        if (numberValue !== initialValue) {
                            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: numberValue });
                        }

                        tableMeta?.onCellEditingStop?.({ moveToNextRow: true });

                        break;
                    }
                    case "Escape": {
                        event.preventDefault();
                        setValue(String(initialValue ?? ""));
                        inputRef.current?.blur();

                        break;
                    }
                    case "Tab": {
                        event.preventDefault();
                        const numberValue = value === "" ? null : Number(value);

                        if (numberValue !== initialValue) {
                            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: numberValue });
                        }

                        tableMeta?.onCellEditingStop?.({
                            direction: event.shiftKey ? "left" : "right",
                        });

                        break;
                    }
                    // no default
                }
            } else if (isFocused) {
                // Handle Backspace to start editing with empty value
                if (event.key === "Backspace") {
                    setValue("");
                } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
                    // Handle typing to pre-fill the value when editing starts
                    setValue(event.key);
                }
            }
        },
        [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId, value],
    );

    React.useEffect(() => {
        const wasEditing = prevIsEditingRef.current;

        prevIsEditingRef.current = isEditing;

        // Only focus when we start editing (transition from false to true)
        if (isEditing && !wasEditing && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isEditing]);

    return (
        <DataGridCellWrapper<TData>
            cell={cell}
            columnId={columnId}
            isActiveSearchMatch={isActiveSearchMatch}
            isEditing={isEditing}
            isFocused={isFocused}
            isSearchMatch={isSearchMatch}
            isSelected={isSelected}
            onKeyDown={onWrapperKeyDown}
            readOnly={readOnly}
            ref={containerRef}
            rowHeight={rowHeight}
            rowIndex={rowIndex}
            tableMeta={tableMeta}
        >
            {isEditing ? (
                <input
                    className="w-full [appearance:textfield] border-none bg-transparent p-0 outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    max={max}
                    min={min}
                    onBlur={onBlur}
                    onChange={onChange}
                    ref={inputRef}
                    step={step}
                    type="number"
                    value={value}
                />
            ) : (
                <span data-slot="grid-cell-content">{value}</span>
            )}
        </DataGridCellWrapper>
    );
};
