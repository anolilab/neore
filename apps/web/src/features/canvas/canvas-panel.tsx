"use client";

/**
 * Canvas Panel - Side panel for viewing and editing AI-generated documents/artifacts.
 * Routes to appropriate editors based on document kind:
 * - text → TipTap Editor
 * - code → CodeMirror Editor (lazy loaded); html/svg also get a sandboxed live preview
 * - sheet → Sheet Viewer (read-only)
 * - image → Photon Image Editor (lazy loaded; preview default)
 */

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import type { FabricCanvasEditorProps } from "@neore/ui/components/canvas-editor/fabric-canvas-editor";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import type { ChangeCommit } from "@neore/ui/components/tiptap-canvas-editor";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { JSONContent } from "@tiptap/core";
import DOMPurify from "dompurify";
import {
    CheckIcon,
    CopyIcon,
    DownloadIcon,
    EyeIcon,
    FileDown,
    FileSpreadsheetIcon,
    HistoryIcon,
    MaximizeIcon,
    MinimizeIcon,
    PencilIcon,
    UploadIcon,
    XIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { ChangeEvent, ComponentProps, FC } from "react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";
import { useCanvasState } from "@/features/chat/core/stores/chat-ui-store";
import OpenAsPageButton from "@/features/pages/components/open-as-page-button";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess, showWarning } from "@/lib/toast";

import CanvasSheetViewer from "./canvas-sheet-viewer";
import CanvasTextViewer from "./canvas-text-viewer";
import CanvasAiDiffBanner from "./components/canvas-ai-diff-banner";
import CanvasCodePreview from "./components/canvas-code-preview";
import CanvasToolbar from "./components/canvas-toolbar";
import { getPreviewLanguage } from "./lib/preview-srcdoc";

const CanvasCodemirrorEditor = lazy(() => import("./editors/canvas-codemirror-editor"));
const CanvasFabricEditor = lazy(() =>
    import("@neore/ui/components/canvas-editor/fabric-canvas-editor").then((m) => {
        return { default: m.FabricCanvasEditor };
    }),
);
const PhotonImageEditor = lazy(() =>
    import("@neore/ui/components/image-editor/photon-image-editor").then((m) => {
        return { default: m.PhotonImageEditor };
    }),
);
const CanvasUniverSheetEditor = lazy(() =>
    import("@neore/ui/components/spreadsheet/univer-sheet-editor").then((m) => {
        return { default: m.UniverSheetEditor };
    }),
);
const CanvasVersionHistory = lazy(() => import("./components/canvas-version-history"));
// Lazy like the other editors: `reactjs-tiptap-editor` brings KaTeX with it,
// and a static import put both on every chat page, open canvas or not. The
// locale map rides along so this file keeps no static edge into that module.
const TiptapCanvasEditor = lazy(() =>
    import("@neore/ui/components/tiptap-canvas-editor").then((m) => {
        const Editor: FC<Omit<ComponentProps<typeof m.TiptapCanvasEditor>, "locale"> & { appLocale: string }> = ({ appLocale, ...props }) => (
            <m.TiptapCanvasEditor {...props} locale={m.EDITOR_LOCALE_MAP[appLocale] ?? "en"} />
        );

        return { default: Editor };
    }),
);

const EditorLoadingFallback: FC<{ label: string }> = ({ label }) => (
    <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground text-sm">{label}</div>
    </div>
);

const CanvasTextEditor: FC<{
    content: string;
    contentJson?: JSONContent | null;
    onSave?: (content: string, contentJson: JSONContent, commit?: ChangeCommit) => void;
}> = memo(({ content, contentJson, onSave }) => {
    const { i18n, t } = useLingui();

    return (
        <Suspense fallback={<EditorLoadingFallback label={t`Loading editor...`} />}>
            <TiptapCanvasEditor appLocale={i18n.locale} content={content} contentJson={contentJson} onSave={onSave} toolbar />
        </Suspense>
    );
});

CanvasTextEditor.displayName = "CanvasTextEditor";

/**
 * Builds the lingui-translated `messages` prop for the Photon editor. Lives
 * in this file so `useLingui` runs in the React tree (the editor itself sits
 * in `packages/ui` and stays lingui-agnostic).
 */
const usePhotonEditorMessages = () => {
    const { t } = useLingui();

    return useMemo(() => {
        return {
            apply: t`Apply`,
            cancel: t`Cancel`,
            categoryAdjust: t`Adjust`,
            categoryChannel: t`Channels`,
            categoryColor: t`Color`,
            categoryEffect: t`Effects`,
            categoryFilter: t`Filters`,
            categoryTransform: t`Transform`,
            corsBlocked: t`This image's host does not allow editing. Re-upload or generate a new image to enable editing.`,
            downloadPng: t`Download PNG`,
            imageTooLarge: t`The edited image is too large to save (>1 MB). Try cropping, downscaling, or applying fewer effects.`,
            initFailed: t`Failed to initialize image editor`,
            loadError: t`Could not load image`,
            loadingEditor: t`Loading editor…`,
            loadingImageEditor: t`Loading image editor…`,
            operationFailed: (label: string) => t`Operation "${label}" failed`,
            operationLabels: {
                "alter-blue": t`Blue Channel`,
                "alter-green": t`Green Channel`,
                // Channels
                "alter-red": t`Red Channel`,
                "box-blur": t`Box Blur`,
                // Adjust
                brightness: t`Brightness`,
                colorize: t`Colorize`,
                contrast: t`Contrast`,
                darken: t`Darken`,
                desaturate: t`Desaturate`,
                dither: t`Dither`,
                "edge-detection": t`Edge Detection`,
                emboss: t`Emboss`,
                // Photon preset names are proper names (like Instagram filters), so they
                // stay untranslated in every locale.
                "filter-bluechrome": "Bluechrome",
                "filter-cali": "Cali",
                "filter-diamante": "Diamante",
                "filter-dramatic": "Dramatic",
                "filter-duotone-horizon": "Duotone Horizon",
                "filter-duotone-lilac": "Duotone Lilac",
                "filter-duotone-ochre": "Duotone Ochre",
                "filter-duotone-violette": "Duotone Violette",
                "filter-firenze": "Firenze",
                "filter-flagblue": "Flagblue",
                "filter-golden": "Golden",
                "filter-islands": "Islands",
                "filter-liquid": "Liquid",
                "filter-lix": "Lix",
                // Standalone filter functions
                "filter-lofi": "Lofi",
                "filter-marine": "Marine",
                "filter-mauve": "Mauve",
                "filter-neue": "Neue",
                "filter-obsidian": "Obsidian",
                // Filter presets (via photon.filter())
                "filter-oceanic": "Oceanic",
                "filter-pastel-pink": "Pastel Pink",
                "filter-perfume": "Perfume",
                "filter-radio": "Radio",
                "filter-rosetint": "Rosetint",
                "filter-ryo": "Ryo",
                "filter-seagreen": "Seagreen",
                "filter-serenity": "Serenity",
                "filter-twenties": "Twenties",
                "filter-vintage": "Vintage",
                "flip-h": t`Flip Horizontal`,
                "flip-v": t`Flip Vertical`,
                "frosted-glass": t`Frosted Glass`,
                gamma: t`Gamma`,
                // Effects
                "gaussian-blur": t`Gaussian Blur`,
                // Color
                grayscale: t`Grayscale`,
                "grayscale-human": t`Grayscale (Human)`,
                "horizontal-strips": t`Horizontal Strips`,
                "hue-rotate": t`Hue Rotate`,
                invert: t`Invert`,
                lighten: t`Lighten`,
                "noise-reduction": t`Noise Reduction`,
                normalize: t`Normalize`,
                "offset-blue": t`Offset Blue`,
                "offset-green": t`Offset Green`,
                "offset-red": t`Offset Red`,
                oil: t`Oil Painting`,
                pixelize: t`Pixelize`,
                primary: t`Primary`,
                "rotate-180": t`Rotate 180°`,
                "rotate-ccw": t`Rotate 90° CCW`,
                // Transform
                "rotate-cw": t`Rotate 90° CW`,
                saturate: t`Saturate`,
                sepia: t`Sepia`,
                sharpen: t`Sharpen`,
                solarize: t`Solarize`,
                "swap-gb": t`Swap G↔B`,
                "swap-rb": t`Swap R↔B`,
                "swap-rg": t`Swap R↔G`,
                threshold: t`Threshold`,
                "vertical-strips": t`Vertical Strips`,
            },
            paramLabels: {
                // Generic slider keys (apply to most ops)
                amount: t`Amount`,
                b: t`Blue`,
                degrees: t`Degrees`,
                depth: t`Depth`,
                g: t`Green`,
                intensity: t`Intensity`,
                level: t`Level`,
                "offset-blue.amount": t`Offset`,
                "offset-green.amount": t`Offset`,
                // Per-op overrides — `offset-*` ops use "Offset" instead of "Amount"
                "offset-red.amount": t`Offset`,
                r: t`Red`,
                radius: t`Radius`,
                size: t`Pixel Size`,
                strips: t`Strips`,
            },
            previewLabel: (label: string) => t`Preview: ${label}`,
            ready: t`Ready`,
            redo: t`Redo`,
            reset: t`Reset`,
            saveAriaLabel: t`Save as new version`,
            saveFailed: t`Save failed`,
            saveVersion: t`Save version`,
            saving: t`Saving…`,
            undo: t`Undo`,
            unsavedEdits: (n: number) => t`${plural(n, { one: "# unsaved edit", other: "# unsaved edits" })}`,
        };
    }, [t]);
};

interface CanvasPanelProps {
    className?: string;
}

/**
 * Renders the appropriate editor/viewer based on document kind and edit mode.
 */
const CanvasContent: FC<{
    codePreview?: boolean;
    document: any;
    editMode: "edit" | "preview";
    isStreaming?: boolean;
    onCodeSave?: (content: string) => void;
    onDesignSave?: FabricCanvasEditorProps["onSave"];
    onImageSave?: (pngDataUrl: string) => Promise<void> | void;
    onSheetSave?: (csv: string) => void;
    onTextSave?: (content: string, contentJson: JSONContent, commit?: ChangeCommit) => void;
}> = memo(({ codePreview, document, editMode, isStreaming, onCodeSave, onDesignSave, onImageSave, onSheetSave, onTextSave }) => {
    const { t } = useLingui();
    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === "dark";
    const photonMessages = usePhotonEditorMessages();

    switch (document.kind) {
        case "code": {
            const previewLanguage = getPreviewLanguage(document.language);

            if (codePreview && previewLanguage) {
                return <CanvasCodePreview content={document.content ?? ""} isStreaming={isStreaming} language={previewLanguage} title={document.title ?? ""} />;
            }

            if (isStreaming || editMode === "preview") {
                return (
                    <div className="h-full overflow-auto">
                        <pre className="bg-muted/50 min-h-full p-4">
                            <code className={`language-${document.language ?? "plaintext"}`}>{document.content ?? ""}</code>
                        </pre>
                    </div>
                );
            }

            return (
                <Suspense fallback={<EditorLoadingFallback label={t`Loading editor...`} />}>
                    <CanvasCodemirrorEditor content={document.content ?? ""} language={document.language ?? "plaintext"} onSave={onCodeSave} />
                </Suspense>
            );
        }
        case "design": {
            if (isStreaming || editMode === "preview") {
                // Show PNG preview from content field (data URL)
                return (
                    <div className="flex h-full items-center justify-center p-4">
                        {document.content ? (
                            <img alt={document.title} className="max-h-full max-w-full object-contain" src={document.content} />
                        ) : (
                            <div className="text-muted-foreground text-sm">{t`Design preview unavailable`}</div>
                        )}
                    </div>
                );
            }

            {
                // Extract dimensions from the canvas JSON or use defaults
                const json = document.contentJson as FabricCanvasEditorProps["canvasJson"];
                const canvasWidth = typeof json?.width === "number" ? json.width : 1080;
                const canvasHeight = typeof json?.height === "number" ? json.height : 1080;

                return (
                    <Suspense fallback={<EditorLoadingFallback label={t`Loading canvas editor...`} />}>
                        <CanvasFabricEditor canvasJson={json} darkMode={isDark} height={canvasHeight} onSave={onDesignSave} width={canvasWidth} />
                    </Suspense>
                );
            }
        }
        case "image": {
            // SVG content has no raster editor — render it inline (read-only).
            //
            // Sanitised, because this is model-generated content reaching
            // `innerHTML`. `<script>` does not execute on an innerHTML insert,
            // but SVG event handlers do, and `<foreignObject>` can carry
            // arbitrary HTML — `<svg><foreignObject><img src=x onerror=…>` is
            // enough. DOMPurify with the SVG profile keeps the drawing and
            // drops the executable surface; `packages/ui`'s docx renderer
            // already sanitises for the same reason.
            if (document.content?.startsWith("<svg")) {
                const safeSvg = DOMPurify.sanitize(document.content, { USE_PROFILES: { svg: true, svgFilters: true } });

                return (
                    <div className="flex h-full items-center justify-center p-4">
                        <div className="max-h-full max-w-full" dangerouslySetInnerHTML={{ __html: safeSvg }} />
                    </div>
                );
            }

            // Resolve the raster source: new edits store a data URL, legacy
            // artifacts store raw base64 PNG. Loader handles both, but we
            // normalize here so the preview <img> stays simple.
            const rasterSource = document.content?.startsWith("data:") ? document.content : `data:image/png;base64,${document.content ?? ""}`;

            if (isStreaming || editMode === "preview") {
                return (
                    <div className="flex h-full items-center justify-center p-4">
                        <img alt={document.title} className="max-h-full max-w-full object-contain" src={rasterSource} />
                    </div>
                );
            }

            return (
                <Suspense fallback={<EditorLoadingFallback label={t`Loading image editor...`} />}>
                    <PhotonImageEditor messages={photonMessages} onSave={onImageSave} src={rasterSource} title={document.title} />
                </Suspense>
            );
        }
        case "sheet": {
            if (isStreaming || editMode === "preview") {
                return <CanvasSheetViewer content={document.content ?? ""} />;
            }

            return (
                <Suspense fallback={<EditorLoadingFallback label={t`Loading editor...`} />}>
                    <CanvasUniverSheetEditor content={document.content ?? ""} darkMode={isDark} onContentChange={onSheetSave} title={document.title} />
                </Suspense>
            );
        }
        case "text": {
            // During streaming or in preview mode, use simple viewer
            if (isStreaming || editMode === "preview") {
                return <CanvasTextViewer content={document.content ?? ""} />;
            }

            return <CanvasTextEditor content={document.content ?? ""} contentJson={document.contentJson} onSave={onTextSave} />;
        }
        default: {
            return <CanvasTextViewer content={document.content ?? ""} />;
        }
    }
});

CanvasContent.displayName = "CanvasContent";

const CanvasPanel: FC<CanvasPanelProps> = memo(({ className }) => {
    const { t } = useLingui();
    const {
        activeDocumentId,
        canvasDirty,
        canvasEditMode,
        canvasViewMode,
        closeCanvas,
        isCanvasOpen,
        setCanvasDirty,
        setCanvasEditMode,
        setCanvasHistoryVersions,
        setCanvasViewMode,
    } = useCanvasState();
    const crpc = useCRPC();
    const [isCopied, setIsCopied] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showAiDiffBanner, setShowAiDiffBanner] = useState(false);
    const [codeView, setCodeView] = useState<"code" | "preview">("code");

    // Track version to detect AI-driven updates
    const lastSeenVersionRef = useRef<number>(0);
    const localSaveRef = useRef(false);

    const { data: document } = useQuery({
        ...crpc.agent.documents.getDocument.queryOptions({
            documentId: activeDocumentId as Id<"documents">,
        }),
        enabled: !!activeDocumentId && isCanvasOpen,
    });

    const { mutateAsync: updateDocument } = useMutation(crpc.agent.documents.updateDocument.mutationOptions());

    // Detect version bumps from non-local sources (AI updates)
    useEffect(() => {
        if (!document?.version) {
            return;
        }

        const currentVersion = document.version;

        if (lastSeenVersionRef.current === 0) {
            // First load — just record the version
            lastSeenVersionRef.current = currentVersion;

            return;
        }

        if (currentVersion > lastSeenVersionRef.current) {
            if (localSaveRef.current) {
                // Version bump from our own save — don't show banner
                localSaveRef.current = false;
            } else {
                // Version bump from external source (AI) — show banner
                setShowAiDiffBanner(true);
            }

            lastSeenVersionRef.current = currentVersion;
        }
    }, [document?.version]);

    const documentContent = document?.content;

    const handleCopy = useCallback(async () => {
        if (!documentContent) {
            return;
        }

        await navigator.clipboard.writeText(documentContent);
        setIsCopied(true);
        setTimeout(setIsCopied, 2000, false);
    }, [documentContent]);

    const handleDownload = useCallback(() => {
        if (!document?.content) {
            return;
        }

        // Design and Photon-edited image documents store a data URL — download as PNG directly
        if ((document.kind === "design" || document.kind === "image") && document.content?.startsWith("data:")) {
            const a = globalThis.document.createElement("a");

            a.href = document.content;
            a.download = `${document.title}.png`;
            a.click();

            return;
        }

        // Legacy image artifacts are stored as raw base64 PNG (or inline SVG).
        if (document.kind === "image" && !document.content?.startsWith("<svg")) {
            const a = globalThis.document.createElement("a");

            a.href = `data:image/png;base64,${document.content}`;
            a.download = `${document.title}.png`;
            a.click();

            return;
        }

        const extensions: Record<string, string> = {
            code: document.language ? `.${document.language}` : ".txt",
            image: ".svg",
            sheet: ".csv",
            text: ".md",
        };

        const mimeTypes: Record<string, string> = {
            code: "text/plain",
            image: "image/svg+xml",
            sheet: "text/csv",
            text: "text/markdown",
        };

        const extension = extensions[document.kind] ?? ".txt";
        const mimeType = mimeTypes[document.kind] ?? "text/plain";
        const filename = `${document.title}${extension}`;

        const blob = new Blob([document.content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = globalThis.document.createElement("a");

        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }, [document]);

    const handleTextSave = useCallback(
        async (content: string, contentJson: JSONContent, commit?: ChangeCommit) => {
            if (!activeDocumentId) {
                return;
            }

            localSaveRef.current = true;
            setCanvasDirty(false);
            await updateDocument({
                commit,
                content,
                contentJson,
                documentId: activeDocumentId as Id<"documents">,
            });
            trackEvent("artifact_edited", { kind: document?.kind ?? "text" });
        },
        [activeDocumentId, updateDocument, setCanvasDirty, document?.kind],
    );

    const handleCodeSave = useCallback(
        async (content: string) => {
            if (!activeDocumentId) {
                return;
            }

            localSaveRef.current = true;
            setCanvasDirty(false);
            await updateDocument({
                content,
                documentId: activeDocumentId as Id<"documents">,
            });
        },
        [activeDocumentId, updateDocument, setCanvasDirty],
    );

    const handleSheetSave = useCallback(
        async (csv: string) => {
            if (!activeDocumentId) {
                return;
            }

            localSaveRef.current = true;
            setCanvasDirty(false);
            await updateDocument({
                content: csv,
                documentId: activeDocumentId as Id<"documents">,
            });
        },
        [activeDocumentId, updateDocument, setCanvasDirty],
    );

    const handleDesignSave = useCallback(
        async (canvasJson: NonNullable<FabricCanvasEditorProps["canvasJson"]>, previewDataUrl: string) => {
            if (!activeDocumentId) {
                return;
            }

            localSaveRef.current = true;
            setCanvasDirty(false);
            await updateDocument({
                content: previewDataUrl,
                contentJson: canvasJson,
                documentId: activeDocumentId as Id<"documents">,
            });
            trackEvent("artifact_edited", { kind: "design" });
        },
        [activeDocumentId, updateDocument, setCanvasDirty],
    );

    const handleImageSave = useCallback(
        async (pngDataUrl: string) => {
            if (!activeDocumentId) {
                return;
            }

            localSaveRef.current = true;
            setCanvasDirty(false);
            await updateDocument({
                content: pngDataUrl,
                documentId: activeDocumentId as Id<"documents">,
            });
            trackEvent("artifact_edited", { kind: "image" });
        },
        [activeDocumentId, updateDocument, setCanvasDirty],
    );

    // ----- XLSX import -----
    const xlsxInputRef = useRef<HTMLInputElement>(null);

    const handleXlsxImport = useCallback(
        async (event: ChangeEvent<HTMLInputElement>) => {
            const input = event.target;
            const file = input.files?.[0];

            if (!file || !activeDocumentId) {
                return;
            }

            // Reset input so re-selecting the same file triggers onChange again
            input.value = "";

            try {
                const { xlsxFileToCSV } = await import("@neore/ui/components/spreadsheet/xlsx-convert");
                const { csv, sheetCount } = await xlsxFileToCSV(file);

                if (!csv) {
                    showError(t`The imported file appears to be empty.`);

                    return;
                }

                if (sheetCount > 1) {
                    showWarning(t`This workbook has ${sheetCount} sheets — only the first sheet was imported.`);
                }

                localSaveRef.current = true;
                setCanvasDirty(false);
                await updateDocument({
                    content: csv,
                    documentId: activeDocumentId as Id<"documents">,
                });
                showSuccess(t`Spreadsheet imported successfully.`);
            } catch {
                showError(t`Failed to import the spreadsheet file.`);
            }
        },
        [activeDocumentId, updateDocument, setCanvasDirty, t],
    );

    // ----- XLSX download -----
    const handleDownloadXlsx = useCallback(async () => {
        if (!document?.content) {
            return;
        }

        try {
            const { downloadAsXlsx } = await import("@neore/ui/components/spreadsheet/xlsx-convert");

            await downloadAsXlsx(document.content, document.title ?? "spreadsheet");
        } catch {
            showError(t`Failed to export as XLSX.`);
        }
    }, [document, t]);

    const toggleEditMode = useCallback(() => {
        setCanvasEditMode(canvasEditMode === "edit" ? "preview" : "edit");
    }, [canvasEditMode, setCanvasEditMode]);

    const toggleHistory = useCallback(() => {
        setCanvasViewMode(canvasViewMode === "history" ? "editor" : "history");
    }, [canvasViewMode, setCanvasViewMode]);

    // AI diff banner actions
    const handleBannerViewChanges = useCallback(() => {
        setShowAiDiffBanner(false);
        setCanvasViewMode("history");
        // Auto-select the latest two versions if possible
        setCanvasHistoryVersions(null);
    }, [setCanvasViewMode, setCanvasHistoryVersions]);

    const handleBannerUndo = useCallback(async () => {
        if (!activeDocumentId || !document) {
            return;
        }

        setShowAiDiffBanner(false);
        // Switch to history view so user can pick which version to restore
        setCanvasViewMode("history");
    }, [activeDocumentId, document, setCanvasViewMode]);

    const handleBannerDismiss = useCallback(() => {
        setShowAiDiffBanner(false);
    }, []);

    if (!isCanvasOpen || !activeDocumentId) {
        return null;
    }

    const isEditable =
        document?.kind === "text" || document?.kind === "code" || document?.kind === "sheet" || document?.kind === "design" || document?.kind === "image";
    const isStreaming = document?.status === "streaming";
    const canPreviewCode = document?.kind === "code" && getPreviewLanguage(document.language) !== undefined;
    const showCodePreview = canPreviewCode && codeView === "preview" && canvasViewMode !== "history";

    return (
        <div className={cn("bg-background flex h-full flex-col border-l", isFullscreen && "fixed inset-0 z-50 border-l-0", className)}>
            {/* Header */}
            <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="flex items-center gap-2 overflow-hidden">
                    <div className="flex flex-col gap-0.5 overflow-hidden">
                        <div className="flex items-center gap-1.5">
                            <h3 className="truncate text-sm font-medium">{document?.title ?? t`Loading...`}</h3>
                            {canvasDirty && <span className="bg-primary size-2 shrink-0 rounded-full" title={t`Unsaved changes`} />}
                        </div>
                        {document && (
                            <span className="text-muted-foreground text-xs capitalize">
                                {document.kind}
                                {document.language ? ` · ${document.language}` : ""}
                                {" · v"}
                                {document.version}
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    {canPreviewCode && (
                        <div aria-label={t`Code view`} className="bg-muted mr-1 flex rounded-md p-0.5" role="group">
                            <Button
                                aria-pressed={codeView === "code"}
                                onClick={() => setCodeView("code")}
                                size="sm"
                                variant={codeView === "code" ? "secondary" : "ghost"}
                            >
                                {t`Code`}
                            </Button>
                            <Button
                                aria-pressed={codeView === "preview"}
                                onClick={() => setCodeView("preview")}
                                size="sm"
                                variant={codeView === "preview" ? "secondary" : "ghost"}
                            >
                                {t`Preview`}
                            </Button>
                        </div>
                    )}
                    {isEditable && !isStreaming && !showCodePreview && (
                        <TooltipIconButton onClick={toggleEditMode} tooltip={canvasEditMode === "edit" ? t`Preview` : t`Edit`}>
                            {canvasEditMode === "edit" ? <EyeIcon className="size-4" /> : <PencilIcon className="size-4" />}
                        </TooltipIconButton>
                    )}
                    {isEditable && !isStreaming && document && document.version > 1 && (
                        <TooltipIconButton onClick={toggleHistory} tooltip={canvasViewMode === "history" ? t`Close history` : t`Version history`}>
                            <HistoryIcon className="size-4" />
                        </TooltipIconButton>
                    )}
                    {/* XLSX import (sheets only) */}
                    {document?.kind === "sheet" && !isStreaming && (
                        <>
                            <input accept=".xlsx,.xls" className="hidden" onChange={handleXlsxImport} ref={xlsxInputRef} type="file" />
                            <TooltipIconButton onClick={() => xlsxInputRef.current?.click()} tooltip={t`Import XLSX`}>
                                <UploadIcon className="size-4" />
                            </TooltipIconButton>
                        </>
                    )}
                    {document?.kind === "text" && !isStreaming && <OpenAsPageButton documentId={document._id} />}
                    <TooltipIconButton onClick={handleCopy} tooltip={t`Copy content`}>
                        {isCopied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                    </TooltipIconButton>
                    {/* Download — dropdown for sheets (CSV vs XLSX), plain button otherwise */}
                    {document?.kind === "sheet" ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={
                                    <TooltipIconButton tooltip={t`Download`}>
                                        <DownloadIcon className="size-4" />
                                    </TooltipIconButton>
                                }
                            />
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={handleDownload}>
                                    <FileDown className="mr-2 size-4" />
                                    {t`Download as CSV`}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={handleDownloadXlsx}>
                                    <FileSpreadsheetIcon className="mr-2 size-4" />
                                    {t`Download as XLSX`}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <TooltipIconButton onClick={handleDownload} tooltip={t`Download`}>
                            <DownloadIcon className="size-4" />
                        </TooltipIconButton>
                    )}
                    <TooltipIconButton onClick={() => setIsFullscreen((v) => !v)} tooltip={isFullscreen ? t`Exit fullscreen` : t`Fullscreen`}>
                        {isFullscreen ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
                    </TooltipIconButton>
                    <TooltipIconButton onClick={closeCanvas} tooltip={t`Close`}>
                        <XIcon className="size-4" />
                    </TooltipIconButton>
                </div>
            </div>

            {/* AI update diff banner */}
            <CanvasAiDiffBanner onDismiss={handleBannerDismiss} onUndo={handleBannerUndo} onViewChanges={handleBannerViewChanges} visible={showAiDiffBanner} />

            {/* Quick action toolbar */}
            {document && canvasEditMode === "edit" && !isStreaming && !showCodePreview && <CanvasToolbar documentKind={document.kind} />}

            {/* Content */}
            <div className="flex-1 overflow-auto">
                {!document && (
                    <div className="flex h-full items-center justify-center">
                        <div className="text-muted-foreground text-sm">{t`Loading document...`}</div>
                    </div>
                )}
                {document && canvasViewMode === "history" && (
                    <Suspense fallback={<EditorLoadingFallback label={t`Loading editor...`} />}>
                        <CanvasVersionHistory document={document} />
                    </Suspense>
                )}
                {document && canvasViewMode !== "history" && (
                    <CanvasContent
                        codePreview={showCodePreview}
                        document={document}
                        editMode={canvasEditMode}
                        isStreaming={isStreaming}
                        onCodeSave={handleCodeSave}
                        onDesignSave={handleDesignSave}
                        onImageSave={handleImageSave}
                        onSheetSave={handleSheetSave}
                        onTextSave={handleTextSave}
                    />
                )}
            </div>
        </div>
    );
});

CanvasPanel.displayName = "CanvasPanel";

export default CanvasPanel;
