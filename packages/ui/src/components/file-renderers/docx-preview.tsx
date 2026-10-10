"use client";

/**
 * DOCX Preview — code-split, lazy-loaded.
 * Uses mammoth.js to convert DOCX to sanitized HTML.
 *
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const DocxPreview = lazy(() => import("@neore/ui/components/file-renderers/docx-preview"));
 * ```
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import DOMPurify from "dompurify";
import { Download, FileText } from "lucide-react";
import type { FC } from "react";
import { memo, useEffect, useState } from "react";

export interface DocxPreviewProps {
    className?: string;
    filename?: string;
    url: string;
}

const DocxPreview: FC<DocxPreviewProps> = memo(({ className, filename, url }) => {
    const { t } = useLingui();
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        const loadDocx = async (): Promise<void> => {
            try {
                const [response, mammoth] = await Promise.all([fetch(url), import("mammoth")]);

                if (cancelled) {
                    return;
                }

                if (!response.ok) {
                    setError(true);
                    setIsLoading(false);

                    return;
                }

                const arrayBuffer = await response.arrayBuffer();

                if (cancelled) {
                    return;
                }

                const result = await mammoth.convertToHtml({ arrayBuffer });

                if (cancelled) {
                    return;
                }

                setHtml(DOMPurify.sanitize(result.value));
                setIsLoading(false);
            } catch {
                if (!cancelled) {
                    setError(true);
                    setIsLoading(false);
                }
            }
        };

        loadDocx();

        return () => {
            cancelled = true;
        };
    }, [url]);

    if (error) {
        return (
            <a
                className={cn(
                    "group my-2 flex w-full max-w-sm items-center gap-3 rounded-lg border p-3 transition-colors",
                    "hover:bg-accent hover:border-accent-foreground/20",
                    className,
                )}
                download={filename}
                href={url}
                rel="noopener noreferrer"
                target="_blank"
            >
                <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
                    <FileText aria-hidden="true" className="text-muted-foreground size-5" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{filename || t`Document`}</div>
                    <div className="text-muted-foreground text-xs">{t`Could not preview · Click to download`}</div>
                </div>
                <Download aria-hidden="true" className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </a>
        );
    }

    return (
        <div className={cn("my-2 w-full max-w-2xl overflow-hidden rounded-lg border", className)}>
            {/* Header */}
            <div className="bg-muted/50 flex items-center justify-between border-b px-3 py-1.5">
                <div className="flex items-center gap-2">
                    <FileText aria-hidden="true" className="text-muted-foreground size-4" />
                    <span className="max-w-[200px] truncate text-xs font-medium">{filename || t`Document`}</span>
                </div>
                <a
                    aria-label={filename ? t`Download ${filename}` : t`Download document`}
                    className="hover:bg-accent rounded p-1"
                    download={filename}
                    href={url}
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    <Download aria-hidden="true" className="size-3.5" />
                </a>
            </div>

            {/* Content */}
            <div className="overflow-auto p-4" style={{ maxHeight: "500px" }}>
                {isLoading && (
                    <div className="space-y-3">
                        <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
                        <div className="bg-muted h-4 w-full animate-pulse rounded" />
                        <div className="bg-muted h-4 w-5/6 animate-pulse rounded" />
                        <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
                    </div>
                )}
                {html && <div className="prose prose-sm dark:prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: html }} />}
            </div>
        </div>
    );
});

DocxPreview.displayName = "DocxPreview";

export default DocxPreview;
