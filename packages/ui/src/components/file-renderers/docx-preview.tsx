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
import { assertOfficeZipWithinLimits } from "@ui/utils/office-zip-limits";
import DOMPurify from "dompurify";
import { Download, FileText } from "lucide-react";
import type { FC } from "react";
import { memo, useEffect, useState } from "react";

import GenericFileCard from "./generic-file-card";

export interface DocxPreviewProps {
    className?: string;
    filename?: string;
    url: string;
}

const DOCX_FETCH_TIMEOUT_MS = 30_000;
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const DocxPreview: FC<DocxPreviewProps> = memo(({ className, filename, url }) => {
    const { t } = useLingui();
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        // A deadline as well as the unmount abort: a stalled URL must not hold the preview forever.
        const deadline = setTimeout(() => controller.abort(), DOCX_FETCH_TIMEOUT_MS);

        const loadDocx = async (): Promise<void> => {
            try {
                const [response, mammoth] = await Promise.all([fetch(url, { signal: controller.signal }), import("mammoth")]);

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

                await assertOfficeZipWithinLimits(arrayBuffer);

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
            } finally {
                clearTimeout(deadline);
            }
        };

        loadDocx();

        return () => {
            cancelled = true;
            clearTimeout(deadline);
            controller.abort();
        };
    }, [url]);

    if (error) {
        return (
            <GenericFileCard
                className={className}
                description={t`Could not preview · Click to download`}
                filename={filename}
                mediaType={DOCX_MEDIA_TYPE}
                url={url}
            />
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
                    <div aria-live="polite" role="status">
                        <span className="sr-only">{t`Loading document…`}</span>
                        <div aria-hidden="true" className="space-y-3">
                            <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
                            <div className="bg-muted h-4 w-full animate-pulse rounded" />
                            <div className="bg-muted h-4 w-5/6 animate-pulse rounded" />
                            <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
                        </div>
                    </div>
                )}
                {html && <div className="prose prose-sm dark:prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: html }} />}
            </div>
        </div>
    );
});

DocxPreview.displayName = "DocxPreview";

export default DocxPreview;
