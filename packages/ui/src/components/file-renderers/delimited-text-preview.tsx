"use client";

/**
 * CSV / TSV preview — code-split, lazy-loaded. Loads the file and shows it with
 * the spreadsheet table (`CsvRenderer`), which detects the delimiter itself.
 * Only the first 50 columns are shown, and a file over 1 MB is not read at all
 * (the download card shows).
 *
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const DelimitedTextPreview = lazy(() => import("@neore/ui/components/file-renderers/delimited-text-preview"));
 * ```
 */

import { Plural, useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { memo, useMemo } from "react";

import { CsvRenderer } from "../spreadsheet/csv-renderer";
import { capDelimitedColumns } from "./delimited-columns";
import { FetchedTextPreview } from "./fetched-text-preview";

export interface DelimitedTextPreviewProps {
    className?: string;
    filename?: string;
    url: string;
}

/** Columns shown. Each costs a header cell and a cell per row, and a file can have hundreds of thousands. */
const MAX_PREVIEW_COLUMNS = 50;

const DelimitedTable: FC<{ text: string }> = ({ text }) => {
    const { t } = useLingui();
    const { content, hiddenColumns } = useMemo(() => capDelimitedColumns(text, MAX_PREVIEW_COLUMNS), [text]);

    // Not `compact`: the compact table renders every row, while this one pages (50 rows) and searches.
    // The frame already names the file, so the toolbar title is generic: it would read "CSV Data" for a .tsv.
    return (
        <>
            <div className="h-[420px]">
                <CsvRenderer content={content} labels={{ title: t`Table` }} />
            </div>
            {hiddenColumns > 0 && (
                <p className="text-muted-foreground border-t px-3 py-2 text-xs">
                    <Plural one="+# more column is not shown." other="+# more columns are not shown." value={hiddenColumns} />
                </p>
            )}
        </>
    );
};

const DelimitedTextPreview: FC<DelimitedTextPreviewProps> = memo(({ className, filename, url }) => {
    const { t } = useLingui();

    return (
        <FetchedTextPreview className={className} fallbackName={t`Table`} filename={filename} url={url}>
            {(text) => <DelimitedTable text={text} />}
        </FetchedTextPreview>
    );
});

DelimitedTextPreview.displayName = "DelimitedTextPreview";

export default DelimitedTextPreview;
