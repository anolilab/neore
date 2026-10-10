"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ColumnDef, RowData, TableMeta } from "@tanstack/react-table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@ui/components/dropdown-menu";
import { useAsRef } from "@ui/hooks/use-as-ref";
import { parseCellKey } from "@ui/lib/data-grid";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import type { ContextMenuState, UpdateCell } from "@ui/types/data-grid";
import { CopyIcon, EraserIcon, ScissorsIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

interface DataGridContextMenuProps<TData extends RowData> {
    columns: ReadonlyArray<ColumnDef<DataGridFeatures, TData>>;
    contextMenu: ContextMenuState;
    tableMeta: TableMeta<DataGridFeatures, TData>;
}

const DataGridContextMenu = <TData extends RowData>({ columns, contextMenu, tableMeta }: DataGridContextMenuProps<TData>) => {
    if (!contextMenu.open) {
        return null;
    }

    const onContextMenuOpenChange = tableMeta?.onContextMenuOpenChange;
    const selectionState = tableMeta?.selectionState;
    const dataGridRef = tableMeta?.dataGridRef;
    const onDataUpdate = tableMeta?.onDataUpdate;
    const onRowsDelete = tableMeta?.onRowsDelete;
    const onCellsCopy = tableMeta?.onCellsCopy;
    const onCellsCut = tableMeta?.onCellsCut;

    return (
        <ContextMenu
            columns={columns}
            contextMenu={contextMenu}
            dataGridRef={dataGridRef}
            onCellsCopy={onCellsCopy}
            onCellsCut={onCellsCut}
            onContextMenuOpenChange={onContextMenuOpenChange}
            onDataUpdate={onDataUpdate}
            onRowsDelete={onRowsDelete}
            selectionState={selectionState}
            tableMeta={tableMeta}
        />
    );
};

interface ContextMenuProps<TData extends RowData>
    extends
        Pick<
            TableMeta<DataGridFeatures, TData>,
            "dataGridRef" | "onContextMenuOpenChange" | "selectionState" | "onDataUpdate" | "onRowsDelete" | "onCellsCopy" | "onCellsCut" | "readOnly"
        >,
        Required<Pick<TableMeta<DataGridFeatures, TData>, "contextMenu">> {
    columns: ReadonlyArray<ColumnDef<DataGridFeatures, TData>>;
    tableMeta: TableMeta<DataGridFeatures, TData>;
}

const ContextMenu = React.memo(ContextMenuImpl, (prev, next) => {
    if (prev.contextMenu.open !== next.contextMenu.open) {
        return false;
    }

    if (!next.contextMenu.open) {
        return true;
    }

    if (prev.contextMenu.x !== next.contextMenu.x) {
        return false;
    }

    if (prev.contextMenu.y !== next.contextMenu.y) {
        return false;
    }

    const prevSize = prev.selectionState?.selectedCells?.size ?? 0;
    const nextSize = next.selectionState?.selectedCells?.size ?? 0;

    return prevSize === nextSize;
}) as typeof ContextMenuImpl;

function ContextMenuImpl<TData extends RowData>({
    columns,
    contextMenu,
    dataGridRef,
    onCellsCopy,
    onCellsCut,
    onContextMenuOpenChange,
    onDataUpdate,
    onRowsDelete,
    selectionState,
    tableMeta,
}: ContextMenuProps<TData>) {
    const { t } = useLingui();
    const propsRef = useAsRef({
        columns,
        dataGridRef,
        onCellsCopy,
        onCellsCut,
        onDataUpdate,
        onRowsDelete,
        selectionState,
    });

    const triggerStyle = React.useMemo<React.CSSProperties>(() => {
        return {
            background: "transparent",
            border: "none",
            height: "1px",
            left: `${contextMenu.x}px`,
            margin: 0,
            opacity: 0,
            padding: 0,
            pointerEvents: "none",
            position: "fixed",
            top: `${contextMenu.y}px`,
            width: "1px",
        };
    }, [contextMenu.x, contextMenu.y]);

    const onCloseAutoFocus: NonNullable<React.ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"]> = React.useCallback(
        (event) => {
            event.preventDefault();
            propsRef.current.dataGridRef?.current?.focus();
        },
        [propsRef],
    );

    const onCopy = React.useCallback(() => {
        propsRef.current.onCellsCopy?.();
    }, [propsRef]);

    const onCut = React.useCallback(() => {
        propsRef.current.onCellsCut?.();
    }, [propsRef]);

    const onClear = React.useCallback(() => {
        const { columns: currentColumns, onDataUpdate: currentOnDataUpdate, selectionState: currentSelectionState } = propsRef.current;

        if (!currentSelectionState?.selectedCells || currentSelectionState.selectedCells.size === 0) {
            return;
        }

        const updates: UpdateCell[] = [];

        for (const cellKey of currentSelectionState.selectedCells) {
            const { columnId, rowIndex } = parseCellKey(cellKey);

            // Get column from columns array
            const column = currentColumns.find((col) => {
                if (col.id) {
                    return col.id === columnId;
                }

                if ("accessorKey" in col) {
                    return col.accessorKey === columnId;
                }

                return false;
            });
            const cellVariant = column?.meta?.cell?.variant;

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
                // no default
            }

            updates.push({ columnId, rowIndex, value: emptyValue });
        }

        currentOnDataUpdate?.(updates);

        const count = updates.length;

        // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
        toast.success(t`${plural(count, { one: "# cell cleared", other: "# cells cleared" })}`);
    }, [propsRef, t]);

    const onDelete = React.useCallback(async () => {
        const { onRowsDelete: currentOnRowsDelete, selectionState: currentSelectionState } = propsRef.current;

        if (!currentSelectionState?.selectedCells || currentSelectionState.selectedCells.size === 0) {
            return;
        }

        const rowIndices = new Set<number>();

        for (const cellKey of currentSelectionState.selectedCells) {
            const { rowIndex } = parseCellKey(cellKey);

            rowIndices.add(rowIndex);
        }

        const rowIndicesArray = [...rowIndices];

        rowIndicesArray.sort((a, b) => a - b);
        const rowCount = rowIndicesArray.length;

        await currentOnRowsDelete?.(rowIndicesArray);

        // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
        toast.success(t`${plural(rowCount, { one: "# row deleted", other: "# rows deleted" })}`);
    }, [propsRef, t]);

    return (
        <DropdownMenu onOpenChange={onContextMenuOpenChange} open={contextMenu.open}>
            <DropdownMenuTrigger style={triggerStyle} />
            <DropdownMenuContent align="start" className="w-48" data-grid-popover="" onCloseAutoFocus={onCloseAutoFocus}>
                <DropdownMenuItem onSelect={onCopy}>
                    <CopyIcon />
                    {t`Copy`}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={tableMeta?.readOnly} onSelect={onCut}>
                    <ScissorsIcon />
                    {t`Cut`}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={tableMeta?.readOnly} onSelect={onClear}>
                    <EraserIcon />
                    {t`Clear`}
                </DropdownMenuItem>
                {onRowsDelete && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={onDelete} variant="destructive">
                            <Trash2Icon />
                            {t`Delete rows`}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export default DataGridContextMenu;
