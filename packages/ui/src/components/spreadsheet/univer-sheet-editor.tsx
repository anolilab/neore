/**
 * Univer Sheet Editor - Interactive spreadsheet editor powered by Univer.
 *
 * IMPORTANT: This component should be lazy-loaded to avoid bundling Univer
 * in the main chunk. Use React.lazy() or dynamic import.
 * @example
 * ```tsx
 * const UniverSheetEditor = lazy(() => import("@neore/ui/components/spreadsheet/univer-sheet-editor"));
 * ```
 */

import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-filter/lib/index.css";
import "@univerjs/preset-sheets-sort/lib/index.css";
import "@univerjs/preset-sheets-find-replace/lib/index.css";

import cn from "@ui/utils/cn";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import { UniverSheetsFilterPreset } from "@univerjs/preset-sheets-filter";
import UniverPresetSheetsFilterEnUS from "@univerjs/preset-sheets-filter/locales/en-US";
import { UniverSheetsFindReplacePreset } from "@univerjs/preset-sheets-find-replace";
import UniverPresetSheetsFindReplaceEnUS from "@univerjs/preset-sheets-find-replace/locales/en-US";
import { UniverSheetsSortPreset } from "@univerjs/preset-sheets-sort";
import UniverPresetSheetsSortEnUS from "@univerjs/preset-sheets-sort/locales/en-US";
import { createUniver, defaultTheme, LocaleType, mergeLocales } from "@univerjs/presets";
import { useCallback, useEffect, useRef } from "react";

import type { UniverWorkbookData } from "./univer-utilities";
import { csvToUniverWorkbook, univerWorkbookToCsv } from "./univer-utilities";

interface UniverSheetEditorProps {
    /** Debounce delay in ms for auto-save (default: 1500) */
    autoSaveDebounceMs?: number;
    /** Additional CSS class */
    className?: string;
    /** CSV content to load into the editor */
    content: string;
    /** Whether the editor is in dark mode */
    darkMode?: boolean;
    /** Debounced callback when content changes. Receives the CSV string. */
    onContentChange?: (csv: string) => void;
    /** Document title */
    title?: string;
}

const AUTOSAVE_DEBOUNCE_MS = 1500;

export const UniverSheetEditor = ({
    autoSaveDebounceMs = AUTOSAVE_DEBOUNCE_MS,
    className,
    content,
    darkMode = false,
    onContentChange,
    title,
}: UniverSheetEditorProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const univerAPIRef = useRef<ReturnType<typeof createUniver>["univerAPI"] | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contentRef = useRef(content);
    const onContentChangeRef = useRef(onContentChange);

    // Keep the ref in sync after commit, never during render. Declared before the
    // mount effect below, so that effect already sees the current callback.
    useEffect(() => {
        onContentChangeRef.current = onContentChange;
    }, [onContentChange]);

    useEffect(() => {
        if (!containerRef.current) {
            return undefined;
        }

        const { univerAPI } = createUniver({
            darkMode,
            locale: LocaleType.EN_US,
            locales: {
                [LocaleType.EN_US]: mergeLocales(
                    UniverPresetSheetsCoreEnUS,
                    UniverPresetSheetsFilterEnUS,
                    UniverPresetSheetsSortEnUS,
                    UniverPresetSheetsFindReplaceEnUS,
                ),
            },
            presets: [
                UniverSheetsCorePreset({
                    container: containerRef.current,
                }),
                UniverSheetsFilterPreset(),
                UniverSheetsSortPreset(),
                UniverSheetsFindReplacePreset(),
            ],
            theme: defaultTheme,
        });

        univerAPIRef.current = univerAPI;

        // Load initial data
        const workbookData = csvToUniverWorkbook(contentRef.current, title);

        univerAPI.createWorkbook(workbookData);

        // Subscribe to cell changes for auto-save
        if (onContentChangeRef.current) {
            const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, () => {
                if (!onContentChangeRef.current) {
                    return;
                }

                if (debounceRef.current) {
                    clearTimeout(debounceRef.current);
                }

                debounceRef.current = setTimeout(() => {
                    const workbook = univerAPI.getActiveWorkbook();

                    if (!workbook) {
                        return;
                    }

                    const snapshot = workbook.save() as unknown as UniverWorkbookData;
                    const csv = univerWorkbookToCsv(snapshot);

                    onContentChangeRef.current?.(csv);
                }, autoSaveDebounceMs);
            });

            return () => {
                if (debounceRef.current) {
                    clearTimeout(debounceRef.current);
                }

                subscription?.dispose();
                univerAPI.dispose();
                univerAPIRef.current = null;
            };
        }

        return () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }

            univerAPI.dispose();
            univerAPIRef.current = null;
        };
    }, [darkMode, title, autoSaveDebounceMs]);

    // Provide a method to get current CSV content
    const getCurrentCsv = useCallback((): string => {
        const workbook = univerAPIRef.current?.getActiveWorkbook();

        if (!workbook) {
            return contentRef.current;
        }

        const snapshot = workbook.save() as unknown as UniverWorkbookData;

        return univerWorkbookToCsv(snapshot);
    }, []);

    // Expose getCurrentCsv via a data attribute for parent access
    useEffect(() => {
        const container = containerRef.current;

        if (container) {
            (container as any).__getCurrentCsv = getCurrentCsv;
        }

        return () => {
            if (container) {
                delete (container as any).__getCurrentCsv;
            }
        };
    }, [getCurrentCsv]);

    return <div className={cn("size-full", className)} ref={containerRef} style={{ minHeight: "400px" }} />;
};

export { type UniverSheetEditorProps };
