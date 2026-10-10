"use client";

/**
 * SpreadsheetThumbnail - Lightweight mini-table preview of CSV data.
 *
 * Shows the first PREVIEW_ROWS × PREVIEW_COLS cells so the user can
 * recognise the spreadsheet at a glance without loading the full editor.
 *
 * Parsing is deferred via IntersectionObserver so off-screen thumbnails
 * never pay the cost.
 */

import { Plural, useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import type { FC } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

const PREVIEW_ROWS = 4;
const PREVIEW_COLS = 4;

interface SpreadsheetThumbnailLabels {
    /** Empty fallback text (default: "Spreadsheet") */
    emptyLabel?: string;
    /** "more rows" indicator, e.g. "+5 more rows" */
    moreRows?: (count: number) => string;
}

export interface SpreadsheetThumbnailProps {
    className?: string;
    /** Raw CSV string (the document content). */
    content: string;
    /** Override labels for i18n */
    labels?: SpreadsheetThumbnailLabels;
}

/** Minimal CSV parser – handles quoted fields, returns string[][]. */
const parseCSVPreview = (csv: string): { headers: string[]; rows: string[][]; totalCols: number; totalRows: number } => {
    const lines = csv.split("\n");
    const parsed: string[][] = [];

    for (const line of lines) {
        if (line.trim() === "") {
            continue;
        }

        const cells: string[] = [];
        let current = "";
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === "," && !inQuotes) {
                cells.push(current.trim());
                current = "";
            } else {
                current += char;
            }
        }

        cells.push(current.trim());
        parsed.push(cells);

        // We only need header + PREVIEW_ROWS data rows for the thumbnail,
        // but we keep scanning lines (cheaply) to report totalRows.
    }

    const headers = parsed[0] ?? [];
    const rows = parsed.slice(1, 1 + PREVIEW_ROWS);
    const totalCols = headers.length;
    // totalRows = data rows only (exclude header)
    const totalRows = Math.max(0, parsed.length - 1);

    return { headers, rows, totalCols, totalRows };
};

const SpreadsheetThumbnail: FC<SpreadsheetThumbnailProps> = memo(({ className, content, labels }) => {
    const { t } = useLingui();
    const containerRef = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);

    // Lazy-parse only when the thumbnail scrolls into the viewport.
    useEffect(() => {
        const element = containerRef.current;

        if (!element) {
            return undefined;
        }

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (!entry?.isIntersecting) {
                    return;
                }

                setIsVisible(true);
                observer.disconnect();
            },
            { rootMargin: "200px" },
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    const data = useMemo(() => {
        if (!isVisible || !content) {
            return null;
        }

        return parseCSVPreview(content);
    }, [isVisible, content]);

    const visibleHeaders = data ? data.headers.slice(0, PREVIEW_COLS) : [];
    const hasMoreCols = data ? data.totalCols > PREVIEW_COLS : false;
    const hasMoreRows = data ? data.totalRows > PREVIEW_ROWS : false;
    const extraRowCount = (data?.totalRows ?? 0) - PREVIEW_ROWS;

    return (
        <div className={cn("w-full overflow-hidden rounded-md border", className)} ref={containerRef}>
            {data && visibleHeaders.length > 0 ? (
                <table className="w-full table-fixed border-collapse text-[10px] leading-tight">
                    <thead>
                        <tr className="bg-muted/60">
                            {visibleHeaders.map((h, i) => (
                                <th className="text-muted-foreground truncate border-r border-b px-1.5 py-1 text-left font-medium last:border-r-0" key={i}>
                                    {h}
                                </th>
                            ))}
                            {hasMoreCols && <th className="text-muted-foreground w-6 border-b px-1 py-1 text-center font-normal">&hellip;</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {data.rows.map((row, ri) => (
                            <tr className="even:bg-muted/20" key={ri}>
                                {visibleHeaders.map((_, ci) => (
                                    <td className="truncate border-r px-1.5 py-0.5 last:border-r-0" key={ci}>
                                        {row[ci] ?? ""}
                                    </td>
                                ))}
                                {hasMoreCols && <td className="text-muted-foreground px-1 py-0.5 text-center">&hellip;</td>}
                            </tr>
                        ))}
                        {hasMoreRows && (
                            <tr>
                                <td
                                    className="text-muted-foreground border-t px-1.5 py-0.5 text-center"
                                    colSpan={visibleHeaders.length + (hasMoreCols ? 1 : 0)}
                                >
                                    {labels?.moreRows ? (
                                        labels.moreRows(extraRowCount)
                                    ) : (
                                        <Plural one="+# more row" other="+# more rows" value={extraRowCount} />
                                    )}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            ) : (
                <div className="bg-muted/30 flex h-16 items-center justify-center">
                    <span className="text-muted-foreground text-[10px]">{labels?.emptyLabel ?? t`Spreadsheet`}</span>
                </div>
            )}
        </div>
    );
});

SpreadsheetThumbnail.displayName = "SpreadsheetThumbnail";

export default SpreadsheetThumbnail;
