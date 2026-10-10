"use client";

import { useLingui } from "@lingui/react/macro";
import type { RowData } from "@tanstack/react-table";
import DataGridColumnHeader from "@ui/components/data-grid/data-grid-column-header";
import DataGridContextMenu from "@ui/components/data-grid/data-grid-context-menu";
import DataGridPasteDialog from "@ui/components/data-grid/data-grid-paste-dialog";
import DataGridRow from "@ui/components/data-grid/data-grid-row";
import DataGridSearch from "@ui/components/data-grid/data-grid-search";
import { useAsRef } from "@ui/hooks/use-as-ref";
import type { useDataGrid } from "@ui/hooks/use-data-grid";
import { flexRender, getCommonPinningStyles } from "@ui/lib/data-grid";
import type { Direction } from "@ui/types/data-grid";
import cn from "@ui/utils/cn";
import { Plus } from "lucide-react";
import * as React from "react";

const EMPTY_CELL_SELECTION_SET = new Set<string>();

const getAriaSort = (desc: boolean | undefined, isSortable: boolean): "ascending" | "descending" | "none" | undefined => {
    if (desc === false) {
        return "ascending";
    }

    if (desc === true) {
        return "descending";
    }

    return isSortable ? "none" : undefined;
};

interface DataGridProps<TData extends RowData> extends Omit<ReturnType<typeof useDataGrid<TData>>, "dir">, Omit<React.ComponentProps<"div">, "contextMenu"> {
    dir?: Direction;
    height?: number;
    stretchColumns?: boolean;
}

const DataGrid = <TData extends RowData>({
    activeSearchMatch,
    cellSelectionMap,
    className,
    columns,
    columnSizeVars,
    contextMenu,
    dataGridRef,
    dir: direction = "ltr",
    editingCell,
    focusedCell,
    footerRef,
    headerRef,
    height = 600,
    measureElement,
    onRowAdd: onRowAddProp,
    pasteDialog,
    rowHeight,
    rowMapRef,
    searchMatchesByRow,
    searchState,
    stretchColumns = false,
    table,
    tableMeta,
    virtualItems,
    virtualTotalSize,
    ...props
}: DataGridProps<TData>) => {
    const { t } = useLingui();
    const { rows } = table.getRowModel();
    const readOnly = tableMeta?.readOnly ?? false;
    const { columnVisibility } = table.store.state;
    const { columnPinning } = table.store.state;

    const onRowAddRef = useAsRef(onRowAddProp);

    const onRowAdd = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            onRowAddRef.current?.(event);
        },
        [onRowAddRef],
    );

    const onDataGridContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
    }, []);

    const onFooterCellKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (!onRowAddRef.current) {
                return;
            }

            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onRowAddRef.current();
            }
        },
        [onRowAddRef],
    );

    return (
        <div data-slot="grid-wrapper" dir={direction} {...props} className={cn("relative flex w-full flex-col", className)}>
            {searchState && <DataGridSearch {...searchState} />}
            <DataGridContextMenu columns={columns} contextMenu={contextMenu} tableMeta={tableMeta} />
            <DataGridPasteDialog pasteDialog={pasteDialog} tableMeta={tableMeta} />
            <div
                aria-colcount={columns.length}
                aria-label={t`Data grid`}
                aria-rowcount={rows.length + (onRowAddProp ? 1 : 0)}
                className="relative grid overflow-auto rounded-md border select-none focus:outline-none"
                data-slot="grid"
                onContextMenu={onDataGridContextMenu}
                ref={dataGridRef}
                role="grid"
                style={{
                    ...columnSizeVars,
                    maxHeight: `${height}px`,
                }}
                tabIndex={0}
            >
                <div className="bg-background sticky top-0 z-10 grid border-b" data-slot="grid-header" ref={headerRef} role="rowgroup">
                    {table.getHeaderGroups().map((headerGroup, rowIndex) => (
                        <div aria-rowindex={rowIndex + 1} className="flex w-full" data-slot="grid-header-row" key={headerGroup.id} role="row" tabIndex={-1}>
                            {headerGroup.headers.map((header, colIndex) => {
                                const { sorting } = table.store.state;
                                const currentSort = sorting.find((sort) => sort.id === header.column.id);
                                const isSortable = header.column.getCanSort();

                                return (
                                    <div
                                        aria-colindex={colIndex + 1}
                                        aria-sort={getAriaSort(currentSort?.desc, isSortable)}
                                        className={cn("relative", {
                                            "border-e": header.column.id !== "select",
                                            grow: stretchColumns && header.column.id !== "select",
                                        })}
                                        data-slot="grid-header-cell"
                                        key={header.id}
                                        role="columnheader"
                                        style={{
                                            ...getCommonPinningStyles({ column: header.column, dir: direction }),
                                            width: `calc(var(--header-${header.id}-size) * 1px)`,
                                        }}
                                        tabIndex={-1}
                                    >
                                        {!header.isPlaceholder &&
                                            (typeof header.column.columnDef.header === "function" ? (
                                                <div className="size-full px-3 py-1.5">{flexRender(header.column.columnDef.header, header.getContext())}</div>
                                            ) : (
                                                <DataGridColumnHeader header={header} table={table} />
                                            ))}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
                <div
                    className="relative grid"
                    data-slot="grid-body"
                    role="rowgroup"
                    style={{
                        contain: "strict",
                        height: `${virtualTotalSize}px`,
                    }}
                >
                    {virtualItems.map((virtualItem) => {
                        const row = rows[virtualItem.index];

                        if (!row) {
                            return null;
                        }

                        const cellSelectionKeys = cellSelectionMap?.get(virtualItem.index) ?? EMPTY_CELL_SELECTION_SET;

                        const searchMatchColumns = searchMatchesByRow?.get(virtualItem.index) ?? null;
                        const isActiveSearchRow = activeSearchMatch?.rowIndex === virtualItem.index;

                        return (
                            <DataGridRow
                                activeSearchMatch={isActiveSearchRow ? activeSearchMatch : null}
                                cellSelectionKeys={cellSelectionKeys}
                                columnPinning={columnPinning}
                                columnVisibility={columnVisibility}
                                dir={direction}
                                editingCell={editingCell}
                                focusedCell={focusedCell}
                                key={row.id}
                                measureElement={measureElement}
                                readOnly={readOnly}
                                row={row}
                                rowHeight={rowHeight}
                                rowMapRef={rowMapRef}
                                searchMatchColumns={searchMatchColumns}
                                stretchColumns={stretchColumns}
                                tableMeta={tableMeta}
                                virtualItem={virtualItem}
                            />
                        );
                    })}
                </div>
                {/* The prop, not the stable `onRowAdd` wrapper (always truthy): no handler, no "add row" footer — as `aria-rowcount` already assumes. */}
                {!readOnly && onRowAddProp && (
                    <div className="bg-background sticky bottom-0 z-10 grid border-t" data-slot="grid-footer" ref={footerRef} role="rowgroup">
                        <div aria-rowindex={rows.length + 2} className="flex w-full" data-slot="grid-add-row" role="row" tabIndex={-1}>
                            <div
                                aria-label={t`Add row`}
                                className="bg-muted/30 hover:bg-muted/50 focus:bg-muted/50 relative flex h-9 grow items-center transition-colors focus:outline-none"
                                onClick={onRowAdd}
                                onKeyDown={onFooterCellKeyDown}
                                role="gridcell"
                                style={{
                                    minWidth: table.getTotalSize(),
                                    width: table.getTotalSize(),
                                }}
                                tabIndex={0}
                            >
                                <div className="text-muted-foreground sticky start-0 flex items-center gap-2 px-3">
                                    <Plus aria-hidden="true" className="size-3.5" />
                                    <span className="text-sm">{t`Add row`}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default DataGrid;
