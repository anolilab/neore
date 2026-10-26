"use client";

import { useLingui } from "@lingui/react/macro";
import type { RowData } from "@tanstack/react-table";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import { Popover, PopoverAnchor, PopoverContent } from "@ui/components/popover";
import { Textarea } from "@ui/components/textarea";
import useDebouncedCallback from "@ui/hooks/use-debounced-callback";
import type { DataGridCellProps } from "@ui/types/data-grid";
import * as React from "react";

/** Pulls the popover up over the cell so the editor opens on top of it. */
const overlapAnchor = ({ anchor }: { anchor: { height: number } }) => -anchor.height;

export const LongTextCell = <TData extends RowData>({
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
    const { t } = useLingui();
    const initialValue = cell.getValue() as string;
    const [value, setValue] = React.useState(initialValue ?? "");
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue ?? "");
    }

    const debouncedSave = useDebouncedCallback((newValue: string) => {
        if (!readOnly) {
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: newValue });
        }
    }, 300);

    const onSave = React.useCallback(() => {
        // Immediately save any pending changes and close the popover
        if (!readOnly && value !== initialValue) {
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value });
        }

        tableMeta?.onCellEditingStop?.();
    }, [tableMeta, value, initialValue, rowIndex, columnId, readOnly]);

    const onCancel = React.useCallback(() => {
        // Restore the original value
        setValue(initialValue ?? "");

        if (!readOnly) {
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: initialValue });
        }

        tableMeta?.onCellEditingStop?.();
    }, [tableMeta, initialValue, rowIndex, columnId, readOnly]);

    const onOpenChange = React.useCallback(
        (open: boolean) => {
            if (open && !readOnly) {
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else {
                // Immediately save any pending changes when closing
                if (!readOnly && value !== initialValue) {
                    tableMeta?.onDataUpdate?.({ columnId, rowIndex, value });
                }

                tableMeta?.onCellEditingStop?.();
            }
        },
        [tableMeta, value, initialValue, rowIndex, columnId, readOnly],
    );

    const initialFocus = React.useCallback(() => {
        const textarea = textareaRef.current;

        if (textarea) {
            const { length } = textarea.value;

            textarea.setSelectionRange(length, length);
        }

        return textarea;
    }, []);

    const onBlur = React.useCallback(() => {
        // Immediately save any pending changes on blur
        if (!readOnly && value !== initialValue) {
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value });
        }

        tableMeta?.onCellEditingStop?.();
    }, [tableMeta, value, initialValue, rowIndex, columnId, readOnly]);

    const onChange = React.useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>) => {
            const newValue = event.target.value;

            setValue(newValue);
            debouncedSave(newValue);
        },
        [debouncedSave],
    );

    const onKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
            } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                onSave();
            } else if (event.key === "Tab") {
                event.preventDefault();

                // Save any pending changes
                if (value !== initialValue) {
                    tableMeta?.onDataUpdate?.({ columnId, rowIndex, value });
                }

                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });

                return;
            }

            // Stop propagation to prevent grid navigation
            event.stopPropagation();
        },
        [onSave, onCancel, value, initialValue, tableMeta, rowIndex, columnId],
    );

    return (
        <Popover onOpenChange={onOpenChange} open={isEditing}>
            <PopoverAnchor
                render={
                    <DataGridCellWrapper
                        cell={cell}
                        columnId={columnId}
                        isActiveSearchMatch={isActiveSearchMatch}
                        isEditing={isEditing}
                        isFocused={isFocused}
                        isSearchMatch={isSearchMatch}
                        isSelected={isSelected}
                        readOnly={readOnly}
                        rowHeight={rowHeight}
                        rowIndex={rowIndex}
                        tableMeta={tableMeta}
                    />
                }
            >
                <span data-slot="grid-cell-content">{value}</span>
            </PopoverAnchor>
            <PopoverContent
                align="start"
                className="w-[400px] rounded-none p-0"
                data-grid-cell-editor=""
                initialFocus={initialFocus}
                side="bottom"
                sideOffset={overlapAnchor}
            >
                <Textarea
                    className="max-h-[300px] min-h-[150px] resize-none overflow-y-auto rounded-none border-0 shadow-none focus-visible:ring-0"
                    onBlur={onBlur}
                    onChange={onChange}
                    onKeyDown={onKeyDown}
                    placeholder={t`Enter text...`}
                    ref={textareaRef}
                    value={value}
                />
            </PopoverContent>
        </Popover>
    );
};
