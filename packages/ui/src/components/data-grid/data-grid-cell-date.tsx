"use client";

import { useLingui } from "@lingui/react/macro";
import type { RowData } from "@tanstack/react-table";
import { Calendar } from "@ui/components/calendar";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import { Popover, PopoverAnchor, PopoverContent } from "@ui/components/popover";
import type { DataGridCellProps } from "@ui/types/data-grid";
import { formatDate } from "@ui/utils/locale-format";
import * as React from "react";

const formatDateForDisplay = (dateString: string, locale: string) => {
    if (!dateString) {
        return "";
    }

    return formatDate(dateString, locale);
};

export const DateCell = <TData extends RowData>({
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
    const { i18n } = useLingui();
    const initialValue = cell.getValue() as string;
    const [value, setValue] = React.useState(initialValue ?? "");
    const containerRef = React.useRef<HTMLDivElement>(null);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue ?? "");
    }

    const selectedDate = value ? new Date(value) : undefined;

    const onDateSelect = React.useCallback(
        (date: Date | undefined) => {
            if (!date || readOnly) {
                return;
            }

            const formattedDate = date.toISOString().split("T", 1)[0] ?? "";

            setValue(formattedDate);
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: formattedDate });
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
            <Popover onOpenChange={onOpenChange} open={isEditing}>
                <PopoverAnchor nativeButton={false} render={<span data-slot="grid-cell-content" />}>
                    {formatDateForDisplay(value, i18n.locale)}
                </PopoverAnchor>
                {isEditing && (
                    <PopoverContent align="start" alignOffset={-8} className="w-auto p-0" data-grid-cell-editor="">
                        <Calendar
                            autoFocus
                            captionLayout="dropdown"
                            defaultMonth={selectedDate ?? new Date()}
                            mode="single"
                            onSelect={onDateSelect}
                            selected={selectedDate}
                        />
                    </PopoverContent>
                )}
            </Popover>
        </DataGridCellWrapper>
    );
};
