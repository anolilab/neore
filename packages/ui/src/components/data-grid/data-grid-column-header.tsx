"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ColumnSort, Header, RowData, SortDirection, SortingState, Table } from "@tanstack/react-table";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import { getColumnVariant } from "@ui/lib/data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import cn from "@ui/utils/cn";
import { ChevronDownIcon, ChevronUpIcon, EyeOffIcon, PinIcon, PinOffIcon, XIcon } from "lucide-react";
import * as React from "react";

/** Display names of the cell variants; `getColumnVariant`'s English `label` stays the data-layer name. */
const COLUMN_VARIANT_LABELS: Record<string, MessageDescriptor> = {
    checkbox: msg`Checkbox`,
    date: msg`Date`,
    file: msg`File`,
    "long-text": msg`Long text`,
    "multi-select": msg`Multi-select`,
    number: msg`Number`,
    select: msg`Select`,
    "short-text": msg`Short text`,
    url: msg`URL`,
};

interface DataGridColumnHeaderProps<TData extends RowData, TValue> extends React.ComponentProps<typeof DropdownMenuTrigger> {
    header: Header<DataGridFeatures, TData, TValue>;
    table: Table<DataGridFeatures, TData>;
}

const DataGridColumnHeader = <TData extends RowData, TValue>({
    className,
    header,
    onPointerDown,
    table,
    ...props
}: DataGridColumnHeaderProps<TData, TValue>) => {
    const { i18n, t } = useLingui();
    const { column } = header;
    const fallbackLabel = typeof column.columnDef.header === "string" ? column.columnDef.header : column.id;
    const label = column.columnDef.meta?.label || fallbackLabel;

    const isAnyColumnResizing = table.store.state.columnResizing.isResizingColumn;

    const cellVariant = column.columnDef.meta?.cell;
    const columnVariant = getColumnVariant(cellVariant?.variant);
    const variantLabel = cellVariant?.variant ? COLUMN_VARIANT_LABELS[cellVariant.variant] : undefined;

    const pinnedPosition = column.getIsPinned();
    const isPinnedLeft = pinnedPosition === "start";
    const isPinnedRight = pinnedPosition === "end";

    const onSortingChange = React.useCallback(
        (direction: SortDirection) => {
            table.setSorting((prev: SortingState) => {
                const existingSortIndex = prev.findIndex((sort) => sort.id === column.id);
                const newSort: ColumnSort = {
                    desc: direction === "desc",
                    id: column.id,
                };

                if (existingSortIndex !== -1) {
                    const updated = [...prev];

                    updated[existingSortIndex] = newSort;

                    return updated;
                }

                return [...prev, newSort];
            });
        },
        [column.id, table],
    );

    const onSortRemove = React.useCallback(() => {
        table.setSorting((prev: SortingState) => prev.filter((sort) => sort.id !== column.id));
    }, [column.id, table]);

    const onLeftPin = React.useCallback(() => {
        column.pin("start");
    }, [column]);

    const onRightPin = React.useCallback(() => {
        column.pin("end");
    }, [column]);

    const onUnpin = React.useCallback(() => {
        column.pin(false);
    }, [column]);

    const onTriggerPointerDown = React.useCallback(
        (event: React.PointerEvent<HTMLButtonElement>) => {
            onPointerDown?.(event as any);

            if (event.defaultPrevented) {
                return;
            }

            if (event.button !== 0) {
                return;
            }

            table.options.meta?.onColumnClick?.(column.id);
        },
        [table.options.meta, column.id, onPointerDown],
    );

    return (
        <>
            <DropdownMenu modal={false}>
                <DropdownMenuTrigger
                    className={cn(
                        "hover:bg-accent/40 data-[state=open]:bg-accent/40 flex size-full items-center justify-between gap-2 p-2 text-sm [&_svg]:size-4",
                        isAnyColumnResizing && "pointer-events-none",
                        className,
                    )}
                    onPointerDown={onTriggerPointerDown}
                    {...props}
                >
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        {columnVariant && (
                            <Tooltip delayDuration={100}>
                                <TooltipTrigger render={<columnVariant.icon className="text-muted-foreground size-3.5 shrink-0" />} />
                                <TooltipContent side="top">
                                    <p>{variantLabel ? i18n._(variantLabel) : columnVariant.label}</p>
                                </TooltipContent>
                            </Tooltip>
                        )}
                        <span className="truncate">{label}</span>
                    </div>
                    <ChevronDownIcon aria-hidden="true" className="text-muted-foreground shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60" sideOffset={0}>
                    {column.getCanSort() && (
                        <>
                            <DropdownMenuCheckboxItem
                                checked={column.getIsSorted() === "asc"}
                                className="[&_svg]:text-muted-foreground relative ltr:pr-8 ltr:pl-2 rtl:pr-2 rtl:pl-8 [&>span:first-child]:ltr:right-2 [&>span:first-child]:ltr:left-auto [&>span:first-child]:rtl:right-auto [&>span:first-child]:rtl:left-2"
                                onClick={() => onSortingChange("asc")}
                            >
                                <ChevronUpIcon />
                                {t`Sort asc`}
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem
                                checked={column.getIsSorted() === "desc"}
                                className="[&_svg]:text-muted-foreground relative ltr:pr-8 ltr:pl-2 rtl:pr-2 rtl:pl-8 [&>span:first-child]:ltr:right-2 [&>span:first-child]:ltr:left-auto [&>span:first-child]:rtl:right-auto [&>span:first-child]:rtl:left-2"
                                onClick={() => onSortingChange("desc")}
                            >
                                <ChevronDownIcon />
                                {t`Sort desc`}
                            </DropdownMenuCheckboxItem>
                            {column.getIsSorted() && (
                                <DropdownMenuItem onClick={onSortRemove}>
                                    <XIcon />
                                    {t`Remove sort`}
                                </DropdownMenuItem>
                            )}
                        </>
                    )}
                    {column.getCanPin() && (
                        <>
                            {column.getCanSort() && <DropdownMenuSeparator />}

                            {isPinnedLeft ? (
                                <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={onUnpin}>
                                    <PinOffIcon />
                                    {t`Unpin from left`}
                                </DropdownMenuItem>
                            ) : (
                                <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={onLeftPin}>
                                    <PinIcon />
                                    {t`Pin to left`}
                                </DropdownMenuItem>
                            )}
                            {isPinnedRight ? (
                                <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={onUnpin}>
                                    <PinOffIcon />
                                    {t`Unpin from right`}
                                </DropdownMenuItem>
                            ) : (
                                <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={onRightPin}>
                                    <PinIcon />
                                    {t`Pin to right`}
                                </DropdownMenuItem>
                            )}
                        </>
                    )}
                    {column.getCanHide() && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="[&_svg]:text-muted-foreground" onClick={() => column.toggleVisibility(false)}>
                                <EyeOffIcon />
                                {t`Hide column`}
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {header.column.getCanResize() && <DataGridColumnResizer header={header} label={label} table={table} />}
        </>
    );
};

const DataGridColumnResizer = React.memo(DataGridColumnResizerImpl, (prev, next) => {
    const prevColumn = prev.header.column;
    const nextColumn = next.header.column;

    if (prevColumn.getIsResizing() !== nextColumn.getIsResizing() || prevColumn.getSize() !== nextColumn.getSize()) {
        return false;
    }

    if (prev.label !== next.label) {
        return false;
    }

    return true;
}) as typeof DataGridColumnResizerImpl;

interface DataGridColumnResizerProps<TData extends RowData, TValue> extends DataGridColumnHeaderProps<TData, TValue> {
    label: string;
}

function DataGridColumnResizerImpl<TData extends RowData, TValue>({ header, label, table }: DataGridColumnResizerProps<TData, TValue>) {
    const { t } = useLingui();
    const defaultColumnDefinition = table.getDefaultColumnDef();

    const onDoubleClick = React.useCallback(() => {
        header.column.resetSize();
    }, [header.column]);

    return (
        <div
            aria-label={t`Resize ${label} column`}
            aria-orientation="vertical"
            aria-valuemax={defaultColumnDefinition.maxSize}
            aria-valuemin={defaultColumnDefinition.minSize}
            aria-valuenow={header.column.getSize()}
            className={cn(
                "bg-border hover:bg-primary focus:bg-primary absolute -end-px top-0 z-50 h-full w-0.5 cursor-ew-resize touch-none transition-opacity select-none after:absolute after:inset-y-0 after:start-1/2 after:h-full after:w-[18px] after:-translate-x-1/2 after:content-[''] focus:outline-none",
                header.column.getIsResizing() ? "bg-primary" : "opacity-0 hover:opacity-100",
            )}
            onDoubleClick={onDoubleClick}
            onMouseDown={header.getResizeHandler()}
            onTouchStart={header.getResizeHandler()}
            role="separator"
            tabIndex={0}
        />
    );
}

export default DataGridColumnHeader;
