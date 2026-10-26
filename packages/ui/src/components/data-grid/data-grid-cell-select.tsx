"use client";

import type { RowData } from "@tanstack/react-table";
import { Badge } from "@ui/components/badge";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import type { DataGridCellProps } from "@ui/types/data-grid";
import * as React from "react";

export const SelectCell = <TData extends RowData>({
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
    const initialValue = cell.getValue() as string;
    const [value, setValue] = React.useState(initialValue);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const cellOptions = cell.column.columnDef.meta?.cell;
    const options = cellOptions?.variant === "select" ? cellOptions.options : [];

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue);
    }

    const onValueChange = React.useCallback(
        (nextValue: string | null) => {
            if (nextValue === null) {
                return;
            }

            if (readOnly) {
                return;
            }

            setValue(nextValue);
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: nextValue });
            tableMeta?.onCellEditingStop?.();
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onOpenChange = React.useCallback(
        (open: boolean) => {
            if (open && !readOnly) {
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else {
                tableMeta?.onCellEditingStop?.();
            }
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing && event.key === "Escape") {
                event.preventDefault();
                setValue(initialValue);
                tableMeta?.onCellEditingStop?.();
            } else if (!isEditing && isFocused && event.key === "Tab") {
                event.preventDefault();
                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });
            }
        },
        [isEditing, isFocused, initialValue, tableMeta],
    );

    const displayLabel = options.find((opt) => opt.value === value)?.label ?? value;

    const badge = displayLabel ? (
        <Badge className="px-1.5 py-px whitespace-pre-wrap" data-slot="grid-cell-content" variant="secondary">
            {displayLabel}
        </Badge>
    ) : null;

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
                <Select onOpenChange={onOpenChange} onValueChange={onValueChange} open={isEditing} value={value}>
                    <SelectTrigger
                        className="size-full items-start border-none p-0 shadow-none focus-visible:ring-0 dark:bg-transparent [&_svg]:hidden"
                        size="sm"
                    >
                        {displayLabel ? (
                            <Badge className="px-1.5 py-px whitespace-pre-wrap" variant="secondary">
                                <SelectValue />
                            </Badge>
                        ) : (
                            <SelectValue />
                        )}
                    </SelectTrigger>
                    <SelectContent
                        // compensate for the wrapper padding
                        align="start"
                        alignOffset={-8}
                        className="min-w-[calc(var(--radix-select-trigger-width)+16px)]"
                        data-grid-cell-editor=""
                        sideOffset={-8}
                    >
                        {options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : (
                badge
            )}
        </DataGridCellWrapper>
    );
};
