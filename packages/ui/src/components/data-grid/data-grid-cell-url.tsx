"use client";

import { useLingui } from "@lingui/react/macro";
import type { RowData } from "@tanstack/react-table";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import type { DataGridCellProps } from "@ui/types/data-grid";
import cn from "@ui/utils/cn";
import * as React from "react";
import { toast } from "sonner";

const DANGEROUS_URL_PROTOCOL_REGEX = /^(?:javascript|data|vbscript|file):/i;

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
