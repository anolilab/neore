"use client";

/**
 * Canvas Sheet Viewer - Renders CSV data as a simple table.
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

interface CanvasSheetViewerProps {
    className?: string;
    content: string;
}

const parseCSV = (csv: string): string[][] => {
    const rows: string[][] = [];
    const lines = csv.split("\n");

    for (const line of lines) {
        if (line.trim() === "") {
            continue;
        }

        const cells: string[] = [];
        let current = "";
        let isInQuotes = false;

        for (let i = 0; i < line.length; i += 1) {
            const char = line[i];

            if (char === '"') {
                if (isInQuotes && line[i + 1] === '"') {
                    current += '"';
                    i += 1;
                } else {
                    isInQuotes = !isInQuotes;
                }
            } else if (char === "," && !isInQuotes) {
                cells.push(current.trim());
                current = "";
            } else {
                current += char;
            }
        }

        cells.push(current.trim());
        rows.push(cells);
    }

    return rows;
};

const CanvasSheetViewer: FC<CanvasSheetViewerProps> = ({ className, content }) => {
    const { t } = useLingui();
    const rows = parseCSV(content);
    const headers = rows[0] ?? [];
    const dataRows = rows.slice(1);

    if (rows.length === 0) {
        return (
            <div className="flex h-full items-center justify-center p-4">
                <span className="text-muted-foreground text-sm">{t`No data`}</span>
            </div>
        );
    }

    return (
        <div className={cn("overflow-auto", className)}>
            <table className="w-full border-collapse text-sm">
                <thead>
                    <tr className="bg-muted/50 border-b">
                        {headers.map((header, i) => (
                            <th className="border-r px-3 py-2 text-left font-medium whitespace-nowrap last:border-r-0" key={i}>
                                {header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {dataRows.map((row, rowIndex) => (
                        <tr className="hover:bg-muted/30 border-b last:border-b-0" key={rowIndex}>
                            {row.map((cell, cellIndex) => (
                                <td className="border-r px-3 py-1.5 whitespace-nowrap last:border-r-0" key={cellIndex}>
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

CanvasSheetViewer.displayName = "CanvasSheetViewer";
export default CanvasSheetViewer;
