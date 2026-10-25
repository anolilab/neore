"use client";

/**
 * CSV / TSV preview — code-split, lazy-loaded. Loads the file and shows it with
 * the spreadsheet table (`CsvRenderer`), which detects the delimiter itself.
 *
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const DelimitedTextPreview = lazy(() => import("@neore/ui/components/file-renderers/delimited-text-preview"));
 * ```
 */

import { useFetchedText } from "@ui/hooks/use-fetched-text";
import cn from "@ui/utils/cn";
import type { FC } from "react";
import { memo } from "react";

import { CsvRenderer } from "../spreadsheet/csv-renderer";
import { TextFileLoading, TextFileUnavailable } from "./text-file-states";

export interface DelimitedTextPreviewProps {
    className?: string;
    filename?: string;
    url: string;
}

const DelimitedTextPreview: FC<DelimitedTextPreviewProps> = memo(({ className, filename, url }) => {
    const fetched = useFetchedText(url);

    if (fetched.status === "error") {
        return <TextFileUnavailable className={className} filename={filename} url={url} />;
    }

    if (fetched.status === "loading") {
        return <TextFileLoading />;
    }

    // Not `compact`: the compact table renders every row, while this one pages (50 rows) and searches.
    return (
        <div className={cn("my-2 h-[420px] w-full max-w-2xl overflow-hidden rounded-lg border", className)}>
            <CsvRenderer content={fetched.text} />
        </div>
    );
});

DelimitedTextPreview.displayName = "DelimitedTextPreview";

export default DelimitedTextPreview;
