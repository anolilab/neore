"use client";

import type { RowData } from "@tanstack/react-table";
import { Checkbox } from "@ui/components/checkbox";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import type { DataGridCellProps } from "@ui/types/data-grid";
import * as React from "react";

export const CheckboxCell = <TData extends RowData>({
    cell,
    columnId,
    isActiveSearchMatch,
    isFocused,
    isSearchMatch,
    isSelected,
    readOnly,
    rowHeight,
    rowIndex,
    tableMeta,
}: Omit<DataGridCellProps<TData>, "isEditing">) => {
    const initialValue = cell.getValue() as boolean;
    const [value, setValue] = React.useState(initialValue);
    const containerRef = React.useRef<HTMLDivElement>(null);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue);
    }

    const onCheckedChange = React.useCallback(
        (checked: boolean) => {
            if (readOnly) {
                return;
            }

            setValue(checked);
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: checked });
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isFocused && !readOnly && (event.key === " " || event.key === "Enter")) {
                event.preventDefault();
                event.stopPropagation();
                onCheckedChange(!value);
            } else if (isFocused && event.key === "Tab") {
                event.preventDefault();
                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });
            }
        },
        [isFocused, value, onCheckedChange, tableMeta, readOnly],
    );

    const onWrapperClick = React.useCallback(
        (event: React.MouseEvent) => {
            if (!isFocused || readOnly) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            onCheckedChange(!value);
        },
        [isFocused, value, onCheckedChange, readOnly],
    );

    const onCheckboxClick = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
    }, []);

    const onCheckboxMouseDown = React.useCallback((event: any) => {
        event.stopPropagation();
    }, []);

    const onCheckboxDoubleClick = React.useCallback((event: any) => {
        event.stopPropagation();
    }, []);

    return (
        <DataGridCellWrapper<TData>
            cell={cell}
            className="flex size-full justify-center"
            columnId={columnId}
            isActiveSearchMatch={isActiveSearchMatch}
            isEditing={false}
            isFocused={isFocused}
            isSearchMatch={isSearchMatch}
            isSelected={isSelected}
            onClick={onWrapperClick}
            onKeyDown={onWrapperKeyDown}
            readOnly={readOnly}
            ref={containerRef}
            rowHeight={rowHeight}
            rowIndex={rowIndex}
            tableMeta={tableMeta}
        >
            <Checkbox
                checked={value}
                className="border-primary"
                disabled={readOnly}
                onCheckedChange={onCheckedChange}
                onClick={onCheckboxClick}
                onDoubleClick={onCheckboxDoubleClick}
                onMouseDown={onCheckboxMouseDown}
            />
        </DataGridCellWrapper>
    );
};
