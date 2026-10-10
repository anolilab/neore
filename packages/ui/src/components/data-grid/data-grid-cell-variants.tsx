"use client";

import type { I18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import type { RowData } from "@tanstack/react-table";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Calendar } from "@ui/components/calendar";
import { Checkbox } from "@ui/components/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@ui/components/command";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import { Popover, PopoverAnchor, PopoverContent } from "@ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { useBadgeOverflow } from "@ui/hooks/use-badge-overflow";
import useDebouncedCallback from "@ui/hooks/use-debounced-callback";
import { getCellKey, getLineCount } from "@ui/lib/data-grid";
import type { DataGridCellProps, FileCellData } from "@ui/types/data-grid";
import cn from "@ui/utils/cn";
import { formatDate } from "@ui/utils/locale-format";
import { Check, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation, Upload, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

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
    const containerRef = React.useRef<HTMLDivElement>(null);
    const sideOffset = -(containerRef.current?.clientHeight ?? 0);

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

    const onOpenAutoFocus: NonNullable<React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]> = React.useCallback((event) => {
        event.preventDefault();

        if (textareaRef.current) {
            textareaRef.current.focus();
            const { length } = textareaRef.current.value;

            textareaRef.current.setSelectionRange(length, length);
        }
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
                        ref={containerRef}
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
                onOpenAutoFocus={onOpenAutoFocus}
                side="bottom"
                sideOffset={sideOffset}
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

export const NumberCell = <TData extends RowData>({
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
    const initialValue = cell.getValue() as number;
    const [value, setValue] = React.useState(String(initialValue ?? ""));
    const inputRef = React.useRef<HTMLInputElement>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);

    const cellOptions = cell.column.columnDef.meta?.cell;
    const numberCellOptions = cellOptions?.variant === "number" ? cellOptions : null;
    const min = numberCellOptions?.min;
    const max = numberCellOptions?.max;
    const step = numberCellOptions?.step;

    const prevIsEditingRef = React.useRef(isEditing);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(String(initialValue ?? ""));
    }

    const onBlur = React.useCallback(() => {
        const numberValue = value === "" ? null : Number(value);

        if (!readOnly && numberValue !== initialValue) {
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: numberValue });
        }

        tableMeta?.onCellEditingStop?.();
    }, [tableMeta, rowIndex, columnId, initialValue, value, readOnly]);

    const onChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        setValue(event.target.value);
    }, []);

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing) {
                switch (event.key) {
                    case "Enter": {
                        event.preventDefault();
                        const numberValue = value === "" ? null : Number(value);

                        if (numberValue !== initialValue) {
                            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: numberValue });
                        }

                        tableMeta?.onCellEditingStop?.({ moveToNextRow: true });

                        break;
                    }
                    case "Escape": {
                        event.preventDefault();
                        setValue(String(initialValue ?? ""));
                        inputRef.current?.blur();

                        break;
                    }
                    case "Tab": {
                        event.preventDefault();
                        const numberValue = value === "" ? null : Number(value);

                        if (numberValue !== initialValue) {
                            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: numberValue });
                        }

                        tableMeta?.onCellEditingStop?.({
                            direction: event.shiftKey ? "left" : "right",
                        });

                        break;
                    }
                    // no default
                }
            } else if (isFocused) {
                // Handle Backspace to start editing with empty value
                if (event.key === "Backspace") {
                    setValue("");
                } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
                    // Handle typing to pre-fill the value when editing starts
                    setValue(event.key);
                }
            }
        },
        [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId, value],
    );

    React.useEffect(() => {
        const wasEditing = prevIsEditingRef.current;

        prevIsEditingRef.current = isEditing;

        // Only focus when we start editing (transition from false to true)
        if (isEditing && !wasEditing && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isEditing]);

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
                <input
                    className="w-full [appearance:textfield] border-none bg-transparent p-0 outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    max={max}
                    min={min}
                    onBlur={onBlur}
                    onChange={onChange}
                    ref={inputRef}
                    step={step}
                    type="number"
                    value={value}
                />
            ) : (
                <span data-slot="grid-cell-content">{value}</span>
            )}
        </DataGridCellWrapper>
    );
};

const getUrlHref = (urlString: string): string => {
    if (!urlString || urlString.trim() === "") {
        return "";
    }

    const trimmed = urlString.trim();

    // Reject dangerous protocols (extra safety, though our http:// prefix would neutralize them)
    if (DANGEROUS_URL_PROTOCOL_REGEX.test(trimmed)) {
        return "";
    }

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        return trimmed;
    }

    return `http://${trimmed}`;
};

export const UrlCell = <TData extends RowData>({
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
    const cellRef = React.useRef<HTMLDivElement>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue ?? "");
    }

    // See ShortTextCell: the contentEditable node is re-synced after commit,
    // never during render.
    const syncedValueRef = React.useRef(initialValue);

    React.useLayoutEffect(() => {
        if (syncedValueRef.current === initialValue) {
            return;
        }

        syncedValueRef.current = initialValue;

        if (cellRef.current && !isEditing) {
            cellRef.current.textContent = initialValue ?? "";
        }
    }, [initialValue, isEditing]);

    const onBlur = React.useCallback(() => {
        const currentValue = cellRef.current?.textContent?.trim() ?? "";

        if (!readOnly && currentValue !== initialValue) {
            tableMeta?.onDataUpdate?.({
                columnId,
                rowIndex,
                value: currentValue || null,
            });
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
                        const currentValue = cellRef.current?.textContent?.trim() ?? "";

                        if (!readOnly && currentValue !== initialValue) {
                            tableMeta?.onDataUpdate?.({
                                columnId,
                                rowIndex,
                                value: currentValue || null,
                            });
                        }

                        tableMeta?.onCellEditingStop?.({ moveToNextRow: true });

                        break;
                    }
                    case "Escape": {
                        event.preventDefault();
                        setValue(initialValue ?? "");
                        cellRef.current?.blur();

                        break;
                    }
                    case "Tab": {
                        event.preventDefault();
                        const currentValue = cellRef.current?.textContent?.trim() ?? "";

                        if (!readOnly && currentValue !== initialValue) {
                            tableMeta?.onDataUpdate?.({
                                columnId,
                                rowIndex,
                                value: currentValue || null,
                            });
                        }

                        tableMeta?.onCellEditingStop?.({
                            direction: event.shiftKey ? "left" : "right",
                        });

                        break;
                    }
                    // no default
                }
            } else if (isFocused && !readOnly && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
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
        [isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId, readOnly],
    );

    const onLinkClick = React.useCallback(
        (event: React.MouseEvent<HTMLAnchorElement>) => {
            if (isEditing) {
                event.preventDefault();

                return;
            }

            // Check if URL was rejected due to dangerous protocol
            const href = getUrlHref(value);

            if (!href) {
                event.preventDefault();
                toast.error(t`Invalid URL`, {
                    description: t`URL contains a dangerous protocol (javascript:, data:, vbscript:, or file:)`,
                });

                return;
            }

            // Stop propagation to prevent grid from interfering with link navigation
            event.stopPropagation();
        },
        [isEditing, value, t],
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
    const urlHref = displayValue ? getUrlHref(displayValue) : "";
    const isDangerousUrl = displayValue && !urlHref;

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
            {!isEditing && displayValue ? (
                <div className="size-full overflow-hidden" data-slot="grid-cell-content">
                    <a
                        className="text-primary decoration-primary/30 hover:decoration-primary/60 data-focused:text-foreground data-invalid:text-destructive data-focused:decoration-foreground/50 data-invalid:decoration-destructive/50 data-focused:hover:decoration-foreground/70 data-invalid:hover:decoration-destructive/70 truncate underline underline-offset-2 data-invalid:cursor-not-allowed"
                        data-focused={isFocused && !isDangerousUrl ? "" : undefined}
                        data-invalid={isDangerousUrl ? "" : undefined}
                        href={urlHref}
                        onClick={onLinkClick}
                        rel="noopener noreferrer"
                        target="_blank"
                    >
                        {displayValue}
                    </a>
                </div>
            ) : (
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
            )}
        </DataGridCellWrapper>
    );
};

export const CheckboxCell = <TData extends RowData>({
    cell,
    columnId,
    isActiveSearchMatch,
    isFocused,
    isSearchMatch,
    isSelected,
    readOnly,
    rowHeight,
    rowIndex,
    tableMeta,
}: Omit<DataGridCellProps<TData>, "isEditing">) => {
    const initialValue = cell.getValue() as boolean;
    const [value, setValue] = React.useState(initialValue);
    const containerRef = React.useRef<HTMLDivElement>(null);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue);
    }

    const onCheckedChange = React.useCallback(
        (checked: boolean) => {
            if (readOnly) {
                return;
            }

            setValue(checked);
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: checked });
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isFocused && !readOnly && (event.key === " " || event.key === "Enter")) {
                event.preventDefault();
                event.stopPropagation();
                onCheckedChange(!value);
            } else if (isFocused && event.key === "Tab") {
                event.preventDefault();
                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });
            }
        },
        [isFocused, value, onCheckedChange, tableMeta, readOnly],
    );

    const onWrapperClick = React.useCallback(
        (event: React.MouseEvent) => {
            if (!isFocused || readOnly) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            onCheckedChange(!value);
        },
        [isFocused, value, onCheckedChange, readOnly],
    );

    const onCheckboxClick = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
    }, []);

    const onCheckboxMouseDown = React.useCallback((event: any) => {
        event.stopPropagation();
    }, []);

    const onCheckboxDoubleClick = React.useCallback((event: any) => {
        event.stopPropagation();
    }, []);

    return (
        <DataGridCellWrapper<TData>
            cell={cell}
            className="flex size-full justify-center"
            columnId={columnId}
            isActiveSearchMatch={isActiveSearchMatch}
            isEditing={false}
            isFocused={isFocused}
            isSearchMatch={isSearchMatch}
            isSelected={isSelected}
            onClick={onWrapperClick}
            onKeyDown={onWrapperKeyDown}
            readOnly={readOnly}
            ref={containerRef}
            rowHeight={rowHeight}
            rowIndex={rowIndex}
            tableMeta={tableMeta}
        >
            <Checkbox
                checked={value}
                className="border-primary"
                disabled={readOnly}
                onCheckedChange={onCheckedChange}
                onClick={onCheckboxClick}
                onDoubleClick={onCheckboxDoubleClick}
                onMouseDown={onCheckboxMouseDown}
            />
        </DataGridCellWrapper>
    );
};

export const SelectCell = <TData extends RowData>({
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
    const containerRef = React.useRef<HTMLDivElement>(null);
    const cellOptions = cell.column.columnDef.meta?.cell;
    const options = cellOptions?.variant === "select" ? cellOptions.options : [];

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue);
    }

    const onValueChange = React.useCallback(
        (nextValue: string | null) => {
            if (nextValue === null) {
                return;
            }

            if (readOnly) {
                return;
            }

            setValue(nextValue);
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: nextValue });
            tableMeta?.onCellEditingStop?.();
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onOpenChange = React.useCallback(
        (open: boolean) => {
            if (open && !readOnly) {
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else {
                tableMeta?.onCellEditingStop?.();
            }
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing && event.key === "Escape") {
                event.preventDefault();
                setValue(initialValue);
                tableMeta?.onCellEditingStop?.();
            } else if (!isEditing && isFocused && event.key === "Tab") {
                event.preventDefault();
                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });
            }
        },
        [isEditing, isFocused, initialValue, tableMeta],
    );

    const displayLabel = options.find((opt) => opt.value === value)?.label ?? value;

    const badge = displayLabel ? (
        <Badge className="px-1.5 py-px whitespace-pre-wrap" data-slot="grid-cell-content" variant="secondary">
            {displayLabel}
        </Badge>
    ) : null;

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
                <Select onOpenChange={onOpenChange} onValueChange={onValueChange} open={isEditing} value={value}>
                    <SelectTrigger
                        className="size-full items-start border-none p-0 shadow-none focus-visible:ring-0 dark:bg-transparent [&_svg]:hidden"
                        size="sm"
                    >
                        {displayLabel ? (
                            <Badge className="px-1.5 py-px whitespace-pre-wrap" variant="secondary">
                                <SelectValue />
                            </Badge>
                        ) : (
                            <SelectValue />
                        )}
                    </SelectTrigger>
                    <SelectContent
                        // compensate for the wrapper padding
                        align="start"
                        alignOffset={-8}
                        className="min-w-[calc(var(--radix-select-trigger-width)+16px)]"
                        data-grid-cell-editor=""
                        sideOffset={-8}
                    >
                        {options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : (
                badge
            )}
        </DataGridCellWrapper>
    );
};

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

    const onOpenAutoFocus: NonNullable<React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]> = React.useCallback((event) => {
        event.preventDefault();
        inputRef.current?.focus();
    }, []);

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
                        onOpenAutoFocus={onOpenAutoFocus}
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

const formatDateForDisplay = (dateString: string, locale: string) => {
    if (!dateString) {
        return "";
    }

    return formatDate(dateString, locale);
};

export const DateCell = <TData extends RowData>({
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
    const { i18n } = useLingui();
    const initialValue = cell.getValue() as string;
    const [value, setValue] = React.useState(initialValue ?? "");
    const containerRef = React.useRef<HTMLDivElement>(null);

    const [prevInitialValue, setPrevInitialValue] = React.useState(initialValue);

    if (initialValue !== prevInitialValue) {
        setPrevInitialValue(initialValue);
        setValue(initialValue ?? "");
    }

    const selectedDate = value ? new Date(value) : undefined;

    const onDateSelect = React.useCallback(
        (date: Date | undefined) => {
            if (!date || readOnly) {
                return;
            }

            const formattedDate = date.toISOString().split("T", 1)[0] ?? "";

            setValue(formattedDate);
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: formattedDate });
            tableMeta?.onCellEditingStop?.();
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onOpenChange = React.useCallback(
        (open: boolean) => {
            if (open && !readOnly) {
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else {
                tableMeta?.onCellEditingStop?.();
            }
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing && event.key === "Escape") {
                event.preventDefault();
                setValue(initialValue);
                tableMeta?.onCellEditingStop?.();
            } else if (!isEditing && isFocused && event.key === "Tab") {
                event.preventDefault();
                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });
            }
        },
        [isEditing, isFocused, initialValue, tableMeta],
    );

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
            <Popover onOpenChange={onOpenChange} open={isEditing}>
                <PopoverAnchor nativeButton={false} render={<span data-slot="grid-cell-content" />}>
                    {formatDateForDisplay(value, i18n.locale)}
                </PopoverAnchor>
                {isEditing && (
                    <PopoverContent align="start" alignOffset={-8} className="w-auto p-0" data-grid-cell-editor="">
                        <Calendar
                            autoFocus
                            captionLayout="dropdown"
                            defaultMonth={selectedDate ?? new Date()}
                            mode="single"
                            onSelect={onDateSelect}
                            selected={selectedDate}
                        />
                    </PopoverContent>
                )}
            </Popover>
        </DataGridCellWrapper>
    );
};

const formatFileSize = (bytes: number): string => {
    if (bytes === 0) {
        return "0 B";
    }

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${Number((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
};

const DANGEROUS_URL_PROTOCOL_REGEX = /^(?:javascript|data|vbscript|file):/i;

const getFileIcon = (type: string): React.ComponentType<React.SVGProps<SVGSVGElement>> => {
    if (type.startsWith("image/")) {
        return FileImage;
    }

    if (type.startsWith("video/")) {
        return FileVideo;
    }

    if (type.startsWith("audio/")) {
        return FileAudio;
    }

    if (type.includes("pdf")) {
        return FileText;
    }

    if (type.includes("zip") || type.includes("rar")) {
        return FileArchive;
    }

    if (type.includes("word") || type.includes("document") || type.includes("doc")) {
        return FileText;
    }

    if (type.includes("sheet") || type.includes("excel") || type.includes("xls")) {
        return FileSpreadsheet;
    }

    if (type.includes("presentation") || type.includes("powerpoint") || type.includes("ppt")) {
        return Presentation;
    }

    return File;
};

const getDropzoneHint = (i18n: I18n, maxFileSize: number | undefined, maxFiles: number | undefined): string => {
    if (maxFileSize) {
        const size = formatFileSize(maxFileSize);

        return maxFiles ? i18n._(msg`Max size: ${size} • Max ${maxFiles} files`) : i18n._(msg`Max size: ${size}`);
    }

    if (maxFiles) {
        return i18n._(msg`Max ${maxFiles} files`);
    }

    return i18n._(msg`Select files to upload`);
};

const getFileStatusLabel = (i18n: I18n, isFileUploading: boolean, isFileDeleting: boolean, size: number): string => {
    if (isFileUploading) {
        return i18n._(msg`Uploading...`);
    }

    if (isFileDeleting) {
        return i18n._(msg`Deleting...`);
    }

    return formatFileSize(size);
};

export const FileCell = <TData extends RowData>({
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
    const { i18n, t } = useLingui();
    const cellValue = React.useMemo(() => (cell.getValue() as FileCellData[]) ?? [], [cell]);

    const cellKey = getCellKey(rowIndex, columnId);
    const [prevCellKey, setPrevCellKey] = React.useState(cellKey);

    const labelId = React.useId();
    const descriptionId = React.useId();

    const [files, setFiles] = React.useState<FileCellData[]>(cellValue);
    const [uploadingFiles, setUploadingFiles] = React.useState<Set<string>>(new Set());
    const [deletingFiles, setDeletingFiles] = React.useState<Set<string>>(new Set());
    const [isDraggingOver, setIsDraggingOver] = React.useState(false);
    const [isDragging, setIsDragging] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const isUploading = uploadingFiles.size > 0;
    const isDeleting = deletingFiles.size > 0;
    const isPending = isUploading || isDeleting;
    const containerRef = React.useRef<HTMLDivElement>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const dropzoneRef = React.useRef<HTMLDivElement>(null);
    const cellOptions = cell.column.columnDef.meta?.cell;
    const sideOffset = -(containerRef.current?.clientHeight ?? 0);

    const fileCellOptions = cellOptions?.variant === "file" ? cellOptions : null;
    const maxFileSize = fileCellOptions?.maxFileSize ?? 10 * 1024 * 1024;
    const maxFiles = fileCellOptions?.maxFiles ?? 10;
    const accept = fileCellOptions?.accept;
    const multiple = fileCellOptions?.multiple ?? false;

    const acceptedTypes = React.useMemo(() => (accept ? accept.split(",").map((type) => type.trim()) : null), [accept]);

    const [prevCellValue, setPrevCellValue] = React.useState(cellValue);

    if (cellValue !== prevCellValue) {
        setPrevCellValue(cellValue);

        for (const file of files) {
            if (file.url) {
                URL.revokeObjectURL(file.url);
            }
        }

        setFiles(cellValue);
        setError(null);
    }

    if (prevCellKey !== cellKey) {
        setPrevCellKey(cellKey);
        setError(null);
    }

    const validateFile = React.useCallback(
        (file: File): string | null => {
            if (maxFileSize && file.size > maxFileSize) {
                const maxSize = formatFileSize(maxFileSize);

                return t`File size exceeds ${maxSize}`;
            }

            if (acceptedTypes) {
                const fileExtension = `.${file.name.split(".").pop()}`;
                const isAccepted = acceptedTypes.some((type) => {
                    if (type.endsWith("/*")) {
                        const baseType = type.slice(0, -2);

                        return file.type.startsWith(`${baseType}/`);
                    }

                    if (type.startsWith(".")) {
                        return fileExtension.toLowerCase() === type.toLowerCase();
                    }

                    return file.type === type;
                });

                if (!isAccepted) {
                    return t`File type not accepted`;
                }
            }

            return null;
        },
        [maxFileSize, acceptedTypes, t],
    );

    const addFiles = React.useCallback(
        async (newFiles: File[], skipUpload = false) => {
            if (readOnly || isPending) {
                return;
            }

            setError(null);

            if (maxFiles && files.length + newFiles.length > maxFiles) {
                const errorMessage = t`Maximum ${maxFiles} files allowed`;

                setError(errorMessage);
                toast(errorMessage);
                setTimeout(() => {
                    setError(null);
                }, 2000);

                return;
            }

            const rejectedFiles: { name: string; reason: string }[] = [];
            const filesToValidate: File[] = [];

            for (const file of newFiles) {
                const validationError = validateFile(file);

                if (validationError) {
                    rejectedFiles.push({ name: file.name, reason: validationError });
                    continue;
                }

                filesToValidate.push(file);
            }

            if (rejectedFiles.length > 0) {
                const firstError = rejectedFiles[0];

                if (firstError) {
                    setError(firstError.reason);

                    const truncatedName = firstError.name.length > 20 ? `${firstError.name.slice(0, 20)}...` : firstError.name;

                    if (rejectedFiles.length === 1) {
                        toast(firstError.reason, {
                            description: t`"${truncatedName}" has been rejected`,
                        });
                    } else {
                        const moreCount = rejectedFiles.length - 1;

                        toast(firstError.reason, {
                            description: t`"${truncatedName}" and ${moreCount} more rejected`,
                        });
                    }

                    setTimeout(() => {
                        setError(null);
                    }, 2000);
                }
            }

            if (filesToValidate.length > 0) {
                if (skipUpload) {
                    const newFilesData: FileCellData[] = filesToValidate.map((f) => {
                        return {
                            id: crypto.randomUUID(),
                            name: f.name,
                            size: f.size,
                            type: f.type,
                            url: URL.createObjectURL(f),
                        };
                    });
                    const updatedFiles = [...files, ...newFilesData];

                    setFiles(updatedFiles);
                    tableMeta?.onDataUpdate?.({
                        columnId,
                        rowIndex,
                        value: updatedFiles,
                    });
                } else {
                    const tempFiles = filesToValidate.map((f) => {
                        return {
                            id: crypto.randomUUID(),
                            name: f.name,
                            size: f.size,
                            type: f.type,
                            url: undefined,
                        };
                    });
                    const filesWithTemp = [...files, ...tempFiles];

                    setFiles(filesWithTemp);

                    const uploadingIds = new Set(tempFiles.map((f) => f.id));

                    setUploadingFiles(uploadingIds);

                    let uploadedFiles: FileCellData[] = [];

                    if (tableMeta?.onFilesUpload) {
                        try {
                            uploadedFiles = await tableMeta.onFilesUpload({
                                columnId,
                                files: filesToValidate,
                                rowIndex,
                            });
                        } catch (uploadError) {
                            const fileCount = filesToValidate.length;
                            // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
                            const uploadFailedMessage = t`${plural(fileCount, { one: "Failed to upload # file", other: "Failed to upload # files" })}`;

                            toast.error(uploadError instanceof Error ? uploadError.message : uploadFailedMessage);
                            setFiles((prev) => prev.filter((f) => !uploadingIds.has(f.id as `${string}-${string}-${string}-${string}-${string}`)));
                            setUploadingFiles(new Set());

                            return;
                        }
                    } else {
                        uploadedFiles = filesToValidate.map((f, i) => {
                            return {
                                id: tempFiles[i]?.id ?? crypto.randomUUID(),
                                name: f.name,
                                size: f.size,
                                type: f.type,
                                url: URL.createObjectURL(f),
                            };
                        });
                    }

                    const finalFiles = filesWithTemp
                        .map((f) => {
                            if (uploadingIds.has(f.id as `${string}-${string}-${string}-${string}-${string}`)) {
                                return uploadedFiles.find((uf) => uf.name === f.name) ?? f;
                            }

                            return f;
                        })
                        .filter((f) => f.url !== undefined);

                    setFiles(finalFiles);
                    setUploadingFiles(new Set());
                    tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: finalFiles });
                }
            }
        },
        [files, maxFiles, validateFile, tableMeta, rowIndex, columnId, readOnly, isPending, t],
    );

    const removeFile = React.useCallback(
        async (fileId: string) => {
            if (readOnly || isPending) {
                return;
            }

            setError(null);

            const fileToRemove = files.find((f) => f.id === fileId);

            if (!fileToRemove) {
                return;
            }

            setDeletingFiles((prev) => new Set(prev).add(fileId));

            if (tableMeta?.onFilesDelete) {
                try {
                    await tableMeta.onFilesDelete({
                        columnId,
                        fileIds: [fileId],
                        rowIndex,
                    });
                } catch (deleteError) {
                    const fileName = fileToRemove.name;

                    toast.error(deleteError instanceof Error ? deleteError.message : t`Failed to delete ${fileName}`);
                    setDeletingFiles((prev) => {
                        const next = new Set(prev);

                        next.delete(fileId);

                        return next;
                    });

                    return;
                }
            }

            if (fileToRemove.url?.startsWith("blob:")) {
                URL.revokeObjectURL(fileToRemove.url);
            }

            const updatedFiles = files.filter((f) => f.id !== fileId);

            setFiles(updatedFiles);
            setDeletingFiles((prev) => {
                const next = new Set(prev);

                next.delete(fileId);

                return next;
            });
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: updatedFiles });
        },
        [files, tableMeta, rowIndex, columnId, readOnly, isPending, t],
    );

    const clearAll = React.useCallback(async () => {
        if (readOnly || isPending) {
            return;
        }

        setError(null);

        const fileIds = files.map((f) => f.id);

        setDeletingFiles(new Set(fileIds));

        if (tableMeta?.onFilesDelete && files.length > 0) {
            try {
                await tableMeta.onFilesDelete({
                    columnId,
                    fileIds,
                    rowIndex,
                });
            } catch (deleteError) {
                toast.error(deleteError instanceof Error ? deleteError.message : t`Failed to delete files`);
                setDeletingFiles(new Set());

                return;
            }
        }

        for (const file of files) {
            if (file.url?.startsWith("blob:")) {
                URL.revokeObjectURL(file.url);
            }
        }

        setFiles([]);
        setDeletingFiles(new Set());
        tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: [] });
    }, [files, tableMeta, rowIndex, columnId, readOnly, isPending, t]);

    const onCellDragEnter = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();

        if (event.dataTransfer.types.includes("Files")) {
            setIsDraggingOver(true);
        }
    }, []);

    const onCellDragLeave = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX;
        const y = event.clientY;

        if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
            setIsDraggingOver(false);
        }
    }, []);

    const onCellDragOver = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
    }, []);

    const onCellDrop = React.useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setIsDraggingOver(false);

            const droppedFiles = [...event.dataTransfer.files];

            if (droppedFiles.length > 0) {
                addFiles(droppedFiles, false);
            }
        },
        [addFiles],
    );

    const onDropzoneDragEnter = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragging(true);
    }, []);

    const onDropzoneDragLeave = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX;
        const y = event.clientY;

        if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
            setIsDragging(false);
        }
    }, []);

    const onDropzoneDragOver = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
    }, []);

    const onDropzoneDrop = React.useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setIsDragging(false);

            const droppedFiles = [...event.dataTransfer.files];

            addFiles(droppedFiles, false);
        },
        [addFiles],
    );

    const onDropzoneClick = React.useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const onDropzoneKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (!(event.key === "Enter" || event.key === " ")) {
                return;
            }

            event.preventDefault();
            onDropzoneClick();
        },
        [onDropzoneClick],
    );

    const onFileInputChange = React.useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const selectedFiles = [...(event.target.files ?? [])];

            addFiles(selectedFiles, false);

            // Clearing the input is what makes re-picking the same file fire
            // `change` again.
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        },
        [addFiles],
    );

    const onOpenChange = React.useCallback(
        (open: boolean) => {
            setError(null);

            if (open && !readOnly) {
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else {
                tableMeta?.onCellEditingStop?.();
            }
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onEscapeKeyDown: NonNullable<React.ComponentProps<typeof PopoverContent>["onEscapeKeyDown"]> = React.useCallback((event) => {
        // Prevent the escape key from propagating to the data grid's keyboard handler
        // which would call blurCell() and remove focus from the cell
        event.stopPropagation();
    }, []);

    const onOpenAutoFocus: NonNullable<React.ComponentProps<typeof PopoverContent>["onOpenAutoFocus"]> = React.useCallback((event) => {
        event.preventDefault();
        queueMicrotask(() => {
            dropzoneRef.current?.focus();
        });
    }, []);

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    setFiles(cellValue);
                    setError(null);
                    tableMeta?.onCellEditingStop?.();
                } else if (event.key === " ") {
                    event.preventDefault();
                    onDropzoneClick();
                }
            } else if (isFocused && event.key === "Enter") {
                event.preventDefault();
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else if (!isEditing && isFocused && event.key === "Tab") {
                event.preventDefault();
                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });
            }
        },
        [isEditing, isFocused, cellValue, tableMeta, onDropzoneClick, rowIndex, columnId],
    );

    React.useEffect(
        () => () => {
            for (const file of files) {
                if (file.url) {
                    URL.revokeObjectURL(file.url);
                }
            }
        },
        [files],
    );

    const lineCount = getLineCount(rowHeight);

    const { hiddenCount: hiddenFileCount, visibleItems: visibleFiles } = useBadgeOverflow({
        cacheKeyPrefix: "file",
        containerRef,
        getLabel: (file) => file.name,
        iconSize: 12,
        items: files,
        lineCount,
        maxWidth: 100,
    });

    const fileBadges =
        files.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 overflow-hidden">
                {visibleFiles.map((file) => {
                    const isFileUploading = uploadingFiles.has(file.id);

                    if (isFileUploading) {
                        return (
                            <Skeleton
                                className="h-5 shrink-0 px-1.5"
                                key={file.id}
                                style={{
                                    width: `${Math.min(file.name.length * 8 + 30, 100)}px`,
                                }}
                            />
                        );
                    }

                    const FileIcon = getFileIcon(file.type);

                    return (
                        <Badge className="gap-1 px-1.5 py-px" key={file.id} variant="secondary">
                            {FileIcon && <FileIcon className="size-3 shrink-0" />}
                            <span className="max-w-[100px] truncate">{file.name}</span>
                        </Badge>
                    );
                })}
                {hiddenFileCount > 0 && (
                    <Badge className="text-muted-foreground px-1.5 py-px" variant="outline">
                        +{hiddenFileCount}
                    </Badge>
                )}
            </div>
        ) : null;

    return (
        <DataGridCellWrapper<TData>
            cell={cell}
            className={cn({
                "ring-primary/80 ring-1 ring-inset": isDraggingOver,
            })}
            columnId={columnId}
            isActiveSearchMatch={isActiveSearchMatch}
            isEditing={isEditing}
            isFocused={isFocused}
            isSearchMatch={isSearchMatch}
            isSelected={isSelected}
            onDragEnter={onCellDragEnter}
            onDragLeave={onCellDragLeave}
            onDragOver={onCellDragOver}
            onDrop={onCellDrop}
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
                        className="w-[400px] rounded-none p-0"
                        data-grid-cell-editor=""
                        onEscapeKeyDown={onEscapeKeyDown}
                        onOpenAutoFocus={onOpenAutoFocus}
                        sideOffset={sideOffset}
                    >
                        <div className="flex flex-col gap-2 p-3">
                            <span className="sr-only" id={labelId}>
                                {t`File upload`}
                            </span>
                            <div
                                aria-describedby={descriptionId}
                                aria-disabled={isPending}
                                aria-labelledby={labelId}
                                className="hover:bg-accent/30 focus-visible:border-ring/50 data-dragging:border-primary/30 data-invalid:border-destructive data-dragging:bg-accent/30 data-invalid:ring-destructive/20 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 transition-colors outline-none data-disabled:pointer-events-none data-disabled:opacity-50"
                                data-disabled={isPending ? "" : undefined}
                                data-dragging={isDragging ? "" : undefined}
                                data-invalid={error ? "" : undefined}
                                onClick={onDropzoneClick}
                                onDragEnter={onDropzoneDragEnter}
                                onDragLeave={onDropzoneDragLeave}
                                onDragOver={onDropzoneDragOver}
                                onDrop={onDropzoneDrop}
                                onKeyDown={onDropzoneKeyDown}
                                ref={dropzoneRef}
                                role="button"
                                tabIndex={isDragging || isPending ? -1 : 0}
                            >
                                <Upload className="text-muted-foreground size-8" />
                                <div className="text-center text-sm">
                                    <p className="font-medium">{isDragging ? t`Drop files here` : t`Drag files here`}</p>
                                    <p className="text-muted-foreground text-xs">{t`or click to browse`}</p>
                                </div>
                                <p className="text-muted-foreground text-xs" id={descriptionId}>
                                    {getDropzoneHint(i18n, maxFileSize, maxFiles)}
                                </p>
                            </div>
                            <input
                                accept={accept}
                                aria-describedby={descriptionId}
                                aria-labelledby={labelId}
                                className="sr-only"
                                multiple={multiple}
                                onChange={onFileInputChange}
                                ref={fileInputRef}
                                type="file"
                            />
                            {files.length > 0 && (
                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center justify-between">
                                        <p className="text-muted-foreground text-xs font-medium">
                                            <Plural one="# file" other="# files" value={files.length} />
                                        </p>
                                        <Button
                                            className="text-muted-foreground h-6 text-xs"
                                            disabled={isPending}
                                            onClick={clearAll}
                                            size="sm"
                                            type="button"
                                            variant="ghost"
                                        >
                                            {t`Clear all`}
                                        </Button>
                                    </div>
                                    <div className="max-h-[200px] space-y-1 overflow-y-auto">
                                        {files.map((file) => {
                                            const FileIcon = getFileIcon(file.type);
                                            const isFileUploading = uploadingFiles.has(file.id);
                                            const isFileDeleting = deletingFiles.has(file.id);
                                            const isFilePending = isFileUploading || isFileDeleting;
                                            const fileName = file.name;

                                            return (
                                                <div
                                                    className="bg-muted/50 flex items-center gap-2 rounded-md border px-2 py-1.5 data-pending:opacity-60"
                                                    data-pending={isFilePending ? "" : undefined}
                                                    key={file.id}
                                                >
                                                    {FileIcon && <FileIcon className="text-muted-foreground size-4 shrink-0" />}
                                                    <div className="flex-1 overflow-hidden">
                                                        <p className="truncate text-sm">{file.name}</p>
                                                        <p className="text-muted-foreground text-xs">
                                                            {getFileStatusLabel(i18n, isFileUploading, isFileDeleting, file.size)}
                                                        </p>
                                                    </div>
                                                    <Button
                                                        aria-label={t`Remove ${fileName}`}
                                                        className="size-5 rounded-sm"
                                                        disabled={isPending}
                                                        onClick={() => removeFile(file.id)}
                                                        size="icon"
                                                        type="button"
                                                        variant="ghost"
                                                    >
                                                        <X className="size-3" />
                                                    </Button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    </PopoverContent>
                </Popover>
            ) : null}
            {isDraggingOver ? (
                <div className="text-primary flex items-center justify-center gap-2 text-sm">
                    <Upload className="size-4" />
                    <span>{t`Drop files here`}</span>
                </div>
            ) : (
                fileBadges
            )}
        </DataGridCellWrapper>
    );
};
