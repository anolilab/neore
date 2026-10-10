"use client";

import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { RowData, Table } from "@tanstack/react-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import { AlignVerticalSpaceAroundIcon, ChevronsDownUpIcon, EqualIcon, MinusIcon } from "lucide-react";
import * as React from "react";

const rowHeights = [
    {
        icon: MinusIcon,
        label: msg`Short`,
        value: "short" as const,
    },
    {
        icon: EqualIcon,
        label: msg`Medium`,
        value: "medium" as const,
    },
    {
        icon: AlignVerticalSpaceAroundIcon,
        label: msg`Tall`,
        value: "tall" as const,
    },
    {
        icon: ChevronsDownUpIcon,
        label: msg`Extra Tall`,
        value: "extra-tall" as const,
    },
] as const;

interface DataGridRowHeightMenuProps<TData extends RowData> extends React.ComponentProps<typeof SelectContent> {
    disabled?: boolean;
    table: Table<DataGridFeatures, TData>;
}

const DataGridRowHeightMenu = <TData extends RowData>({ disabled, table, ...props }: DataGridRowHeightMenuProps<TData>) => {
    const { i18n, t } = useLingui();
    const rowHeight = table.options.meta?.rowHeight;
    const onRowHeightChange = table.options.meta?.onRowHeightChange;

    const selectedRowHeight = React.useMemo(() => rowHeights.find((opt) => opt.value === rowHeight) ?? rowHeights[0], [rowHeight]);

    return (
        <Select
            disabled={disabled}
            onValueChange={(value) => {
                if (value !== null) {
                    onRowHeightChange?.(value);
                }
            }}
            value={rowHeight}
        >
            <SelectTrigger className="[&_svg:nth-child(2)]:hidden" size="sm">
                <SelectValue placeholder={t`Row height`}>
                    <selectedRowHeight.icon aria-hidden="true" />
                    {i18n._(selectedRowHeight.label)}
                </SelectValue>
            </SelectTrigger>
            <SelectContent {...props}>
                {rowHeights.map((option) => {
                    const OptionIcon = option.icon;

                    return (
                        <SelectItem key={option.value} value={option.value}>
                            <OptionIcon aria-hidden="true" className="size-4" />
                            {i18n._(option.label)}
                        </SelectItem>
                    );
                })}
            </SelectContent>
        </Select>
    );
};

export default DataGridRowHeightMenu;
