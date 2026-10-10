import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import cn from "@ui/utils/cn";
import { formatNumber } from "@ui/utils/locale-format";
import { ArrowUpDownIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

interface SortConfig {
    column: string;
    direction: "asc" | "desc" | null;
}

interface CsvTableLabels {
    /** Boolean false display (default: "No") */
    booleanFalse?: string;
    /** Boolean true display (default: "Yes") */
    booleanTrue?: string;
    /** Clear search button (default: "Clear search") */
    clearSearch?: string;
    /** Empty search state message. Receives the search term. (default: (term) => `No results found for "${term}"`) */
    noResultsFor?: (searchTerm: string) => string;
}

interface CsvTableProps {
    className?: string;
    data: Record<string, unknown>[];
    headers: string[];
    labels?: CsvTableLabels;
    onClearSearch?: () => void;
    onSort: (column: string) => void;
    searchTerm?: string;
    sortConfig: SortConfig;
}

const formatCellValue = (value: unknown, locale: string, booleanTrue: string, booleanFalse: string): string => {
    if (value == null) {
        return "";
    }

    if (typeof value === "number") {
        return formatNumber(value, locale);
    }

    if (typeof value === "boolean") {
        return value ? booleanTrue : booleanFalse;
    }

    return String(value);
};

const getCellClassName = (value: unknown): string => {
    if (typeof value === "number") {
        return "text-right font-mono";
    }

    if (typeof value === "boolean") {
        return value ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
    }

    return "";
};

const CsvTable = ({ className, data, headers, labels, onClearSearch, onSort, searchTerm, sortConfig }: CsvTableProps) => {
    const { i18n, t } = useLingui();
    const getSortIcon = (column: string) => {
        if (sortConfig.column !== column) {
            return <ArrowUpDownIcon className="text-muted-foreground size-3" />;
        }

        return sortConfig.direction === "asc" ? <ChevronUpIcon className="text-primary size-3" /> : <ChevronDownIcon className="text-primary size-3" />;
    };

    return (
        <div className={cn("!bg-card relative size-full", className)}>
            <div
                className="relative size-full min-h-full overflow-auto"
                style={{
                    backgroundAttachment: "local",
                    backgroundColor: "hsl(var(--muted))",
                    backgroundImage: `
                        repeating-linear-gradient(
                            to right,
                            transparent 0px,
                            transparent 149px,
                            hsl(var(--border)) 149px,
                            hsl(var(--border)) 150px
                        ),
                        repeating-linear-gradient(
                            to bottom,
                            transparent 0px,
                            transparent 47px,
                            hsl(var(--border)) 47px,
                            hsl(var(--border)) 48px
                        )
                    `,
                    backgroundPosition: "0 0",
                    backgroundSize: `${(headers.length - 1) * 150 + 149}px 48px, 150px 48px`,
                    display: "grid",
                    gridAutoRows: "48px",
                    gridTemplateColumns: `repeat(${headers.length}, 150px)`,
                    minHeight: "100%",
                }}
            >
                {/* Sticky header filler for overflow area */}
                <div
                    className="bg-background pointer-events-none sticky top-0 z-10"
                    style={{
                        height: "48px",
                        left: `${headers.length * 150}px`,
                        position: "absolute",
                        right: 0,
                        top: 0,
                    }}
                />

                {/* Header cells */}
                {headers.map((header, index) => (
                    <div
                        className="bg-background sticky top-0 z-20 flex items-center px-4 font-medium"
                        key={`header-${header}-${index}`}
                        style={{
                            gridColumn: index + 1,
                            gridRow: 1,
                            height: "48px",
                        }}
                    >
                        <button
                            className="group hover:text-primary flex w-full items-center gap-2 text-left transition-colors"
                            onClick={() => onSort(header)}
                            type="button"
                        >
                            <span className="truncate">{header}</span>
                            <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">{getSortIcon(header)}</div>
                        </button>
                    </div>
                ))}

                {/* Data cells */}
                {data.map((row, rowIndex) =>
                    headers.map((header, cellIndex) => {
                        const value = row[header];

                        return (
                            <div
                                className={cn("hover:bg-muted/30 flex items-center px-4 text-sm transition-colors", getCellClassName(value))}
                                key={`${rowIndex}-${cellIndex}`}
                                style={{
                                    gridColumn: cellIndex + 1,
                                    gridRow: rowIndex + 2,
                                    height: "48px",
                                }}
                            >
                                <div className="w-full truncate" title={String(value ?? "")}>
                                    {formatCellValue(value, i18n.locale, labels?.booleanTrue ?? t`Yes`, labels?.booleanFalse ?? t`No`)}
                                </div>
                            </div>
                        );
                    }),
                )}

                {/* Empty search state */}
                {data.length === 0 && searchTerm && (
                    <div
                        className="text-muted-foreground col-span-full py-8 text-center"
                        style={{
                            gridColumn: `1 / ${headers.length + 1}`,
                            gridRow: 2,
                        }}
                    >
                        <div className="space-y-2">
                            <p>{labels?.noResultsFor ? labels.noResultsFor(searchTerm) : t`No results found for “${searchTerm}”`}</p>
                            {onClearSearch && (
                                <Button onClick={onClearSearch} size="sm" variant="outline">
                                    {labels?.clearSearch ?? t`Clear search`}
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export { CsvTable, type CsvTableLabels, type CsvTableProps, type SortConfig };
