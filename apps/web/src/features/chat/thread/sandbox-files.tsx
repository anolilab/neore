"use client";

import { useLingui } from "@lingui/react/macro";
import type { SandboxOutputFile, SandboxOutputs, SkippedSandboxFile } from "@neore/chat-ui/types";
import { formatFileSize, isDocx, isPdf } from "@neore/ui/components/file-renderers/file-type-utilities";
import { DownloadIcon, EyeIcon, FileArchiveIcon, FileAudioIcon, FileIcon, FileImageIcon, FileSpreadsheetIcon, FileTextIcon, FileVideoIcon } from "lucide-react";
import type { FC, ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";

const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));
const DocxPreview = lazy(() => import("@neore/ui/components/file-renderers/docx-preview"));
const PptxPreview = lazy(() =>
    import("@neore/ui/components/file-renderers/pptx-preview").then((m) => {
        return { default: m.PptxPreview };
    }),
);
const XlsxRenderer = lazy(() =>
    import("@neore/ui/components/spreadsheet/xlsx-renderer").then((m) => {
        return { default: m.XlsxRenderer };
    }),
);

/**
 * Files a code-execution or shell run saved to its output directory. Each
 * `url` is a signed URL once the message has been read back from the server
 * (`agent/display-media.ts`); while the reply is still streaming it is the raw
 * `storage:` reference, and a file its owner no longer holds comes back empty —
 * both render as a chip without a link.
 */

const HTTP_URL = /^https?:\/\//u;

const isLink = (url: string): boolean => HTTP_URL.test(url);

const ICON_CLASS = "text-muted-foreground size-4 shrink-0";

const isSpreadsheet = (mediaType: string): boolean =>
    mediaType === "text/csv" || mediaType === "text/tab-separated-values" || mediaType.includes("spreadsheetml");

const isDocument = (mediaType: string): boolean =>
    mediaType.startsWith("text/") || mediaType === "application/pdf" || mediaType === "application/json" || mediaType.includes("wordprocessingml");

/** An icon for the file's type; decorative, the name beside it says what it is. */
const fileIcon = (mediaType: string): ReactNode => {
    if (mediaType.startsWith("image/")) {
        return <FileImageIcon aria-hidden className={ICON_CLASS} />;
    }

    if (mediaType.startsWith("audio/")) {
        return <FileAudioIcon aria-hidden className={ICON_CLASS} />;
    }

    if (mediaType.startsWith("video/")) {
        return <FileVideoIcon aria-hidden className={ICON_CLASS} />;
    }

    if (isSpreadsheet(mediaType)) {
        return <FileSpreadsheetIcon aria-hidden className={ICON_CLASS} />;
    }

    if (mediaType === "application/zip") {
        return <FileArchiveIcon aria-hidden className={ICON_CLASS} />;
    }

    if (isDocument(mediaType)) {
        return <FileTextIcon aria-hidden className={ICON_CLASS} />;
    }

    return <FileIcon aria-hidden className={ICON_CLASS} />;
};

type OfficeKind = "docx" | "pdf" | "pptx" | "xlsx";

const officeKindOf = ({ mediaType, name }: SandboxOutputFile): OfficeKind | undefined => {
    const extension = name.split(".").pop()?.toLowerCase();

    if (isPdf(mediaType, name)) {
        return "pdf";
    }

    if (isDocx(mediaType, name)) {
        return "docx";
    }

    if (mediaType.includes("presentationml") || extension === "pptx") {
        return "pptx";
    }

    if (mediaType.includes("spreadsheetml") || extension === "xlsx") {
        return "xlsx";
    }

    return undefined;
};

const PptxFromUrl: FC<{ name: string; url: string }> = ({ name, url }) => {
    const { t } = useLingui();
    const [state, setState] = useState<{ blob?: Blob; failed?: boolean }>({});

    useEffect(() => {
        const controller = new AbortController();

        fetch(url, { signal: controller.signal })
            .then((response) => {
                // An expired signed URL answers 403 with a plain-text body; that is not a deck.
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                return response.blob();
            })
            .then((blob) => setState({ blob }))
            .catch(() => {
                if (!controller.signal.aborted) {
                    setState({ failed: true });
                }
            });

        return () => controller.abort();
    }, [url]);

    if (state.failed) {
        return (
            <p className="text-muted-foreground p-3 text-sm" role="status">
                {t`This preview could not be loaded.`}
            </p>
        );
    }

    return state.blob ? <PptxPreview data={state.blob} fileName={name} /> : null;
};

const OfficePreview: FC<{ file: SandboxOutputFile; kind: OfficeKind }> = ({ file, kind }) => (
    <div className="border-border mt-2 max-h-[32rem] overflow-auto rounded-lg border">
        <Suspense fallback={null}>
            {kind === "pdf" && <PdfViewer filename={file.name} url={file.url} />}
            {kind === "docx" && <DocxPreview filename={file.name} url={file.url} />}
            {kind === "pptx" && <PptxFromUrl name={file.name} url={file.url} />}
            {kind === "xlsx" && <XlsxRenderer fileName={file.name} source={file.url} />}
        </Suspense>
    </div>
);

const SandboxFileChip: FC<{ file: SandboxOutputFile }> = ({ file }) => {
    const { t } = useLingui();
    const { name } = file;
    const size = formatFileSize(file.size);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const kind = officeKindOf(file);
    const body = (
        <>
            {fileIcon(file.mediaType)}
            <span className="min-w-0 truncate font-medium">{file.name}</span>
            <span className="text-muted-foreground shrink-0 text-xs">{size}</span>
        </>
    );

    if (!isLink(file.url)) {
        return (
            <li
                className="border-border text-muted-foreground flex max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
                title={t`Available once the reply is saved`}
            >
                {body}
            </li>
        );
    }

    return (
        <li className={isPreviewing ? "w-full" : "max-w-full"}>
            <div className="flex max-w-full items-center gap-1">
                <a
                    aria-label={t`Download ${name} (${size})`}
                    className="border-border hover:bg-muted flex max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors"
                    download={file.name}
                    href={file.url}
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    {body}
                    <DownloadIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                </a>
                {kind && (
                    <button
                        aria-expanded={isPreviewing}
                        aria-label={t`Preview ${name}`}
                        className="border-border hover:bg-muted rounded-lg border p-2 transition-colors"
                        onClick={() => setIsPreviewing((previous) => !previous)}
                        type="button"
                    >
                        <EyeIcon aria-hidden className="size-4" />
                    </button>
                )}
            </div>
            {kind && isPreviewing && <OfficePreview file={file} kind={kind} />}
        </li>
    );
};

const SandboxFiles: FC<SandboxOutputs> = ({ files, skippedFiles }) => {
    const { t } = useLingui();

    if (files.length === 0 && skippedFiles.length === 0) {
        return null;
    }

    const images = files.filter((file) => file.mediaType.startsWith("image/") && isLink(file.url));
    const reasonLabel = (reason: SkippedSandboxFile["reason"]): string => {
        switch (reason) {
            case "too-large": {
                return t`too large`;
            }

            case "too-many": {
                return t`too many files`;
            }

            case "total-too-large": {
                return t`size limit reached`;
            }

            case "unsupported-type": {
                return t`unsupported type`;
            }

            default: {
                return t`could not be saved`;
            }
        }
    };

    return (
        <div className="mb-4 space-y-2">
            {images.map((file) => (
                <img alt={file.name} className="border-border max-h-96 max-w-full rounded-lg border" key={file.url} loading="lazy" src={file.url} />
            ))}
            {files.length > 0 && (
                <ul aria-label={t`Output files`} className="flex flex-wrap gap-2">
                    {files.map((file) => (
                        <SandboxFileChip file={file} key={`${file.name}-${file.url}`} />
                    ))}
                </ul>
            )}
            {skippedFiles.length > 0 && (
                <p className="text-muted-foreground text-xs">
                    {t`Not attached:`} {skippedFiles.map((file) => `${file.name} (${reasonLabel(file.reason)})`).join(", ")}
                </p>
            )}
        </div>
    );
};

export default SandboxFiles;
