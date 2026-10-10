import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import cn from "@ui/utils/cn";
import { formatDate } from "@ui/utils/locale-format";
import { ChevronDownIcon, FileSpreadsheetIcon, FilterIcon, SearchIcon } from "lucide-react";
import * as React from "react";

import type { CsvTableLabels, SortConfig } from "./csv-table";
import { CsvTable } from "./csv-table";

const getNextSortDirection = (direction: SortConfig["direction"]): SortConfig["direction"] => {
    if (direction === "asc") {
        return "desc";
    }

    return direction === "desc" ? null : "asc";
};

interface XlsxRendererLabels extends CsvTableLabels {
    /** Fallback column name, e.g. "Column 3" */
    columnFallback?: (index: number) => string;
    /** Columns button (default: "Columns") */
    columns?: string;
    /** Empty sheet description (default: "This sheet appears to be empty.") */
    emptySheetDescription?: string;
    /** Error heading (default: "Failed to load spreadsheet") */
    errorTitle?: string;
    /** Loading state (default: "Loading spreadsheet…") */
    loading?: string;
    /** Next page button (default: "Next") */
    next?: string;
    /** Empty or unparseable description (default: "This spreadsheet appears to be empty or could not be parsed.") */
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
    /** Toolbar title (default: "Spreadsheet") */
    title?: string;
}

interface XlsxRendererProps {
    className?: string;
    /** Display name for the file */
    fileName?: string;
    /** Override labels for i18n */
    labels?: XlsxRendererLabels;
    /** The file to render. Can be a File object, ArrayBuffer, or a URL/blob URL string to fetch from. */
    source: File | ArrayBuffer | string;
}

type FileFormat = "xlsx" | "xls" | "unknown";

interface ParsedSheet {
    data: Record<string, unknown>[];
    headers: string[];
}

interface ParsedWorkbook {
    sheetNames: string[];
    sheets: ParsedSheet[];
}

const EMPTY_WORKBOOK: ParsedWorkbook = { sheetNames: [], sheets: [] };

/**
 * Detect Excel file format from magic bytes.
 */
const detectExcelFormat = (buffer: ArrayBuffer): FileFormat => {
    const view = new Uint8Array(buffer);

    // XLSX/ZIP signature: PK (0x50 0x4B 0x03 0x04)
    if (view.length >= 4 && view[0] === 0x50 && view[1] === 0x4b && view[2] === 0x03 && view[3] === 0x04) {
        return "xlsx";
    }

    // XLS/OLE signature: D0 CF 11 E0 A1 B1 1A E1
    if (
        view.length >= 8 &&
        view[0] === 0xd0 &&
        view[1] === 0xcf &&
        view[2] === 0x11 &&
        view[3] === 0xe0 &&
        view[4] === 0xa1 &&
        view[5] === 0xb1 &&
        view[6] === 0x1a &&
        view[7] === 0xe1
    ) {
        return "xls";
    }

    return "unknown";
};

const extractHeaders = (firstRow: unknown[], columnFallback?: (index: number) => string): string[] =>
    firstRow.map((h, index) => {
        if (h != null && h !== "") {
            return String(h);
        }

        return columnFallback ? columnFallback(index + 1) : `Column ${index + 1}`;
    });

const rowsToData = (headers: string[], rows: unknown[][], locale: string): Record<string, unknown>[] => {
    const dataRows = rows.filter((row) => Array.isArray(row) && row.some((cell) => cell != null && cell !== ""));

    return dataRows.map((row) => {
        const object: Record<string, unknown> = {};

        for (const [index, header] of headers.entries()) {
            let value = (row as unknown[])[index];

            if (value instanceof Date) {
                value = formatDate(value, locale);
            }

            object[header] = value ?? "";
        }

        return object;
    });
};

/**
 * Parse XLSX format using xlsx library (fallback for files with inline strings).
 */
const parseXlsxFormatWithXlsxLibrary = async (
    arrayBuffer: ArrayBuffer,
    locale: string,
    columnFallback?: (index: number) => string,
): Promise<ParsedWorkbook> => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(arrayBuffer, { cellDates: true, cellText: false, type: "array" });

    const sheetNames: string[] = workbook.SheetNames ?? [];

    if (sheetNames.length === 0) {
        return EMPTY_WORKBOOK;
    }

    const sheets = sheetNames.map((name) => {
        try {
            const ws = workbook.Sheets[name];

            if (!ws) return { data: [], headers: [] };

            const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { defval: null, header: 1, raw: false });

            if (!rows || rows.length === 0) {
                return { data: [], headers: [] };
            }

            const headers = extractHeaders((rows[0] as unknown[]) ?? [], columnFallback);
            const data = rowsToData(headers, rows.slice(1), locale);

            return { data, headers };
        } catch {
            return { data: [], headers: [] };
        }
    });

    return { sheetNames, sheets };
};

/**
 * Parse XLSX format using read-excel-file (lighter weight, no vulnerabilities)
 * Falls back to xlsx library if inline strings are encountered.
 */
const parseXlsxFormat = async (file: File, arrayBuffer: ArrayBuffer, locale: string, columnFallback?: (index: number) => string): Promise<ParsedWorkbook> => {
    // `read-excel-file/browser`, not the bare specifier: v9's `exports` map has
    // no root entry, only `./browser`, `./node`, `./universal`, `./web-worker`.
    //
    // v9 also REMOVED `readSheetNames()` and made the default export return every
    // sheet as `{ sheet, data }[]` in one pass. The previous code called
    // `readSheetNames(file)`, which does not exist in this version — XLSX import
    // threw at runtime, and only the type error made it visible.
    const { default: readXlsxFile } = await import("read-excel-file/browser");

    try {
        const workbook = await readXlsxFile(file);

        if (workbook.length === 0) {
            return EMPTY_WORKBOOK;
        }

        const sheetNames = workbook.map(({ sheet }) => sheet);

        const sheets = workbook.map(({ data: rows }) => {
            if (rows.length === 0) {
                return { data: [], headers: [] };
            }

            const headers = extractHeaders(rows[0] ?? [], columnFallback);
            const data = rowsToData(headers, rows.slice(1), locale);

            return { data, headers };
        });

        return { sheetNames, sheets };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes("inline string") || errorMessage.includes("inlineStr") || errorMessage === "INLINE_STRING_ERROR") {
            return parseXlsxFormatWithXlsxLibrary(arrayBuffer, locale, columnFallback);
        }

        throw error;
    }
};

/**
 * Parse XLS (old Excel format) using xlsx library.
 */
const parseXlsFormat = async (arrayBuffer: ArrayBuffer, locale: string, columnFallback?: (index: number) => string): Promise<ParsedWorkbook> => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(arrayBuffer, { type: "array" });

    const sheetNames: string[] = workbook.SheetNames ?? [];

    if (sheetNames.length === 0) {
        return EMPTY_WORKBOOK;
    }

    const sheets = sheetNames.map((name) => {
        try {
            const ws = workbook.Sheets[name];

            if (!ws) return { data: [], headers: [] };

            const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { defval: null, header: 1 });

            if (!rows || rows.length === 0) {
                return { data: [], headers: [] };
            }

            const headers = extractHeaders((rows[0] as unknown[]) ?? [], columnFallback);
            const data = rowsToData(headers, rows.slice(1), locale);

            return { data, headers };
        } catch {
            return { data: [], headers: [] };
        }
    });

    return { sheetNames, sheets };
};

const resolveArrayBuffer = async (source: File | ArrayBuffer | string): Promise<ArrayBuffer> => {
    if (source instanceof ArrayBuffer) {
        return source;
    }

    if (source instanceof File) {
        return source.arrayBuffer();
    }

    // string URL
    const response = await fetch(source);

    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

    return response.arrayBuffer();
};

const XlsxRenderer = ({ className, fileName, labels, source }: XlsxRendererProps) => {
    const { i18n, t } = useLingui();
    const defaultColumnFallback = React.useCallback((index: number) => t`Column ${index}`, [t]);
    const columnFallback = labels?.columnFallback ?? defaultColumnFallback;
    const [sheetIndex, setSheetIndex] = React.useState(0);
    const [searchTerm, setSearchTerm] = React.useState("");
    const [hiddenColumns, setHiddenColumns] = React.useState<Set<string>>(new Set());
    const [currentPage, setCurrentPage] = React.useState(1);
    const rowsPerPage = 50;
    const [sortConfig, setSortConfig] = React.useState<SortConfig>({ column: "", direction: null });
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [parsed, setParsed] = React.useState<ParsedWorkbook>(EMPTY_WORKBOOK);

    React.useEffect(() => {
        let cancelled = false;

        const load = async () => {
            try {
                setIsLoading(true);
                setError(null);
                setHiddenColumns(new Set());
                setCurrentPage(1);
                setSortConfig({ column: "", direction: null });
                setSheetIndex(0);

                const arrayBuffer = await resolveArrayBuffer(source);

                if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                    throw new Error("Empty file received");
                }

                const format = detectExcelFormat(arrayBuffer);

                let result: ParsedWorkbook;

                if (format === "xlsx") {
                    const file =
                        source instanceof File
                            ? source
                            : new File([arrayBuffer], fileName ?? "spreadsheet.xlsx", {
                                  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                              });

                    result = await parseXlsxFormat(file, arrayBuffer, i18n.locale, columnFallback);
                } else if (format === "xls") {
                    result = await parseXlsFormat(arrayBuffer, i18n.locale, columnFallback);
                } else {
                    throw new Error("Unknown file format. Expected XLS or XLSX file.");
                }

                if (!cancelled) {
                    if (!result.sheets || result.sheets.length === 0) {
                        setError(t`No sheets found in spreadsheet`);
                        setParsed(EMPTY_WORKBOOK);
                    } else {
                        setParsed(result);
                    }

                    setIsLoading(false);
                }
            } catch (error_: unknown) {
                if (!cancelled) {
                    setError(error_ instanceof Error ? error_.message : t`Failed to load spreadsheet`);
                    setParsed(EMPTY_WORKBOOK);
                    setIsLoading(false);
                }
            }
        };

        load();

        return () => {
            cancelled = true;
        };
    }, [source, fileName, columnFallback, i18n.locale, t]);

    const currentSheet = parsed.sheets[sheetIndex] ?? { data: [], headers: [] };

    const processedData = React.useMemo(() => {
        let filtered = currentSheet.data;

        if (searchTerm) {
            const term = searchTerm.toLowerCase();

            filtered = filtered.filter((row) =>
                Object.entries(row)
                    .filter(([key]) => !hiddenColumns.has(key))
                    .some(([, value]) => value != null && String(value).toLowerCase().includes(term)),
            );
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
    }, [currentSheet.data, searchTerm, sortConfig, hiddenColumns]);

    const totalPages = Math.ceil(processedData.length / rowsPerPage) || 1;
    const startIndex = (currentPage - 1) * rowsPerPage;
    const firstShown = startIndex + 1;
    const lastShown = Math.min(startIndex + rowsPerPage, processedData.length);
    const totalRows = processedData.length.toLocaleString(i18n.locale);
    const paginatedData = processedData.slice(startIndex, startIndex + rowsPerPage);
    const visibleHeaders = currentSheet.headers.filter((h) => !hiddenColumns.has(h));

    const handleSort = React.useCallback((column: string) => {
        setSortConfig((previous) => {
            if (previous.column === column) {
                const next = getNextSortDirection(previous.direction);

                return { column: next ? column : "", direction: next };
            }

            return { column, direction: "asc" };
        });
    }, []);

    const toggleColumnVisibility = React.useCallback((column: string) => {
        setHiddenColumns((previous) => {
            const s = new Set(previous);

            if (s.has(column)) {
                s.delete(column);
            } else {
                s.add(column);
            }

            return s;
        });
    }, []);

    if (isLoading) {
        return (
            <div className={cn("flex size-full items-center justify-center", className)}>
                <div className="text-muted-foreground text-sm">{labels?.loading ?? t`Loading spreadsheet…`}</div>
            </div>
        );
    }

    if (error || parsed.sheets.length === 0 || parsed.sheetNames.length === 0) {
        return (
            <div className={cn("flex size-full items-center justify-center", className)}>
                <div className="space-y-3 text-center">
                    <div className="bg-muted mx-auto flex size-16 items-center justify-center rounded-full">
                        <FileSpreadsheetIcon className="text-muted-foreground size-8" />
                    </div>
                    <div>
                        <h3 className="text-foreground text-lg font-medium">
                            {error ? (labels?.errorTitle ?? t`Failed to load spreadsheet`) : (labels?.noDataTitle ?? t`No Data`)}
                        </h3>
                        {error ? (
                            <p className="text-muted-foreground text-xs">{error}</p>
                        ) : (
                            <p className="text-muted-foreground text-sm">
                                {labels?.noDataDescription ?? t`This spreadsheet appears to be empty or could not be parsed.`}
                            </p>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    const hasHeaders = currentSheet.headers.length > 0;
    const hasData = currentSheet.data.length > 0;

    if (!hasHeaders && !hasData) {
        return (
            <div className={cn("flex size-full items-center justify-center", className)}>
                <div className="space-y-3 text-center">
                    <div className="bg-muted mx-auto flex size-16 items-center justify-center rounded-full">
                        <FileSpreadsheetIcon className="text-muted-foreground size-8" />
                    </div>
                    <div>
                        <h3 className="text-foreground text-lg font-medium">{labels?.noDataTitle ?? t`No Data`}</h3>
                        <p className="text-muted-foreground text-sm">{labels?.emptySheetDescription ?? t`This sheet appears to be empty.`}</p>
                    </div>
                </div>
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
                            <h3 className="text-foreground font-medium">{labels?.title ?? t`Spreadsheet`}</h3>
                            <p className="text-muted-foreground text-xs">
                                {labels?.rowsColumnsInfo ? (
                                    labels.rowsColumnsInfo(processedData.length, visibleHeaders.length)
                                ) : (
                                    <Trans>
                                        - <Plural one="# row" other="# rows" value={processedData.length} />,{" "}
                                        <Plural one="# column" other="# columns" value={visibleHeaders.length} />
                                    </Trans>
                                )}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Sheet selector */}
                        {parsed.sheetNames.length > 1 && (
                            <DropdownMenu>
                                <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
                                    <ChevronDownIcon className="mr-1 size-4" />
                                    {parsed.sheetNames[sheetIndex] ?? t`Sheet 1`}
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-40">
                                    {parsed.sheetNames.map((name, index) => (
                                        <DropdownMenuItem
                                            key={name}
                                            onClick={() => {
                                                setSheetIndex(index);
                                                setHiddenColumns(new Set());
                                                setCurrentPage(1);
                                                setSortConfig({ column: "", direction: null });
                                            }}
                                        >
                                            {name}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}

                        <Badge className="text-xs" variant="outline">
                            {labels?.pageInfo ? labels.pageInfo(currentPage, totalPages) : t`Page ${currentPage} of ${totalPages}`}
                        </Badge>

                        {/* Column visibility */}
                        <DropdownMenu>
                            <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
                                <FilterIcon className="mr-1 size-4" />
                                {labels?.columns ?? t`Columns`}
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <div className="px-2 py-1.5 text-sm font-medium">{labels?.showHideColumns ?? t`Show/Hide Columns`}</div>
                                <DropdownMenuSeparator />
                                {currentSheet.headers.map((h) => (
                                    <DropdownMenuCheckboxItem checked={!hiddenColumns.has(h)} key={h} onCheckedChange={() => toggleColumnVisibility(h)}>
                                        {h}
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

                                    if (totalPages <= 5 || currentPage <= 3) pageNumber = index + 1;
                                    else if (currentPage >= totalPages - 2) pageNumber = totalPages - 4 + index;
                                    else pageNumber = currentPage - 2 + index;

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

export { XlsxRenderer, type XlsxRendererLabels, type XlsxRendererProps };
