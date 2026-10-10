"use client";

import { useDirection } from "@base-ui/react/direction-provider";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ColumnSort, RowData, Table } from "@tanstack/react-table";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Sortable, SortableContent, SortableItem, SortableItemHandle, SortableOverlay } from "@ui/components/ui/sortable";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import cn from "@ui/utils/cn";
import { ArrowDownUp, ChevronsUpDown, GripVertical, Trash2 } from "lucide-react";
import * as React from "react";

const SORT_SHORTCUT_KEY = "s";
const REMOVE_SORT_SHORTCUTS = new Set(["backspace", "delete"]);

const SORT_ORDERS: { label: MessageDescriptor; value: string }[] = [
    { label: msg`Asc`, value: "asc" },
    { label: msg`Desc`, value: "desc" },
];

interface DataGridSortMenuProps<TData extends RowData> extends React.ComponentProps<typeof PopoverContent> {
    disabled?: boolean;
    table: Table<DataGridFeatures, TData>;
}

const DataGridSortMenu = <TData extends RowData>({ disabled, table, ...props }: DataGridSortMenuProps<TData>) => {
    const { t } = useLingui();
    const direction = useDirection();
    const id = React.useId();
    const labelId = React.useId();
    const descriptionId = React.useId();
    const [open, setOpen] = React.useState(false);
    const addButtonRef = React.useRef<HTMLButtonElement>(null);

    const { sorting } = table.store.state;
    const onSortingChange = table.setSorting;

    const { columnLabels, columns } = React.useMemo(() => {
        const labels = new Map<string, string>();
        const sortingIds = new Set(sorting.map((s) => s.id));
        const availableColumns: { id: string; label: string }[] = [];

        for (const column of table.getAllColumns()) {
            if (!column.getCanSort()) {
                continue;
            }

            const label = column.columnDef.meta?.label ?? column.id;

            labels.set(column.id, label);

            if (!sortingIds.has(column.id)) {
                availableColumns.push({ id: column.id, label });
            }
        }

        return {
            columnLabels: labels,
            columns: availableColumns,
        };
    }, [sorting, table]);

    const onSortAdd = React.useCallback(() => {
        const firstColumn = columns[0];

        if (!firstColumn) {
            return;
        }

        onSortingChange((prevSorting) => [...prevSorting, { desc: false, id: firstColumn.id }]);
    }, [columns, onSortingChange]);

    const onSortUpdate = React.useCallback(
        (sortId: string, updates: Partial<ColumnSort>) => {
            onSortingChange((prevSorting) => {
                if (!prevSorting) {
                    return prevSorting;
                }

                return prevSorting.map((sort) => (sort.id === sortId ? { ...sort, ...updates } : sort));
            });
        },
        [onSortingChange],
    );

    const onSortRemove = React.useCallback(
        (sortId: string) => {
            onSortingChange((prevSorting) => prevSorting.filter((item) => item.id !== sortId));
        },
        [onSortingChange],
    );

    const onSortingReset = React.useCallback(() => onSortingChange(table.initialState.sorting), [onSortingChange, table.initialState.sorting]);

    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                event.target instanceof HTMLInputElement ||
                event.target instanceof HTMLTextAreaElement ||
                (event.target instanceof HTMLElement && event.target.contentEditable === "true")
            ) {
                return;
            }

            if (event.key.toLowerCase() === SORT_SHORTCUT_KEY && (event.ctrlKey || event.metaKey) && event.shiftKey) {
                event.preventDefault();
                setOpen((prev) => !prev);
            }
        };

        globalThis.addEventListener("keydown", onKeyDown);

        return () => globalThis.removeEventListener("keydown", onKeyDown);
    }, []);

    const onTriggerKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLButtonElement>) => {
            if (!(REMOVE_SORT_SHORTCUTS.has(event.key.toLowerCase()) && sorting.length > 0)) {
                return;
            }

            event.preventDefault();
            onSortingReset();
        },
        [sorting.length, onSortingReset],
    );

    return (
        <Sortable getItemValue={(item) => item.id} onValueChange={onSortingChange} value={sorting}>
            <Popover onOpenChange={setOpen} open={open}>
                <PopoverTrigger
                    render={<Button className="font-normal" dir={direction} disabled={disabled} onKeyDown={onTriggerKeyDown} size="sm" variant="outline" />}
                >
                    <ArrowDownUp aria-hidden="true" className="text-muted-foreground" />
                    {t`Sort`}
                    {sorting.length > 0 && (
                        <Badge className="h-[18.24px] rounded-[3.2px] px-[5.12px] font-mono text-[10.4px] font-normal" variant="secondary">
                            {sorting.length}
                        </Badge>
                    )}
                </PopoverTrigger>
                <PopoverContent
                    aria-describedby={descriptionId}
                    aria-labelledby={labelId}
                    className="flex w-full max-w-(--radix-popover-content-available-width) flex-col gap-3.5 p-4 sm:min-w-[380px]"
                    dir={direction}
                    {...props}
                >
                    <div className="flex flex-col gap-1">
                        <h4 className="leading-none font-medium" id={labelId}>
                            {sorting.length > 0 ? t`Sort by` : t`No sorting applied`}
                        </h4>
                        <p className={cn("text-muted-foreground text-sm", sorting.length > 0 && "sr-only")} id={descriptionId}>
                            {sorting.length > 0 ? t`Modify sorting to organize your rows.` : t`Add sorting to organize your rows.`}
                        </p>
                    </div>
                    {sorting.length > 0 && (
                        <SortableContent render={<div className="flex max-h-[300px] flex-col gap-2 overflow-y-auto p-1" role="list" />}>
                            {sorting.map((sort) => (
                                <DataTableSortItem
                                    columnLabels={columnLabels}
                                    columns={columns}
                                    dir={direction}
                                    key={sort.id}
                                    onSortRemove={onSortRemove}
                                    onSortUpdate={onSortUpdate}
                                    sort={sort}
                                    sortItemId={`${id}-sort-${sort.id}`}
                                />
                            ))}
                        </SortableContent>
                    )}
                    <div className="flex w-full items-center gap-2">
                        <Button className="rounded" disabled={columns.length === 0} onClick={onSortAdd} ref={addButtonRef} size="sm">
                            {t`Add sort`}
                        </Button>
                        {sorting.length > 0 && (
                            <Button className="rounded" onClick={onSortingReset} size="sm" variant="outline">
                                {t`Reset sorting`}
                            </Button>
                        )}
                    </div>
                </PopoverContent>
            </Popover>
            <SortableOverlay>
                <div className="flex items-center gap-2" dir={direction}>
                    <div className="bg-primary/10 h-8 w-44 rounded-sm" />
                    <div className="bg-primary/10 h-8 w-24 rounded-sm" />
                    <div className="bg-primary/10 size-8 shrink-0 rounded-sm" />
                    <div className="bg-primary/10 size-8 shrink-0 rounded-sm" />
                </div>
            </SortableOverlay>
        </Sortable>
    );
};

interface DataTableSortItemProps {
    columnLabels: Map<string, string>;
    columns: { id: string; label: string }[];
    dir: "ltr" | "rtl";
    onSortRemove: (sortId: string) => void;
    onSortUpdate: (sortId: string, updates: Partial<ColumnSort>) => void;
    sort: ColumnSort;
    sortItemId: string;
}

const DataTableSortItem = ({ columnLabels, columns, dir, onSortRemove, onSortUpdate, sort, sortItemId }: DataTableSortItemProps) => {
    const { i18n, t } = useLingui();
    const fieldListboxId = `${sortItemId}-field-listbox`;
    const fieldTriggerId = `${sortItemId}-field-trigger`;
    const directionListboxId = `${sortItemId}-direction-listbox`;

    const [showFieldSelector, setShowFieldSelector] = React.useState(false);
    const [showDirectionSelector, setShowDirectionSelector] = React.useState(false);

    const onItemKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
                return;
            }

            if (showFieldSelector || showDirectionSelector) {
                return;
            }

            if (REMOVE_SORT_SHORTCUTS.has(event.key.toLowerCase())) {
                event.preventDefault();
                onSortRemove(sort.id);
            }
        },
        [sort.id, showFieldSelector, showDirectionSelector, onSortRemove],
    );

    return (
        <SortableItem
            render={<div className="flex items-center gap-2" id={sortItemId} onKeyDown={onItemKeyDown} role="listitem" tabIndex={-1} />}
            value={sort.id}
        >
            <Popover onOpenChange={setShowFieldSelector} open={showFieldSelector}>
                <PopoverTrigger
                    render={
                        <Button
                            aria-controls={fieldListboxId}
                            className="w-44 justify-between rounded font-normal"
                            id={fieldTriggerId}
                            size="sm"
                            variant="outline"
                        >
                            <span className="truncate">{columnLabels.get(sort.id)}</span>
                            <ChevronsUpDown className="opacity-50" />
                        </Button>
                    }
                />
                <PopoverContent className="w-(--radix-popover-trigger-width) p-0" dir={dir} id={fieldListboxId}>
                    <Command>
                        <CommandInput placeholder={t`Search fields...`} />
                        <CommandList>
                            <CommandEmpty>{t`No fields found.`}</CommandEmpty>
                            <CommandGroup>
                                {columns.map((column) => (
                                    <CommandItem key={column.id} onSelect={() => onSortUpdate(sort.id, { id: column.id })} value={column.id}>
                                        <span className="truncate">{column.label}</span>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
            <Select
                onOpenChange={setShowDirectionSelector}
                onValueChange={(value) => onSortUpdate(sort.id, { desc: value === "desc" })}
                open={showDirectionSelector}
                value={sort.desc ? "desc" : "asc"}
            >
                <SelectTrigger aria-controls={directionListboxId} className="w-24 rounded" size="sm">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="min-w-(--radix-select-trigger-width)" id={directionListboxId}>
                    {SORT_ORDERS.map((order) => (
                        <SelectItem key={order.value} value={order.value}>
                            {i18n._(order.label)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <Button
                aria-controls={sortItemId}
                aria-label={t`Remove sort`}
                className="size-8 shrink-0 rounded"
                onClick={() => onSortRemove(sort.id)}
                size="icon"
                variant="outline"
            >
                <Trash2 aria-hidden="true" />
            </Button>
            <SortableItemHandle
                render={
                    <Button aria-label={t`Reorder sort`} className="size-8 shrink-0 rounded" size="icon" variant="outline">
                        <GripVertical aria-hidden="true" />
                    </Button>
                }
            />
        </SortableItem>
    );
};

export default DataGridSortMenu;
