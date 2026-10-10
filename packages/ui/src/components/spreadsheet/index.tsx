export { CsvRenderer, type CsvRendererLabels, type CsvRendererProps } from "./csv-renderer";
export { CsvTable, type CsvTableLabels, type CsvTableProps, type SortConfig } from "./csv-table";
export { default as SpreadsheetThumbnail, type SpreadsheetThumbnailProps } from "./spreadsheet-thumbnail";
export { csvToUniverWorkbook, type UniverWorkbookData, univerWorkbookToCsv } from "./univer-utilities";
export { XlsxRenderer, type XlsxRendererLabels, type XlsxRendererProps } from "./xlsx-renderer";

/**
 * UniverSheetEditor is NOT exported from this barrel to keep it code-split.
 * Import it directly via lazy loading:
 *
 * ```tsx
 * const UniverSheetEditor = lazy(() => import("@neore/ui/components/spreadsheet/univer-sheet-editor"));
 * ```
 *
 * XLSX conversion utilities (xlsxFileToCSV, downloadAsXlsx) are also code-split.
 * Import them directly:
 *
 * ```ts
 * const { xlsxFileToCSV, downloadAsXlsx } = await import("@neore/ui/components/spreadsheet/xlsx-convert");
 * ```
 */
