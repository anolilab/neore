"use client";

/**
 * DocumentArtifact - Inline card shown in chat messages when a document is created/updated.
 * Pure presentational component — data fetching and canvas state are injected via props.
 * @example Web app usage (with canvas state + cRPC sheet content)
 * ```tsx
 * <DocumentArtifact
 *   documentId={id}
 *   isActive={activeDocumentId === id}
 *   kind={kind}
 *   onOpen={openCanvas}
 *   onPreload={preloadCodemirrorEditor}
 *   sheetContent={documentQuery.data?.content}
 *   title={title}
 *   version={version}
 * />
 * ```
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import SpreadsheetThumbnail from "@neore/ui/components/spreadsheet/spreadsheet-thumbnail";
import { CodeIcon, ExternalLinkIcon, FileTextIcon, ImageIcon, PaletteIcon, TableIcon } from "lucide-react";
import type { FC } from "react";
import { memo, useCallback } from "react";

import cn from "../utils/cn";

const KIND_ICONS: Record<string, FC<{ className?: string }>> = {
    code: CodeIcon,
    design: PaletteIcon,
    image: ImageIcon,
    sheet: TableIcon,
    text: FileTextIcon,
};

const KIND_LABELS: Record<string, MessageDescriptor> = {
    code: msg`Code`,
    design: msg`Design`,
    image: msg`Image`,
    sheet: msg`Spreadsheet`,
    text: msg`Document`,
};

export interface DocumentArtifactProps {
    className?: string;
    documentId: string;
    /** Whether this document is currently open in the canvas / viewer. Default: false */
    isActive?: boolean;
    kind: string;
    language?: string;
    /** Called when the user clicks the card. Optional — clicking is a no-op if omitted. */
    onOpen?: (documentId: string) => void;
    /** Called on mouse-enter for the code kind; used by web app to preload the editor. */
    onPreload?: () => void;
    /** CSV content for spreadsheet thumbnail preview. Omit when unavailable. */
    sheetContent?: string;
    title: string;
    version: number;
}

const DocumentArtifact: FC<DocumentArtifactProps> = memo(
    ({ className, documentId, isActive = false, kind, language, onOpen, onPreload, sheetContent, title, version }) => {
        const { i18n } = useLingui();
        const handleClick = useCallback(() => {
            onOpen?.(documentId);
        }, [onOpen, documentId]);

        const handleMouseEnter = useCallback(() => {
            if (kind === "code") {
                onPreload?.();
            }
        }, [kind, onPreload]);

        const Icon = KIND_ICONS[kind] ?? FileTextIcon;
        const kindDescriptor = KIND_LABELS[kind];
        const kindLabel = kindDescriptor ? i18n._(kindDescriptor) : kind;

        return (
            <button
                className={cn(
                    "group my-2 flex w-full max-w-sm flex-col rounded-lg border text-left transition-colors",
                    "hover:bg-accent hover:border-accent-foreground/20",
                    isActive && "border-primary/50 bg-primary/5",
                    className,
                )}
                onClick={handleClick}
                onFocus={handleMouseEnter}
                onMouseEnter={handleMouseEnter}
                type="button"
            >
                {/* Header row */}
                <div className="flex items-center gap-3 p-3">
                    <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
                        <Icon aria-hidden="true" className="text-muted-foreground size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{title}</div>
                        <div className="text-muted-foreground text-xs">
                            {kindLabel}
                            {language ? ` · ${language}` : ""}
                            {" · v"}
                            {version}
                        </div>
                    </div>
                    <ExternalLinkIcon
                        aria-hidden="true"
                        className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                </div>

                {/* Spreadsheet thumbnail preview */}
                {sheetContent && <SpreadsheetThumbnail className="mx-3 mb-3 rounded-md" content={sheetContent} />}
            </button>
        );
    },
);

DocumentArtifact.displayName = "DocumentArtifact";

export default DocumentArtifact;
