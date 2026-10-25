"use client";

/**
 * JSON Lines preview — code-split, lazy-loaded.
 * One record per row, each shown with the JSON viewer. Lines that are not JSON
 * are listed by number, and the rows shown are capped so a large file cannot
 * freeze the page.
 *
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const JsonlViewer = lazy(() => import("@neore/ui/components/file-renderers/jsonl-viewer"));
 * ```
 */

import { Plural, useLingui } from "@lingui/react/macro";
import { useFetchedText } from "@ui/hooks/use-fetched-text";
import cn from "@ui/utils/cn";
import type { FC } from "react";
import { memo, useMemo } from "react";

import { JsonViewer } from "./json-viewer";
import { parseJsonLines } from "./jsonl-parse";
import { TextFileLoading, TextFileUnavailable } from "./text-file-states";

export interface JsonlViewerProps {
    className?: string;
    filename?: string;
    url: string;
}

/** Records shown before the preview stops reading. */
const MAX_RECORDS = 200;
/** Bad lines listed before the preview stops reading. */
const MAX_PROBLEMS = 20;

const JsonlViewer: FC<JsonlViewerProps> = memo(({ className, filename, url }) => {
    const { t } = useLingui();
    const fetched = useFetchedText(url);
    const parsed = useMemo(
        () => (fetched.status === "ready" ? parseJsonLines(fetched.text, { maxProblems: MAX_PROBLEMS, maxRecords: MAX_RECORDS }) : undefined),
        [fetched],
    );

    if (fetched.status === "error") {
        return <TextFileUnavailable className={className} filename={filename} url={url} />;
    }

    if (!parsed) {
        return <TextFileLoading />;
    }

    const { problems, records, truncated } = parsed;

    return (
        <div className={cn("my-2 w-full max-w-2xl overflow-hidden rounded-lg border", className)}>
            <div className="bg-muted/50 flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
                <span className="truncate font-medium">{filename || t`JSON Lines`}</span>
                <span className="text-muted-foreground shrink-0">
                    <Plural one="# record" other="# records" value={records.length} />
                </span>
            </div>

            <div className="max-h-[500px] overflow-auto">
                {problems.length > 0 && (
                    <ul aria-label={t`Lines that are not valid JSON`} className="bg-destructive/5 space-y-1 border-b px-3 py-2 text-xs">
                        {problems.map((problem) => (
                            <li key={problem.line}>
                                <span className="font-medium">{t`Line ${problem.line}: not valid JSON`}</span>{" "}
                                <span className="text-muted-foreground">({problem.message})</span>
                                <code className="block truncate font-mono">{problem.preview}</code>
                            </li>
                        ))}
                    </ul>
                )}

                <ol>
                    {records.map((record) => (
                        <li className="border-b px-3 py-2 last:border-b-0" key={record.line}>
                            <div className="text-muted-foreground mb-1 text-xs">{t`Line ${record.line}`}</div>
                            <JsonViewer data={record.value} defaultExpandDepth={1} />
                        </li>
                    ))}
                </ol>

                {truncated && (
                    <p className="text-muted-foreground px-3 py-2 text-xs">
                        {t`The preview stops after ${records.length} records and ${problems.length} problem lines. The rest of the file is not shown.`}
                    </p>
                )}
            </div>
        </div>
    );
});

JsonlViewer.displayName = "JsonlViewer";

export default JsonlViewer;
