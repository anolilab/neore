import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import cn from "@ui/utils/cn";
import { FileSpreadsheetIcon, FilterIcon, SearchIcon } from "lucide-react";
import Papa from "papaparse";
import * as React from "react";

import type { CsvTableLabels, SortConfig } from "./csv-table";
import { CsvTable } from "./csv-table";

const getNextSortDirection = (direction: SortConfig["direction"]): SortConfig["direction"] => {
    if (direction === "asc") {
        return "desc";
    }

    return direction === "desc" ? null : "asc";
};

interface CsvRendererLabels extends CsvTableLabels {
    /** Columns button (default: "Columns") */
    columns?: string;
    /** Filtered from total, e.g. "(filtered from 200)" */
    filteredFrom?: (total: number) => string;
    /** Next page button (default: "Next") */
    next?: string;
    /** Compact empty state (default: "No data") */
    noData?: string;
    /** Empty state description (default: "This CSV file appears to be empty or invalid.") */
    noDataDescription?: string;
    /** Empty state heading (default: "No Data") */
    noDataTitle?: string;
    /** Page badge, e.g. "Page 1 of 10" */
    pageInfo?: (current: number, total: number) => string;
    /** Previous page button (default: "Previous") */
    previous?: string;
    /** Row/column info, e.g. "- 100 rows, 5 columns" */
    rowsColumnsInfo?: (rows: number, columns: number) => string;
    /** Search input placeholder (default: "Search data...") */
    searchPlaceholder?: string;
    /** Column visibility dropdown title (default: "Show/Hide Columns") */
    showHideColumns?: string;
    /** Pagination summary, e.g. "Showing 1 to 50 of 200 rows" */
    showingInfo?: (from: number, to: number, total: number) => string;
    /** Toolbar title (default: "CSV Data") */
    title?: string;
}

interface CsvRendererProps {
    className?: string;
    /** Compact mode for inline previews - hides search, pagination, column controls */
    compact?: boolean;
    /** Fixed container height for compact mode */
    containerHeight?: number;
    content: string;
    /** Override labels for i18n */
    labels?: CsvRendererLabels;
}

const parseCSV = (content: string): { data: Record<string, unknown>[]; headers: string[] } => {
    if (!content) return { data: [], headers: [] };

    try {
        const results = Papa.parse<Record<string, unknown>>(content, {
            dynamicTyping: true,
            header: true,
            skipEmptyLines: true,
        });

        const headers = results.meta?.fields ?? [];

        return {
            data: results.data,
            headers,
        };
    } catch (error) {
        console.error("Error parsing CSV:", error);

        return { data: [], headers: [] };
    }
};

const CsvRenderer = ({ className, compact = false, containerHeight = 300, content, labels }: CsvRendererProps) => {
    const { i18n, t } = useLingui();
    const [searchTerm, setSearchTerm] = React.useState("");
    const [sortConfig, setSortConfig] = React.useState<SortConfig>({ column: "", direction: null });
    const [hiddenColumns, setHiddenColumns] = React.useState<Set<string>>(new Set());
    const [currentPage, setCurrentPage] = React.useState(1);
    const rowsPerPage = 50;

    const parsedData = React.useMemo(() => parseCSV(content), [content]);
    const unfilteredRows = parsedData.data.length.toLocaleString(i18n.locale);
    const filteredFromLabel = t`(filtered from ${unfilteredRows})`;
    const isEmpty = parsedData.data.length === 0;

    const processedData = React.useMemo(() => {
        let filtered = parsedData.data;

        if (searchTerm) {
            const term = searchTerm.toLowerCase();

            filtered = filtered.filter((row) => Object.values(row).some((value) => value != null && String(value).toLowerCase().includes(term)));
        }

        if (sortConfig.column && sortConfig.direction) {
            filtered = [...filtered];

            filtered.sort((a, b) => {
                const aValue = a[sortConfig.column];
                const bValue = b[sortConfig.column];

                if (aValue == null && bValue == null) {
                    return 0;
                }

                if (aValue == null) {
                    return sortConfig.direction === "asc" ? -1 : 1;
                }

                if (bValue == null) {
                    return sortConfig.direction === "asc" ? 1 : -1;
                }

                if (typeof aValue === "number" && typeof bValue === "number") {
                    return sortConfig.direction === "asc" ? aValue - bValue : bValue - aValue;
                }

                const aString = String(aValue).toLowerCase();
                const bString = String(bValue).toLowerCase();

                if (aString < bString) {
                    return sortConfig.direction === "asc" ? -1 : 1;
                }

                if (aString > bString) {
                    return sortConfig.direction === "asc" ? 1 : -1;
                }

                return 0;
            });
        }

        return filtered;
    }, [parsedData.data, searchTerm, sortConfig]);

    const totalPages = Math.ceil(processedData.length / rowsPerPage);
    const startIndex = (currentPage - 1) * rowsPerPage;
    const firstShown = startIndex + 1;
    const lastShown = Math.min(startIndex + rowsPerPage, processedData.length);
    const totalRows = processedData.length.toLocaleString(i18n.locale);
    const paginatedData = processedData.slice(startIndex, startIndex + rowsPerPage);

    const visibleHeaders = parsedData.headers.filter((header) => !hiddenColumns.has(header));

    const handleSort = React.useCallback((column: string) => {
        setSortConfig((previous) => {
            if (previous.column === column) {
                const newDirection = getNextSortDirection(previous.direction);

                return { column: newDirection ? column : "", direction: newDirection };
            }

            return { column, direction: "asc" };
        });
    }, []);

    const toggleColumnVisibility = React.useCallback((column: string) => {
        setHiddenColumns((previous) => {
            const newSet = new Set(previous);

            if (newSet.has(column)) {
                newSet.delete(column);
            } else {
                newSet.add(column);
            }

            return newSet;
        });
    }, []);

    if (isEmpty) {
        return (
            <div className={cn("flex size-full items-center justify-center", className)}>
                {compact ? (
                    <div className="text-muted-foreground text-sm">{labels?.noData ?? t`No data`}</div>
                ) : (
                    <div className="space-y-4 text-center">
                        <div className="bg-muted mx-auto flex size-16 items-center justify-center rounded-full">
                            <FileSpreadsheetIcon className="text-muted-foreground size-8" />
                        </div>
                        <div>
                            <h3 className="text-foreground text-lg font-medium">{labels?.noDataTitle ?? t`No Data`}</h3>
                            <p className="text-muted-foreground text-sm">{labels?.noDataDescription ?? t`This CSV file appears to be empty or invalid.`}</p>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    if (compact) {
        return (
            <div className={cn("size-full", className)} style={{ height: containerHeight }}>
                <CsvTable data={processedData} headers={visibleHeaders} labels={labels} onSort={handleSort} sortConfig={sortConfig} />
            </div>
        );
    }

    return (
        <div className={cn("bg-background flex size-full flex-col", className)}>
            {/* Toolbar */}
            <div className="bg-muted/30 shrink-0 space-y-3 border-b p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <FileSpreadsheetIcon className="text-primary size-5" />
                        <div className="flex items-center gap-2">
                            <h3 className="text-foreground font-medium">{labels?.title ?? t`CSV Data`}</h3>
                            <p className="text-muted-foreground text-xs">
                                {labels?.rowsColumnsInfo ? (
                                    labels.rowsColumnsInfo(processedData.length, visibleHeaders.length)
                                ) : (
                                    <Trans>
                                        - <Plural one="# row" other="# rows" value={processedData.length} />,{" "}
                                        <Plural one="# column" other="# columns" value={visibleHeaders.length} />
                                    </Trans>
                                )}
                                {searchTerm && (labels?.filteredFrom ? ` ${labels.filteredFrom(parsedData.data.length)}` : ` ${filteredFromLabel}`)}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Badge className="text-xs" variant="outline">
                            {labels?.pageInfo ? labels.pageInfo(currentPage, totalPages) : t`Page ${currentPage} of ${totalPages}`}
                        </Badge>

                        <DropdownMenu>
                            <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
                                <FilterIcon className="mr-1 size-4" />
                                {labels?.columns ?? t`Columns`}
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <div className="px-2 py-1.5 text-sm font-medium">{labels?.showHideColumns ?? t`Show/Hide Columns`}</div>
                                <DropdownMenuSeparator />
                                {parsedData.headers.map((header) => (
                                    <DropdownMenuCheckboxItem
                                        checked={!hiddenColumns.has(header)}
                                        key={header}
                                        onCheckedChange={() => toggleColumnVisibility(header)}
                                    >
                                        {header}
                                    </DropdownMenuCheckboxItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>

                <div className="relative">
                    <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                    <Input
                        className="pl-9"
                        onChange={(event) => {
                            setSearchTerm((event.target as HTMLInputElement).value);
                            setCurrentPage(1);
                        }}
                        placeholder={labels?.searchPlaceholder ?? t`Search data...`}
                        value={searchTerm}
                    />
                </div>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-hidden">
                <div className="size-full overflow-auto">
                    <CsvTable
                        data={paginatedData}
                        headers={visibleHeaders}
                        labels={labels}
                        onClearSearch={() => setSearchTerm("")}
                        onSort={handleSort}
                        searchTerm={searchTerm}
                        sortConfig={sortConfig}
                    />
                </div>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="bg-muted/30 shrink-0 border-t p-4">
                    <div className="flex items-center justify-between">
                        <div className="text-muted-foreground text-sm">
                            {labels?.showingInfo
                                ? labels.showingInfo(startIndex + 1, Math.min(startIndex + rowsPerPage, processedData.length), processedData.length)
                                : t`Showing ${firstShown} to ${lastShown} of ${totalRows} rows`}
                        </div>

                        <div className="flex items-center gap-2">
                            <Button disabled={currentPage === 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} size="sm" variant="outline">
                                {labels?.previous ?? t`Previous`}
                            </Button>

                            <div className="flex items-center gap-1">
                                {Array.from({ length: Math.min(5, totalPages) }, (_, index) => {
                                    let pageNumber: number;

                                    if (totalPages <= 5 || currentPage <= 3) {
                                        pageNumber = index + 1;
                                    } else if (currentPage >= totalPages - 2) {
                                        pageNumber = totalPages - 4 + index;
                                    } else {
                                        pageNumber = currentPage - 2 + index;
                                    }

                                    return (
                                        <Button
                                            className="size-8 p-0"
                                            key={pageNumber}
                                            onClick={() => setCurrentPage(pageNumber)}
                                            size="sm"
                                            variant={currentPage === pageNumber ? "default" : "outline"}
                                        >
                                            {pageNumber}
                                        </Button>
                                    );
                                })}
                            </div>

                            <Button
                                disabled={currentPage === totalPages}
                                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                size="sm"
                                variant="outline"
                            >
                                {labels?.next ?? t`Next`}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export { CsvRenderer, type CsvRendererLabels, type CsvRendererProps };
