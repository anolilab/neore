import type { Column, RowData, Table } from "@tanstack/react-table";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import type { CellOptions, CellPosition, Direction, FileCellData, RowHeightValue } from "@ui/types/data-grid";
import { BaselineIcon, CalendarIcon, CheckSquareIcon, FileIcon, HashIcon, LinkIcon, ListChecksIcon, ListIcon, TextInitialIcon } from "lucide-react";
import type * as React from "react";

/**
 * Re-exported from the library rather than reimplemented.
 *
 * This module used to define its own `flexRender` that simply CALLED the
 * renderer — `Comp?.(props)`. That worked in v8, where a cell/header renderer
 * was an ordinary function of its context. In v9 the renderer is rendered as a
 * component, so invoking it directly skips the element creation the library
 * relies on and the render throws
 * `TypeError: Cannot destructure property '_' of '...' as it is null`
 * from inside the table's own code — a crash that typechecks perfectly.
 *
 * `flexRender` still handles the string and undefined cases the local copy was
 * written for.
 */
export { flexRender } from "@tanstack/react-table";

export const getIsFileCellData = (item: unknown): item is FileCellData =>
    !!item && typeof item === "object" && "id" in item && "name" in item && "size" in item && "type" in item;

export const matchSelectOption = (value: string, options: { label: string; value: string }[]): string | undefined =>
    options.find((o) => o.value === value || o.value.toLowerCase() === value.toLowerCase() || o.label.toLowerCase() === value.toLowerCase())?.value;

export const getCellKey = (rowIndex: number, columnId: string) => `${rowIndex}:${columnId}`;

export const parseCellKey = (cellKey: string): Required<CellPosition> => {
    const parts = cellKey.split(":");
    const rowIndexString = parts[0];
    const columnId = parts[1];

    if (rowIndexString && columnId) {
        const rowIndex = Math.trunc(Number(rowIndexString));

        if (!Number.isNaN(rowIndex)) {
            return { columnId, rowIndex };
        }
    }

    return { columnId: "", rowIndex: 0 };
};

export const getRowHeightValue = (rowHeight: RowHeightValue): number => {
    const rowHeightMap: Record<RowHeightValue, number> = {
        "extra-tall": 96,
        medium: 56,
        short: 36,
        tall: 76,
    };

    return rowHeightMap[rowHeight];
};

export const getLineCount = (rowHeight: RowHeightValue): number => {
    const lineCountMap: Record<RowHeightValue, number> = {
        "extra-tall": 4,
        medium: 2,
        short: 1,
        tall: 3,
    };

    return lineCountMap[rowHeight];
};

const getPinnedBoxShadow = (params: {
    isFirstRightPinnedColumn: boolean;
    isLastLeftPinnedColumn: boolean;
    isRtl: boolean;
    withBorder: boolean;
}): string | undefined => {
    const { isFirstRightPinnedColumn, isLastLeftPinnedColumn, isRtl, withBorder } = params;

    if (!withBorder) {
        return undefined;
    }

    if (isLastLeftPinnedColumn) {
        return isRtl ? "4px 0 4px -4px var(--border) inset" : "-4px 0 4px -4px var(--border) inset";
    }

    if (isFirstRightPinnedColumn) {
        return isRtl ? "-4px 0 4px -4px var(--border) inset" : "4px 0 4px -4px var(--border) inset";
    }

    return undefined;
};

export const getCommonPinningStyles = <TData extends RowData>(params: {
    column: Column<DataGridFeatures, TData>;
    dir?: Direction;
    withBorder?: boolean;
}): React.CSSProperties => {
    const { column, dir: direction = "ltr", withBorder = false } = params;

    const isPinned = column.getIsPinned();
    const isLastLeftPinnedColumn = isPinned === "start" && column.getIsLastColumn("start");
    const isFirstRightPinnedColumn = isPinned === "end" && column.getIsFirstColumn("end");

    const isRtl = direction === "rtl";

    const leftPosition = isPinned === "start" ? `${column.getStart("start")}px` : undefined;
    const rightPosition = isPinned === "end" ? `${column.getAfter("end")}px` : undefined;

    return {
        background: "var(--background)",
        boxShadow: getPinnedBoxShadow({ isFirstRightPinnedColumn, isLastLeftPinnedColumn, isRtl, withBorder }),
        left: isRtl ? rightPosition : leftPosition,
        opacity: isPinned ? 0.97 : 1,
        position: isPinned ? "sticky" : "relative",
        right: isRtl ? leftPosition : rightPosition,
        width: column.getSize(),
        zIndex: isPinned ? 1 : undefined,
    };
};

const HORIZONTAL_SCROLL_DIRECTIONS = new Set(["end", "home", "left", "right"]);

export const getScrollDirection = (direction: string): "left" | "right" | "home" | "end" | undefined => {
    if (HORIZONTAL_SCROLL_DIRECTIONS.has(direction)) {
        return direction as "left" | "right" | "home" | "end";
    }

    if (direction === "pageleft") {
        return "left";
    }

    if (direction === "pageright") {
        return "right";
    }

    return undefined;
};

export const scrollCellIntoView = <TData extends RowData>(params: {
    container: HTMLDivElement;
    direction?: "left" | "right" | "home" | "end";
    isRtl: boolean;
    tableRef: React.RefObject<Table<DataGridFeatures, TData> | null>;
    targetCell: HTMLDivElement;
    viewportOffset: number;
}): void => {
    const { container, direction, isRtl, tableRef, targetCell, viewportOffset } = params;

    const containerRect = container.getBoundingClientRect();
    const cellRect = targetCell.getBoundingClientRect();

    const hasNegativeScroll = container.scrollLeft < 0;
    const isActuallyRtl = isRtl || hasNegativeScroll;

    const currentTable = tableRef.current;
    const leftPinnedColumns = currentTable?.getStartVisibleLeafColumns() ?? [];
    const rightPinnedColumns = currentTable?.getEndVisibleLeafColumns() ?? [];

    const leftPinnedWidth = leftPinnedColumns.reduce((sum, c) => sum + c.getSize(), 0);
    const rightPinnedWidth = rightPinnedColumns.reduce((sum, c) => sum + c.getSize(), 0);

    const viewportLeft = containerRect.left + (isActuallyRtl ? rightPinnedWidth : leftPinnedWidth) + viewportOffset;
    const viewportRight = containerRect.right - (isActuallyRtl ? leftPinnedWidth : rightPinnedWidth) - viewportOffset;

    const isFullyVisible = cellRect.left >= viewportLeft && cellRect.right <= viewportRight;

    if (isFullyVisible) {
        return;
    }

    const isClippedLeft = cellRect.left < viewportLeft;
    const isClippedRight = cellRect.right > viewportRight;

    let scrollDelta = 0;

    if (direction) {
        const shouldScrollRight = isActuallyRtl ? direction === "right" || direction === "home" : direction === "right" || direction === "end";

        scrollDelta = shouldScrollRight ? cellRect.right - viewportRight : -(viewportLeft - cellRect.left);
    } else if (isClippedRight) {
        scrollDelta = cellRect.right - viewportRight;
    } else if (isClippedLeft) {
        scrollDelta = -(viewportLeft - cellRect.left);
    }

    container.scrollLeft += scrollDelta;
};

export const getIsInPopover = (element: unknown): boolean =>
    element instanceof Element && (element.closest("[data-grid-cell-editor]") || element.closest("[data-grid-popover]")) !== null;

export const getColumnVariant = (
    variant?: CellOptions["variant"],
): {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    label: string;
} | null => {
    switch (variant) {
        case "checkbox": {
            return { icon: CheckSquareIcon, label: "Checkbox" };
        }
        case "date": {
            return { icon: CalendarIcon, label: "Date" };
        }
        case "file": {
            return { icon: FileIcon, label: "File" };
        }
        case "long-text": {
            return { icon: TextInitialIcon, label: "Long text" };
        }
        case "multi-select": {
            return { icon: ListChecksIcon, label: "Multi-select" };
        }
        case "number": {
            return { icon: HashIcon, label: "Number" };
        }
        case "select": {
            return { icon: ListIcon, label: "Select" };
        }
        case "short-text": {
            return { icon: BaselineIcon, label: "Short text" };
        }
        case "url": {
            return { icon: LinkIcon, label: "URL" };
        }
        default: {
            return null;
        }
    }
};
