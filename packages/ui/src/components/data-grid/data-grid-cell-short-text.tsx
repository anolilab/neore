"use client";

import type { RowData } from "@tanstack/react-table";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import type { DataGridCellProps } from "@ui/types/data-grid";
import cn from "@ui/utils/cn";
import * as React from "react";

export const ShortTextCell = <TData extends RowData>({
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
    const cellRef = React.useRef<HTMLDivElement>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue);
    }

    // The node is contentEditable, so the browser mutates its text behind
    // React's back; when the source value changes underneath, React's own child
    // update can be a no-op against a DOM that no longer matches. Re-sync it
    // here rather than during render — a render can be thrown away (Strict Mode
    // double-render, a re-thrown render), and a DOM write in one cannot be.
    const syncedValueRef = React.useRef(initialValue);

    React.useLayoutEffect(() => {
        if (syncedValueRef.current === initialValue) {
            return;
        }

        syncedValueRef.current = initialValue;

        if (cellRef.current && !isEditing) {
            cellRef.current.textContent = initialValue;
        }
    }, [initialValue, isEditing]);

    const onBlur = React.useCallback(() => {
        // Read the current value directly from the DOM to avoid stale state
        const currentValue = cellRef.current?.textContent ?? "";

        if (!readOnly && currentValue !== initialValue) {
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: currentValue });
        }

        tableMeta?.onCellEditingStop?.();
    }, [tableMeta, rowIndex, columnId, initialValue, readOnly]);

    const onInput = React.useCallback((event: React.FormEvent<HTMLDivElement>) => {
        const currentValue = event.currentTarget.textContent ?? "";

        setValue(currentValue);
    }, []);

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing) {
                switch (event.key) {
                    case "Enter": {
                        event.preventDefault();
                        const currentValue = cellRef.current?.textContent ?? "";

                        if (currentValue !== initialValue) {
                            tableMeta?.onDataUpdate?.({
                                columnId,
                                rowIndex,
                                value: currentValue,
                            });
                        }

                        tableMeta?.onCellEditingStop?.({ moveToNextRow: true });

                        break;
                    }
                    case "Escape": {
                        event.preventDefault();
                        setValue(initialValue);
                        cellRef.current?.blur();

                        break;
                    }
                    case "Tab": {
                        event.preventDefault();
                        const currentValue = cellRef.current?.textContent ?? "";

                        if (currentValue !== initialValue) {
                            tableMeta?.onDataUpdate?.({
                                columnId,
                                rowIndex,
                                value: currentValue,
                            });
                        }

                        tableMeta?.onCellEditingStop?.({
                            direction: event.shiftKey ? "left" : "right",
                        });

                        break;
                    }
                    // no default
                }
            } else if (isFocused && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
                // Handle typing to pre-fill the value when editing starts
                setValue(event.key);

                queueMicrotask(() => {
                    if (!(cellRef.current && cellRef.current.contentEditable === "true")) {
                        return;
                    }

                    cellRef.current.textContent = event.key;
                    const range = document.createRange();
                    const selection = getSelection();

                    range.selectNodeContents(cellRef.current);
                    range.collapse(false);
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                });
            }
        },
        [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId],
    );

    React.useEffect(() => {
        if (!(isEditing && cellRef.current)) {
            return;
        }

        cellRef.current.focus();

        if (!cellRef.current.textContent && value) {
            cellRef.current.textContent = value;
        }

        if (cellRef.current.textContent) {
            const range = document.createRange();
            const selection = getSelection();

            range.selectNodeContents(cellRef.current);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
        }
    }, [isEditing, value]);

    const displayValue = isEditing ? "" : (value ?? "");

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
            <div
                className={cn("size-full overflow-hidden outline-none", {
                    "whitespace-nowrap **:inline **:whitespace-nowrap [&_br]:hidden": isEditing,
                })}
                contentEditable={isEditing}
                data-slot="grid-cell-content"
                onBlur={onBlur}
                onInput={onInput}
                ref={cellRef}
                role="textbox"
                suppressContentEditableWarning
                tabIndex={-1}
            >
                {displayValue}
            </div>
        </DataGridCellWrapper>
    );
};
