"use client";

import type { RowData } from "@tanstack/react-table";
import { useComposedRefs } from "@ui/lib/compose-refs";
import { getCellKey } from "@ui/lib/data-grid";
import type { DataGridCellProps } from "@ui/types/data-grid";
import cn from "@ui/utils/cn";
import * as React from "react";

// Keys the grid itself steers on; a cell hands them straight back.
const GRID_NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp", "Tab"]);

interface DataGridCellWrapperProps<TData extends RowData> extends React.ComponentProps<"div">, DataGridCellProps<TData> {}

const DataGridCellWrapper = <TData extends RowData>({
    className,
    columnId,
    isActiveSearchMatch,
    isEditing,
    isFocused,
    isSearchMatch,
    isSelected,
    onClick: onClickProp,
    onKeyDown: onKeyDownProp,
    readOnly,
    ref,
    rowHeight,
    rowIndex,
    tableMeta,
    ...props
}: DataGridCellWrapperProps<TData>) => {
    const cellMapRef = tableMeta?.cellMapRef;

    const onCellChange = React.useCallback(
        (node: HTMLDivElement | null) => {
            if (!cellMapRef) {
                return;
            }

            const cellKey = getCellKey(rowIndex, columnId);

            if (node) {
                cellMapRef.current.set(cellKey, node);
            } else {
                cellMapRef.current.delete(cellKey);
            }
        },
        [rowIndex, columnId, cellMapRef],
    );

    const composedRef = useComposedRefs(ref, onCellChange);

    const onClick = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (isEditing) {
                return;
            }

            event.preventDefault();
            onClickProp?.(event);

            if (isFocused && !readOnly) {
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else {
                tableMeta?.onCellClick?.(rowIndex, columnId, event);
            }
        },
        [tableMeta, rowIndex, columnId, isEditing, isFocused, readOnly, onClickProp],
    );

    const onContextMenu = React.useCallback(
        (event: React.MouseEvent) => {
            if (!isEditing) {
                tableMeta?.onCellContextMenu?.(rowIndex, columnId, event);
            }
        },
        [tableMeta, rowIndex, columnId, isEditing],
    );

    const onDoubleClick = React.useCallback(
        (event: React.MouseEvent) => {
            if (isEditing) {
                return;
            }

            event.preventDefault();
            tableMeta?.onCellDoubleClick?.(rowIndex, columnId);
        },
        [tableMeta, rowIndex, columnId, isEditing],
    );

    const onKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            onKeyDownProp?.(event);

            if (event.defaultPrevented) {
                return;
            }

            if (GRID_NAVIGATION_KEYS.has(event.key)) {
                return;
            }

            if (isFocused && !isEditing && !readOnly) {
                if (event.key === "F2" || event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    tableMeta?.onCellEditingStart?.(rowIndex, columnId);

                    return;
                }

                if (event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    tableMeta?.onCellEditingStart?.(rowIndex, columnId);

                    return;
                }

                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    tableMeta?.onCellEditingStart?.(rowIndex, columnId);
                }
            }
        },
        [onKeyDownProp, isFocused, isEditing, readOnly, tableMeta, rowIndex, columnId],
    );

    const onMouseDown = React.useCallback(
        (event: React.MouseEvent) => {
            if (!isEditing) {
                tableMeta?.onCellMouseDown?.(rowIndex, columnId, event);
            }
        },
        [tableMeta, rowIndex, columnId, isEditing],
    );

    const onMouseEnter = React.useCallback(
        (event: React.MouseEvent) => {
            if (!isEditing) {
                tableMeta?.onCellMouseEnter?.(rowIndex, columnId, event);
            }
        },
        [tableMeta, rowIndex, columnId, isEditing],
    );

    const onMouseUp = React.useCallback(() => {
        if (!isEditing) {
            tableMeta?.onCellMouseUp?.();
        }
    }, [tableMeta, isEditing]);

    return (
        <div
            data-editing={isEditing ? "" : undefined}
            data-focused={isFocused ? "" : undefined}
            data-selected={isSelected ? "" : undefined}
            data-slot="grid-cell-wrapper"
            role="button"
            tabIndex={isFocused && !isEditing ? 0 : -1}
            {...props}
            className={cn(
                "size-full px-2 py-1.5 text-start text-sm outline-none has-data-[slot=checkbox]:pt-2.5",
                {
                    "**:data-[slot=grid-cell-content]:line-clamp-1": !isEditing && rowHeight === "short",
                    "**:data-[slot=grid-cell-content]:line-clamp-2": !isEditing && rowHeight === "medium",
                    "**:data-[slot=grid-cell-content]:line-clamp-3": !isEditing && rowHeight === "tall",
                    "**:data-[slot=grid-cell-content]:line-clamp-4": !isEditing && rowHeight === "extra-tall",
                    "bg-orange-200 dark:bg-orange-900/50": isActiveSearchMatch,
                    "bg-primary/10": isSelected && !isEditing,
                    "bg-yellow-100 dark:bg-yellow-900/30": isSearchMatch && !isActiveSearchMatch,
                    "cursor-default": !isEditing,
                    "ring-ring ring-1 ring-inset": isFocused,
                },
                className,
            )}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
            onMouseDown={onMouseDown}
            onMouseEnter={onMouseEnter}
            onMouseUp={onMouseUp}
            ref={composedRef}
        />
    );
};

export default DataGridCellWrapper;
