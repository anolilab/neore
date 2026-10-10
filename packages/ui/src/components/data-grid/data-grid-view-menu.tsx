"use client";

import { useDirection } from "@base-ui/react/direction-provider";
import { useLingui } from "@lingui/react/macro";
import type { RowData, Table } from "@tanstack/react-table";
import { Button } from "@ui/components/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import cn from "@ui/utils/cn";
import { Check, Settings2 } from "lucide-react";
import * as React from "react";

interface DataGridViewMenuProps<TData extends RowData> extends React.ComponentProps<typeof PopoverContent> {
    disabled?: boolean;
    table: Table<DataGridFeatures, TData>;
}

const DataGridViewMenu = <TData extends RowData>({ className, disabled, table, ...props }: DataGridViewMenuProps<TData>) => {
    const { t } = useLingui();
    const direction = useDirection();

    const columns = React.useMemo(() => table.getAllColumns().filter((column) => column.accessorFn !== undefined && column.getCanHide()), [table]);

    return (
        <Popover>
            <PopoverTrigger
                render={
                    <Button
                        aria-label={t`Toggle columns`}
                        className="ms-auto hidden h-8 font-normal lg:flex"
                        dir={direction}
                        disabled={disabled}
                        role="combobox"
                        size="sm"
                        variant="outline"
                    />
                }
            >
                <Settings2 aria-hidden="true" className="text-muted-foreground" />
                {t`View`}
            </PopoverTrigger>
            <PopoverContent className={cn("w-44 p-0", className)} dir={direction} {...props}>
                <Command>
                    <CommandInput placeholder={t`Search columns...`} />
                    <CommandList>
                        <CommandEmpty>{t`No columns found.`}</CommandEmpty>
                        <CommandGroup>
                            {columns.map((column) => (
                                <CommandItem key={column.id} onSelect={() => column.toggleVisibility(!column.getIsVisible())}>
                                    <span className="truncate">{column.columnDef.meta?.label ?? column.id}</span>
                                    <Check className={cn("ms-auto size-4 shrink-0", column.getIsVisible() ? "opacity-100" : "opacity-0")} />
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};

export default DataGridViewMenu;
