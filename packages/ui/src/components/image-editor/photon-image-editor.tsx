/**
 * PhotonImageEditor — Client-side image editor backed by the Photon WASM library.
 *
 * Designed to be **code-split** (lazy-loaded) — the Photon wasm payload is ~700KB
 * and should not land in the main bundle. Import via:
 *
 * ```ts
 * const PhotonImageEditor = lazy(() =>
 *   import("@neore/ui/components/image-editor/photon-image-editor")
 *     .then((m) => ({ default: m.PhotonImageEditor })),
 * );
 * ```
 *
 * Each click on an operation applies it to a working canvas and pushes the
 * resulting PNG dataURL onto an in-session undo stack. Calling `onSave` hands
 * the current dataURL back to the caller, which is expected to persist it (the
 * backend document update snapshots the previous version into
 * `documentVersions` automatically — every save creates a new version).
 *
 * Token-saving rationale: routine pixel edits (filters, rotations, brightness,
 * blur, …) used to require asking the AI to regenerate the image. Now they
 * happen locally with zero LLM tokens.
 */

"use client";

import { DEFAULT_PHOTON_EDITOR_MESSAGES } from "@ui/components/image-editor/photon-editor-messages";
import cn from "@ui/utils/cn";
import { DownloadIcon, RedoIcon, RotateCcwIcon, SaveIcon, UndoIcon } from "lucide-react";
import type { FC } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../button";
import { Slider } from "../slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs";
import type { OperationCategory, OperationDefinition } from "./photon-operations";
import { makeParameterGetter, OPERATIONS_BY_CATEGORY } from "./photon-operations";
import type { Photon, PhotonImage } from "./photon-types";

// ---------------------------------------------------------------------------
// i18n messages
// ---------------------------------------------------------------------------

/**
 * Translatable strings used by the editor. Callers in `apps/web` should pass
 * lingui-translated values via the `messages` prop; the defaults below ship
 * English-only so the component remains usable in storybook / isolated tests.
 */
export interface PhotonEditorMessages {
    apply: string;
    cancel: string;
    categoryAdjust: string;
    categoryChannel: string;
    categoryColor: string;
    categoryEffect: string;
    categoryFilter: string;
    categoryTransform: string;
    /** Shown when the canvas is tainted by cross-origin pixels. */
    corsBlocked: string;
    downloadPng: string;
    /** Shown when the rendered PNG is too large to fit in the backend's 1 MiB field cap. */
    imageTooLarge: string;
    initFailed: string;
    loadError: string;
    loadingEditor: string;
    loadingImageEditor: string;
    /** Returned with the failing operation label. */
    operationFailed: (opLabel: string) => string;

    /**
     * Optional override for individual operation button labels, keyed by
     * `OperationDefinition.id`. Any id not present falls back to the English default
     * from the catalog.
     */
    operationLabels?: Partial<Record<string, string>>;

    /**
     * Optional override for slider param labels. Looked up as
     * `${opId}.${paramKey}` first (lets the `offset-*` ops use a different
     * label than the brightness-style "Amount"), then by bare `paramKey`,
     * then falls back to the catalog default.
     */
    paramLabels?: Partial<Record<string, string>>;
    /** Returned with the operation label so callers can interpolate. */
    previewLabel: (opLabel: string) => string;
    ready: string;
    redo: string;
    reset: string;
    saveAriaLabel: string;
    saveFailed: string;
    saveVersion: string;
    saving: string;
    undo: string;
    /** Returned with the number of unsaved edits so callers can produce a localized plural. */
    unsavedEdits: (count: number) => string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PhotonImageEditorProps {
    /**
     * Translated strings. Any field omitted falls back to the English default.
     * The caller (typically `apps/web`) wraps the editor in a lingui-aware
     * component and supplies localized messages.
     */
    messages?: Partial<PhotonEditorMessages>;
    /** Called whenever the working image diverges from the originally-loaded one. */
    onDirty?: (dirty: boolean) => void;
    /** Called on Save with the final PNG dataURL. */
    onSave?: (pngDataUrl: string) => void | Promise<void>;
    /** Initial image source. Accepts an http(s) URL, a `data:` URL, or a raw base64 string. */
    src: string;
    /** Optional initial title shown to the user. */
    title?: string;
}

// ---------------------------------------------------------------------------
// Photon module loader
// ---------------------------------------------------------------------------

const photonModuleCache: { promise?: Promise<Photon> } = {};

const loadPhoton = (): Promise<Photon> => {
    photonModuleCache.promise ??= (async () => {
        const photonModule = (await import("@silvia-odwyer/photon")) as unknown as Photon;

        // wasm-bindgen ESM builds expose a `default` initializer; older bundles
        // run synchronously at import time. Tolerate both.
        if (typeof photonModule.default === "function") {
            await photonModule.default();
        }

        return photonModule;
    })();

    return photonModuleCache.promise;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 25;
// The backend caps individual text fields at 1 MiB UTF-8. Base64 inflates raw
// bytes by ~4/3; leave headroom for the JSON envelope + other fields so the
// effective ceiling is ~900 KB of dataURL string.
const SAFE_DATAURL_BYTES = 900_000;

const CORS_TAINT_MESSAGE_REGEX = /tainted|cross[- ]origin/i;

const isCorsTaintError = (err: unknown): boolean => {
    if (!(err instanceof Error)) {
        return false;
    }

    // Chrome/Firefox/Safari all use SecurityError; some surface DOMException
    // with a message containing "tainted" or "cross-origin".
    return err.name === "SecurityError" || CORS_TAINT_MESSAGE_REGEX.test(err.message);
};

const loadImageElement = (source: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();

        img.crossOrigin = "anonymous";
        img.addEventListener("load", () => resolve(img));
        img.addEventListener("error", () => reject(new Error(`Failed to load image (src: ${source.slice(0, 80)}${source.length > 80 ? "…" : ""})`)));

        // Anything that is not already a URL is treated as a raw base64 PNG
        // (the legacy storage format for image artifacts).
        img.src = source.startsWith("data:") || source.startsWith("http") || source.startsWith("blob:") ? source : `data:image/png;base64,${source}`;
    });

const canvasToPng = (canvas: HTMLCanvasElement): string => canvas.toDataURL("image/png");

// ---------------------------------------------------------------------------
// Operation invocation
// ---------------------------------------------------------------------------

const runOperation = (
    photon: Photon,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    op: OperationDefinition,
    params: Record<string, number>,
): void => {
    const photonImage = photon.open_image(canvas, ctx);
    let workingImage: PhotonImage = photonImage;

    try {
        const result = op.invoke(photon, workingImage, makeParameterGetter(params));

        if (op.replacing && result) {
            // Photon returned a new image — adopt it and resize the canvas.
            workingImage.free();
            workingImage = result;

            const nextWidth = workingImage.width;
            const nextHeight = workingImage.height;

            canvas.width = nextWidth;
            canvas.height = nextHeight;
        }

        photon.putImageData(canvas, ctx, workingImage);
    } finally {
        workingImage.free();
    }
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: OperationCategory[] = ["transform", "adjust", "color", "filter", "effect", "channel"];
const CATEGORIES = CATEGORY_ORDER.filter((c) => OPERATIONS_BY_CATEGORY[c]?.length);

const PhotonImageEditorImpl: FC<PhotonImageEditorProps> = ({ messages: messagesOverride, onDirty, onSave, src, title }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const photonRef = useRef<Photon | null>(null);
    const originalDataUrlRef = useRef<string | null>(null);
    // Guards against undo/redo/operation races during an in-flight async
    // canvas restore (each restoreSnapshot awaits image decode).
    const isRestoringRef = useRef(false);

    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [activeCategory, setActiveCategory] = useState<OperationCategory>("filter");
    const [pendingOp, setPendingOp] = useState<{ op: OperationDefinition; params: Record<string, number> } | null>(null);

    // Undo/redo stacks as dataURL strings. Memory: ~1-3MB per snapshot for
    // typical chat images. Cap at HISTORY_LIMIT to keep this bounded.
    const [undoStack, setUndoStack] = useState<string[]>([]);
    const [redoStack, setRedoStack] = useState<string[]>([]);

    const dirty = undoStack.length > 0;
    const busy = restoring || saving;

    const messages = useMemo<PhotonEditorMessages>(() => {
        return { ...DEFAULT_PHOTON_EDITOR_MESSAGES, ...messagesOverride };
    }, [messagesOverride]);

    const categoryLabels = useMemo<Record<OperationCategory, string>>(() => {
        return {
            adjust: messages.categoryAdjust,
            channel: messages.categoryChannel,
            color: messages.categoryColor,
            effect: messages.categoryEffect,
            filter: messages.categoryFilter,
            transform: messages.categoryTransform,
        };
    }, [messages]);

    const getOpLabel = useCallback((op: OperationDefinition): string => messages.operationLabels?.[op.id] ?? op.label, [messages.operationLabels]);

    const getParameterLabel = useCallback(
        (opId: string, spec: { key: string; label: string }): string =>
            messages.paramLabels?.[`${opId}.${spec.key}`] ?? messages.paramLabels?.[spec.key] ?? spec.label,
        [messages.paramLabels],
    );

    // ---------- Bootstrap ----------
    useEffect(() => {
        let cancelled = false;

        const bootstrap = async () => {
            try {
                const [photon, image] = await Promise.all([loadPhoton(), loadImageElement(src)]);

                if (cancelled) {
                    return;
                }

                photonRef.current = photon;

                const canvas = canvasRef.current;

                if (!canvas) {
                    return;
                }

                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });

                if (!ctx) {
                    throw new Error("2D canvas context unavailable");
                }

                ctx.drawImage(image, 0, 0);
                // First toDataURL — if the image tainted the canvas this throws
                // SecurityError. Catch and surface a CORS-specific message.
                originalDataUrlRef.current = canvasToPng(canvas);
                setStatus("ready");
            } catch (error) {
                if (cancelled) {
                    return;
                }

                const fallbackMessage = error instanceof Error ? error.message : messages.initFailed;

                setStatus("error");
                setErrorMessage(isCorsTaintError(error) ? messages.corsBlocked : fallbackMessage);
            }
        };

        bootstrap();

        return () => {
            cancelled = true;
        };
    }, [src, messages.corsBlocked, messages.initFailed]);

    useEffect(() => {
        onDirty?.(dirty);
    }, [dirty, onDirty]);

    // ---------- Snapshot helpers ----------
    const pushSnapshot = useCallback((dataUrl: string) => {
        setUndoStack((prev) => {
            const next = prev.length >= HISTORY_LIMIT ? prev.slice(prev.length - HISTORY_LIMIT + 1) : [...prev];

            next.push(dataUrl);

            return next;
        });
        setRedoStack([]);
    }, []);

    const restoreSnapshot = useCallback(async (dataUrl: string) => {
        const canvas = canvasRef.current;

        if (!canvas) {
            return;
        }

        const image = await loadImageElement(dataUrl);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        if (!ctx) {
            return;
        }

        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        ctx.drawImage(image, 0, 0);
    }, []);

    // ---------- Apply an operation ----------
    // Read off `messages` up front: calling `messages.operationFailed(...)` inside
    // the callback would make the whole `messages` object a dependency.
    const { corsBlocked: corsBlockedMessage, operationFailed: operationFailedMessage } = messages;
    const applyOperation = useCallback(
        async (op: OperationDefinition, params: Record<string, number>) => {
            const canvas = canvasRef.current;
            const photon = photonRef.current;

            if (!canvas || !photon || isRestoringRef.current) {
                return;
            }

            const ctx = canvas.getContext("2d", { willReadFrequently: true });

            if (!ctx) {
                return;
            }

            const before = canvasToPng(canvas);

            try {
                runOperation(photon, canvas, ctx, op, params);
                pushSnapshot(before);
                setPendingOp(null);
                setErrorMessage(null);
            } catch (error) {
                // Replacing ops resize the canvas BEFORE `putImageData`, so a
                // throw past that point leaves a blank canvas. Restore the
                // pre-op snapshot so the canvas matches what the user sees.
                isRestoringRef.current = true;
                setRestoring(true);

                try {
                    await restoreSnapshot(before);
                } catch {
                    // If even the restore fails, leave the canvas as-is —
                    // surfacing the original op error is still the priority.
                }

                isRestoringRef.current = false;
                setRestoring(false);
                setErrorMessage(error instanceof Error && isCorsTaintError(error) ? corsBlockedMessage : operationFailedMessage(getOpLabel(op)));
            }
        },
        [pushSnapshot, restoreSnapshot, corsBlockedMessage, operationFailedMessage, getOpLabel],
    );

    const handleOperationClick = useCallback(
        (op: OperationDefinition) => {
            if (busy) {
                return;
            }

            if (op.params && op.params.length > 0) {
                // Stage with defaults — user can tweak sliders, then click Apply.
                const params = Object.fromEntries(op.params.map((spec) => [spec.key, spec.default]));

                setPendingOp({ op, params });

                return;
            }

            applyOperation(op, {});
        },
        [applyOperation, busy],
    );

    // ---------- Undo / redo / reset ----------
    const handleUndo = useCallback(async () => {
        const canvas = canvasRef.current;

        if (!canvas || undoStack.length === 0 || isRestoringRef.current) {
            return;
        }

        isRestoringRef.current = true;
        setRestoring(true);

        try {
            // Capture `current` atomically with the stack mutation so a stale
            // canvas read can't poison the redo stack.
            const previous = undoStack.at(-1)!;
            const current = canvasToPng(canvas);

            setUndoStack((prev) => prev.slice(0, -1));
            setRedoStack((prev) => [...prev, current]);
            await restoreSnapshot(previous);
        } finally {
            isRestoringRef.current = false;
            setRestoring(false);
        }
    }, [undoStack, restoreSnapshot]);

    const handleRedo = useCallback(async () => {
        const canvas = canvasRef.current;

        if (!canvas || redoStack.length === 0 || isRestoringRef.current) {
            return;
        }

        isRestoringRef.current = true;
        setRestoring(true);

        try {
            const next = redoStack.at(-1)!;
            const current = canvasToPng(canvas);

            setRedoStack((prev) => prev.slice(0, -1));
            setUndoStack((prev) => [...prev, current]);
            await restoreSnapshot(next);
        } finally {
            isRestoringRef.current = false;
            setRestoring(false);
        }
    }, [redoStack, restoreSnapshot]);

    const handleReset = useCallback(async () => {
        if (!originalDataUrlRef.current || isRestoringRef.current) {
            return;
        }

        isRestoringRef.current = true;
        setRestoring(true);

        try {
            await restoreSnapshot(originalDataUrlRef.current);
            setUndoStack([]);
            setRedoStack([]);
            setPendingOp(null);
        } finally {
            isRestoringRef.current = false;
            setRestoring(false);
        }
    }, [restoreSnapshot]);

    // ---------- Save / download ----------
    const handleSave = useCallback(async () => {
        const canvas = canvasRef.current;

        if (!canvas || !onSave) {
            return;
        }

        try {
            setSaving(true);
            let dataUrl: string;

            try {
                dataUrl = canvasToPng(canvas);
            } catch (error) {
                if (isCorsTaintError(error)) {
                    setErrorMessage(messages.corsBlocked);

                    return;
                }

                throw error;
            }

            if (dataUrl.length > SAFE_DATAURL_BYTES) {
                setErrorMessage(messages.imageTooLarge);

                return;
            }

            await onSave(dataUrl);
            // Saving a new version makes the canvas the new baseline.
            originalDataUrlRef.current = dataUrl;
            setUndoStack([]);
            setRedoStack([]);
            setErrorMessage(null);
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : messages.saveFailed);
        } finally {
            setSaving(false);
        }
    }, [onSave, messages.corsBlocked, messages.imageTooLarge, messages.saveFailed]);

    const handleDownload = useCallback(() => {
        const canvas = canvasRef.current;

        if (!canvas) {
            return;
        }

        try {
            const link = document.createElement("a");

            link.download = `${title ?? "image"}.png`;
            link.href = canvasToPng(canvas);
            link.click();
        } catch (error) {
            setErrorMessage(isCorsTaintError(error) ? messages.corsBlocked : messages.saveFailed);
        }
    }, [title, messages.corsBlocked, messages.saveFailed]);

    const handleSliderChange = useCallback((key: string, value: number | ReadonlyArray<number>) => {
        const numeric = Array.isArray(value) ? value[0] : (value as number);

        setPendingOp((prev) => (prev ? { ...prev, params: { ...prev.params, [key]: numeric } } : prev));
    }, []);

    const pendingApply = useCallback(() => {
        if (pendingOp) {
            applyOperation(pendingOp.op, pendingOp.params);
        }
    }, [applyOperation, pendingOp]);

    const pendingCancel = useCallback(() => {
        setPendingOp(null);
    }, []);

    // ---------- Render ----------

    return (
        <div className="flex h-full flex-col">
            {/* Top toolbar */}
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <div className="flex items-center gap-1">
                    <Button
                        aria-label={messages.undo}
                        disabled={undoStack.length === 0 || busy}
                        onClick={() => {
                            handleUndo();
                        }}
                        size="sm"
                        variant="ghost"
                    >
                        <UndoIcon aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                        aria-label={messages.redo}
                        disabled={redoStack.length === 0 || busy}
                        onClick={() => {
                            handleRedo();
                        }}
                        size="sm"
                        variant="ghost"
                    >
                        <RedoIcon aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                        aria-label={messages.reset}
                        disabled={!dirty || busy}
                        onClick={() => {
                            handleReset();
                        }}
                        size="sm"
                        variant="ghost"
                    >
                        <RotateCcwIcon aria-hidden="true" className="size-4" />
                    </Button>
                </div>
                <div aria-live="polite" className="text-muted-foreground text-xs" role="status">
                    {status === "loading" && messages.loadingEditor}
                    {status === "ready" && pendingOp && messages.previewLabel(getOpLabel(pendingOp.op))}
                    {status === "ready" && !pendingOp && dirty && messages.unsavedEdits(undoStack.length)}
                    {status === "ready" && !pendingOp && !dirty && messages.ready}
                </div>
                <div className="flex items-center gap-1">
                    <Button aria-label={messages.downloadPng} onClick={handleDownload} size="sm" variant="ghost">
                        <DownloadIcon aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                        aria-label={messages.saveAriaLabel}
                        disabled={!dirty || saving || !onSave}
                        onClick={() => {
                            handleSave();
                        }}
                        size="sm"
                    >
                        <SaveIcon aria-hidden="true" className="mr-1.5 size-4" />
                        {saving ? messages.saving : messages.saveVersion}
                    </Button>
                </div>
            </div>

            {errorMessage && (
                <div className="bg-destructive/10 text-destructive border-destructive/30 border-b px-3 py-1.5 text-xs" role="alert">
                    {errorMessage}
                </div>
            )}

            <div className="flex min-h-0 flex-1">
                {/* Canvas */}
                <div className="bg-muted/30 flex flex-1 items-center justify-center overflow-auto p-4">
                    {status === "loading" && <div className="text-muted-foreground text-sm">{messages.loadingImageEditor}</div>}
                    {status === "error" && <div className="text-destructive text-sm">{errorMessage ?? messages.loadError}</div>}
                    <canvas
                        aria-label={title ?? messages.loadError}
                        className={cn("max-h-full max-w-full bg-white shadow-md", "border border-black/10", status !== "ready" && "hidden")}
                        ref={canvasRef}
                        role="img"
                    />
                </div>

                {/* Sidebar */}
                <div className="bg-background w-72 shrink-0 border-l">
                    <Tabs
                        className="flex h-full flex-col"
                        defaultValue="filter"
                        onValueChange={(v) => setActiveCategory(v as OperationCategory)}
                        value={activeCategory}
                    >
                        <TabsList className="flex h-auto flex-wrap rounded-none border-b p-1">
                            {CATEGORIES.map((c) => (
                                <TabsTrigger className="text-xs" key={c} value={c}>
                                    {categoryLabels[c]}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                        {CATEGORIES.map((c) => (
                            <TabsContent className="m-0 flex-1 overflow-auto p-3" key={c} value={c}>
                                <div className={cn(c === "filter" ? "grid grid-cols-2 gap-2" : "flex flex-col gap-1.5")}>
                                    {OPERATIONS_BY_CATEGORY[c]?.map((op) => (
                                        <Button
                                            className={cn(
                                                c === "filter" ? "h-auto justify-start py-2" : "justify-start",
                                                pendingOp?.op.id === op.id && "ring-primary ring-2",
                                            )}
                                            disabled={status !== "ready" || busy}
                                            key={op.id}
                                            onClick={() => handleOperationClick(op)}
                                            size="sm"
                                            type="button"
                                            variant="outline"
                                        >
                                            {getOpLabel(op)}
                                        </Button>
                                    ))}
                                </div>
                            </TabsContent>
                        ))}
                    </Tabs>

                    {/* Pending operation panel */}
                    {pendingOp && (
                        <div className="bg-muted/40 border-t p-3">
                            <div className="mb-2 text-xs font-medium">{getOpLabel(pendingOp.op)}</div>
                            <div className="space-y-3">
                                {pendingOp.op.params?.map((spec) => (
                                    <div key={spec.key}>
                                        <div className="text-muted-foreground mb-1 flex items-center justify-between text-[11px]">
                                            <span>{getParameterLabel(pendingOp.op.id, spec)}</span>
                                            <span className="tabular-nums">{pendingOp.params[spec.key]?.toFixed(spec.step < 1 ? 2 : 0)}</span>
                                        </div>
                                        <Slider
                                            max={spec.max}
                                            min={spec.min}
                                            onValueChange={(v) => handleSliderChange(spec.key, v)}
                                            step={spec.step}
                                            value={[pendingOp.params[spec.key] ?? spec.default]}
                                        />
                                    </div>
                                ))}
                            </div>
                            <div className="mt-3 flex gap-2">
                                <Button className="flex-1" disabled={busy} onClick={pendingApply} size="sm">
                                    {messages.apply}
                                </Button>
                                <Button className="flex-1" onClick={pendingCancel} size="sm" variant="outline">
                                    {messages.cancel}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export const PhotonImageEditor = memo(PhotonImageEditorImpl);
PhotonImageEditor.displayName = "PhotonImageEditor";

export default PhotonImageEditor;
