"use client";

import { useLingui } from "@lingui/react/macro";
import type { RowData } from "@tanstack/react-table";
import { Badge } from "@ui/components/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@ui/components/command";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import { Popover, PopoverAnchor, PopoverContent } from "@ui/components/popover";
import { useBadgeOverflow } from "@ui/hooks/use-badge-overflow";
import { getCellKey, getLineCount } from "@ui/lib/data-grid";
import type { DataGridCellProps } from "@ui/types/data-grid";
import cn from "@ui/utils/cn";
import { Check, X } from "lucide-react";
import * as React from "react";

export const MultiSelectCell = <TData extends RowData>({
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
    const cellValue = React.useMemo(() => {
        const value = cell.getValue() as string[];

        return value ?? [];
    }, [cell]);

    const cellKey = getCellKey(rowIndex, columnId);
    const [prevCellKey, setPrevCellKey] = React.useState(cellKey);

    const [selectedValues, setSelectedValues] = React.useState<string[]>(cellValue);
    const [searchValue, setSearchValue] = React.useState("");
    const containerRef = React.useRef<HTMLDivElement>(null);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const cellOptions = cell.column.columnDef.meta?.cell;
    const options = cellOptions?.variant === "multi-select" ? cellOptions.options : [];
    const sideOffset = -(containerRef.current?.clientHeight ?? 0);

    const [prevCellValue, setPrevCellValue] = React.useState(cellValue);

    if (cellValue !== prevCellValue) {
        setPrevCellValue(cellValue);
        setSelectedValues(cellValue);
    }

    if (prevCellKey !== cellKey) {
        setPrevCellKey(cellKey);
        setSearchValue("");
    }

    const onValueChange = React.useCallback(
        (value: string) => {
            if (readOnly) {
                return;
            }

            const newValues = selectedValues.includes(value) ? selectedValues.filter((v) => v !== value) : [...selectedValues, value];

            setSelectedValues(newValues);
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: newValues });
            setSearchValue("");
            queueMicrotask(() => inputRef.current?.focus());
        },
        [selectedValues, tableMeta, rowIndex, columnId, readOnly],
    );

    const removeValue = React.useCallback(
        (valueToRemove: string, event?: React.MouseEvent) => {
            if (readOnly) {
                return;
            }

            event?.stopPropagation();
            event?.preventDefault();
            const newValues = selectedValues.filter((v) => v !== valueToRemove);

            setSelectedValues(newValues);
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: newValues });
            // Focus back on input after removing
            setTimeout(() => inputRef.current?.focus(), 0);
        },
        [selectedValues, tableMeta, rowIndex, columnId, readOnly],
    );

    const clearAll = React.useCallback(() => {
        if (readOnly) {
            return;
        }

        setSelectedValues([]);
        tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: [] });
        queueMicrotask(() => inputRef.current?.focus());
    }, [tableMeta, rowIndex, columnId, readOnly]);

    const onOpenChange = React.useCallback(
        (open: boolean) => {
            if (open && !readOnly) {
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else {
                setSearchValue("");
                tableMeta?.onCellEditingStop?.();
            }
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing && event.key === "Escape") {
                event.preventDefault();
                setSelectedValues(cellValue);
                setSearchValue("");
                tableMeta?.onCellEditingStop?.();
            } else if (!isEditing && isFocused && event.key === "Tab") {
                event.preventDefault();
                setSearchValue("");
                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });
            }
        },
        [isEditing, isFocused, cellValue, tableMeta],
    );

    const onInputKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            // Handle backspace when input is empty - remove last selected item
            if (event.key === "Backspace" && searchValue === "" && selectedValues.length > 0) {
                event.preventDefault();
                const lastValue = selectedValues[selectedValues.length - 1];

                if (lastValue) {
                    removeValue(lastValue);
                }
            }

            // Prevent escape from propagating to close the popover immediately
            // Let the command handle it first
            if (event.key === "Escape") {
                event.stopPropagation();
            }
        },
        [searchValue, selectedValues, removeValue],
    );

    const displayLabels = selectedValues.map((value) => options.find((opt) => opt.value === value)?.label ?? value).filter(Boolean);

    const lineCount = getLineCount(rowHeight);

    const { hiddenCount: hiddenBadgeCount, visibleItems: visibleLabels } = useBadgeOverflow({
        containerRef,
        getLabel: (label) => label,
        items: displayLabels,
        lineCount,
    });

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
            {isEditing ? (
                <Popover onOpenChange={onOpenChange} open={isEditing}>
                    <PopoverAnchor nativeButton={false} render={<div className="absolute inset-0" />} />
                    <PopoverContent
                        align="start"
                        className="w-[300px] rounded-none p-0"
                        data-grid-cell-editor=""
                        initialFocus={inputRef}
                        sideOffset={sideOffset}
                    >
                        <div className="**:data-[slot=command-input-wrapper]:h-auto **:data-[slot=command-input-wrapper]:border-none **:data-[slot=command-input-wrapper]:p-0 [&_[data-slot=command-input-wrapper]_svg]:hidden">
                            <Command>
                                <div className="flex min-h-9 flex-wrap items-center gap-1 border-b px-3 py-1.5">
                                    {selectedValues.map((value) => {
                                        const option = options.find((opt) => opt.value === value);
                                        const label = option?.label ?? value;

                                        return (
                                            <Badge className="gap-1 px-1.5 py-px" key={value} variant="secondary">
                                                {label}
                                                <button
                                                    aria-label={t`Remove ${label}`}
                                                    onClick={(event) => removeValue(value, event)}
                                                    onPointerDown={(event) => {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                    }}
                                                    type="button"
                                                >
                                                    <X className="size-3" />
                                                </button>
                                            </Badge>
                                        );
                                    })}
                                    <CommandInput
                                        className="h-auto flex-1 p-0"
                                        onChange={(e) => setSearchValue(e.target.value)}
                                        onKeyDown={onInputKeyDown}
                                        placeholder={t`Search...`}
                                        ref={inputRef}
                                        value={searchValue}
                                    />
                                </div>
                                <CommandList className="max-h-full">
                                    <CommandEmpty>{t`No options found.`}</CommandEmpty>
                                    <CommandGroup className="max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto">
                                        {options.map((option) => {
                                            const isOptionSelected = selectedValues.includes(option.value);

                                            return (
                                                <CommandItem key={option.value} onSelect={() => onValueChange(option.value)} value={option.label}>
                                                    <div
                                                        className={cn(
                                                            "border-primary flex size-4 items-center justify-center rounded-sm border",
                                                            isOptionSelected ? "bg-primary text-primary-foreground" : "opacity-50 [&_svg]:invisible",
                                                        )}
                                                    >
                                                        <Check className="size-3" />
                                                    </div>
                                                    <span>{option.label}</span>
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                    {selectedValues.length > 0 && (
                                        <>
                                            <CommandSeparator />
                                            <CommandGroup>
                                                <CommandItem className="text-muted-foreground justify-center" onSelect={clearAll}>
                                                    {t`Clear all`}
                                                </CommandItem>
                                            </CommandGroup>
                                        </>
                                    )}
                                </CommandList>
                            </Command>
                        </div>
                    </PopoverContent>
                </Popover>
            ) : null}
            {displayLabels.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 overflow-hidden">
                    {visibleLabels.map((label, index) => (
                        <Badge className="px-1.5 py-px" key={selectedValues[index]} variant="secondary">
                            {label}
                        </Badge>
                    ))}
                    {hiddenBadgeCount > 0 && (
                        <Badge className="text-muted-foreground px-1.5 py-px" variant="outline">
                            +{hiddenBadgeCount}
                        </Badge>
                    )}
                </div>
            ) : null}
        </DataGridCellWrapper>
    );
};
