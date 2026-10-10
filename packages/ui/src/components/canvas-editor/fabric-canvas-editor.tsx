/**
 * FabricCanvasEditor — Interactive Fabric.js canvas editor for design documents.
 *
 * This component is designed to be **code-split** (lazy-loaded) to avoid including
 * Fabric.js (~200KB gzip) in the main bundle. Import via:
 *
 * ```ts
 * const FabricCanvasEditor = lazy(() => import("@neore/ui/components/canvas-editor/fabric-canvas-editor"));
 * ```
 *
 * Features:
 * - Load/save Fabric.js JSON (via `canvasJson` / `onSave` props)
 * - Object manipulation: select, move, resize, rotate
 * - Drawing tools: text, rect, circle, line, freehand
 * - Layer controls: bring forward, send back
 * - Property panel for selected objects
 * - Element palette with shapes, text presets, and image upload
 * - Undo/redo stack
 * - Keyboard shortcuts: Delete, Ctrl+Z, Ctrl+Y, Ctrl+C, Ctrl+V, Ctrl+A
 * - Auto-save with debounce (1500ms)
 * - PNG preview generation on save
 */

"use client";

import { useLingui } from "@lingui/react/macro";
import type { Canvas, CanvasEvents, FabricObject, TOptions } from "fabric";
import { ActiveSelection, Circle, IText, Line, PencilBrush, Rect } from "fabric";
import {
    ArrowLeftIcon,
    ArrowRightIcon,
    CircleIcon,
    MinusIcon,
    MousePointerIcon,
    PanelLeftIcon,
    PanelRightIcon,
    PencilIcon,
    PlusIcon,
    Redo2Icon,
    SquareIcon,
    Trash2Icon,
    TypeIcon,
    Undo2Icon,
} from "lucide-react";
import type { FC, ReactNode } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import CanvasElementPalette from "./canvas-element-palette";
import CanvasPropertyPanel from "./canvas-property-panel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesignTool = "select" | "text" | "rect" | "circle" | "line" | "pencil";

export interface FabricCanvasEditorProps {
    /** Background color (hex). */
    backgroundColor?: string;
    /** Initial Fabric.js JSON to load. */
    canvasJson?: Record<string, unknown>;
    /** Dark mode for editor chrome (canvas itself uses backgroundColor). */
    darkMode?: boolean;
    /** Canvas height in pixels. */
    height: number;
    /** Called when canvas has unsaved changes. */
    onDirty?: () => void;
    /** Called on save with canvas JSON + PNG data URL preview. */
    onSave?: (canvasJson: Record<string, unknown>, previewDataUrl: string) => void;
    /** Read-only mode. */
    readOnly?: boolean;
    /** Canvas width in pixels. */
    width: number;
}

// ---------------------------------------------------------------------------
// Undo/Redo Manager
// ---------------------------------------------------------------------------

interface HistoryState {
    json: string;
}

const createHistoryManager = (maxSize = 50) => {
    const undoStack: HistoryState[] = [];
    const redoStack: HistoryState[] = [];
    let ignoreChanges = false;

    return {
        get canRedo() {
            return redoStack.length > 0;
        },
        get canUndo() {
            return undoStack.length > 0;
        },
        push(json: string) {
            if (ignoreChanges) {
                return;
            }

            undoStack.push({ json });

            if (undoStack.length > maxSize) {
                undoStack.shift();
            }

            redoStack.length = 0;
        },
        pushToRedo(json: string) {
            redoStack.push({ json });
        },
        redo(): string | null {
            const state = redoStack.pop();

            if (!state) {
                return null;
            }

            return state.json;
        },
        setIgnore(value: boolean) {
            ignoreChanges = value;
        },
        undo(): string | null {
            const state = undoStack.pop();

            if (!state) {
                return null;
            }

            return state.json;
        },
    };
};

// ---------------------------------------------------------------------------
// Toolbar button helper
// ---------------------------------------------------------------------------

const ToolButton: FC<{
    active?: boolean;
    children: ReactNode;
    disabled?: boolean;
    label: string;
    onClick: () => void;
}> = ({ active, children, disabled, label, onClick }) => (
    <button
        aria-label={label}
        className={`flex size-8 items-center justify-center rounded-md transition-colors ${
            active ? "bg-primary text-primary-foreground" : "hover:bg-accent text-foreground"
        } ${disabled ? "cursor-not-allowed opacity-30" : "cursor-pointer"}`}
        disabled={disabled}
        onClick={onClick}
        title={label}
        type="button"
    >
        {children}
    </button>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FabricCanvasEditor: FC<FabricCanvasEditorProps> = memo(
    ({ backgroundColor = "#ffffff", canvasJson, darkMode = false, height, onDirty, onSave, readOnly = false, width }) => {
        const { t } = useLingui();
        const canvasElementRef = useRef<HTMLCanvasElement>(null);
        const fabricRef = useRef<Canvas | null>(null);
        const historyRef = useRef(createHistoryManager());
        const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        const [activeTool, setActiveTool] = useState<DesignTool>("select");
        const [canUndo, setCanUndo] = useState(false);
        const [canRedo, setCanRedo] = useState(false);
        const [zoom, setZoom] = useState(1);
        const [showPalette, setShowPalette] = useState(true);
        const [showProperties, setShowProperties] = useState(true);
        // Force re-render of panels when canvas initializes
        const [canvasReady, setCanvasReady] = useState(false);
        // The canvas for the side panels, as state: `fabricRef` is for handlers,
        // and a ref may not be read during render.
        const [panelCanvas, setPanelCanvas] = useState<Canvas | null>(null);
        // The latest callbacks, for the listeners the mount effect registers once.
        const onSaveRef = useRef(onSave);
        const onDirtyRef = useRef(onDirty);

        useEffect(() => {
            onSaveRef.current = onSave;
            onDirtyRef.current = onDirty;
        }, [onDirty, onSave]);

        // ---- Auto-save (debounced) ----
        // Declared before the mount effect that registers it, and stable: it reads
        // the latest `onSave` when the timer fires, not the one from mount.
        const scheduleSave = useCallback(() => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }

            saveTimerRef.current = setTimeout(() => {
                const canvas = fabricRef.current;
                const save = onSaveRef.current;

                if (!canvas || !save) {
                    return;
                }

                const json = canvas.toJSON() as Record<string, unknown>;
                const preview = canvas.toDataURL({ format: "png", multiplier: 0.5 });

                save(json, preview);
            }, 1500);
        }, []);

        // ---- Initialize Fabric.js canvas ----
        useEffect(() => {
            let mounted = true;

            // Kicks off `loadFromJSON` synchronously so the `object:added` events it
            // emits still reach the listeners registered below, exactly as the
            // previous `.then()` nesting did.
            const loadInitialJson = async (canvas: Canvas, json: NonNullable<FabricCanvasEditorProps["canvasJson"]>) => {
                await canvas.loadFromJSON(json);
                canvas.renderAll();
                historyRef.current.setIgnore(false);
                // Save initial state for undo baseline
                historyRef.current.push(JSON.stringify(canvas.toJSON()));
                setCanvasReady(true);
            };

            // Dynamic import to ensure tree-shaking for SSR
            const initCanvas = async () => {
                const { Canvas: FabricCanvas } = await import("fabric");

                if (!mounted || !canvasElementRef.current) {
                    return;
                }

                const canvas = new FabricCanvas(canvasElementRef.current, {
                    backgroundColor,
                    height,
                    preserveObjectStacking: true,
                    selection: !readOnly,
                    width,
                });

                fabricRef.current = canvas;
                setPanelCanvas(canvas);

                // Load initial JSON if provided
                if (canvasJson) {
                    historyRef.current.setIgnore(true);
                    loadInitialJson(canvas, canvasJson);
                } else {
                    // Save initial blank state
                    historyRef.current.push(JSON.stringify(canvas.toJSON()));
                    setCanvasReady(true);
                }

                // Track changes for undo/redo + dirty state
                const trackChange = () => {
                    if (readOnly) {
                        return;
                    }

                    const json = JSON.stringify(canvas.toJSON());

                    historyRef.current.push(json);
                    setCanUndo(historyRef.current.canUndo);
                    setCanRedo(historyRef.current.canRedo);
                    onDirtyRef.current?.();
                    scheduleSave();
                };

                canvas.on("object:modified" as keyof CanvasEvents, trackChange);
                canvas.on("object:added" as keyof CanvasEvents, trackChange);
                canvas.on("object:removed" as keyof CanvasEvents, trackChange);
            };

            initCanvas();

            return () => {
                mounted = false;

                if (saveTimerRef.current) {
                    clearTimeout(saveTimerRef.current);
                }

                fabricRef.current?.dispose();
                fabricRef.current = null;
            };
            // Only re-init on mount — JSON changes handled via loadFromJSON
        }, []);

        // ---- Tool actions ----
        const handleSelectTool = useCallback((tool: DesignTool) => {
            const canvas = fabricRef.current;

            if (!canvas) {
                return;
            }

            setActiveTool(tool);

            // Reset drawing mode
            canvas.isDrawingMode = false;
            canvas.selection = true;
            canvas.defaultCursor = "default";

            if (tool === "pencil") {
                canvas.isDrawingMode = true;
                canvas.freeDrawingBrush = new PencilBrush(canvas);
                canvas.freeDrawingBrush.width = 2;
                canvas.freeDrawingBrush.color = "#000000";
            }
        }, []);

        const handleAddShape = useCallback(
            (tool: DesignTool) => {
                const canvas = fabricRef.current;

                if (!canvas) {
                    return;
                }

                let obj: FabricObject | null = null;
                const center = canvas.getCenterPoint();

                switch (tool) {
                    case "circle": {
                        obj = new Circle({
                            fill: "#D94A4A",
                            left: center.x - 40,
                            radius: 40,
                            stroke: "#8A2C2C",
                            strokeWidth: 1,
                            top: center.y - 40,
                        });
                        break;
                    }
                    case "line": {
                        obj = new Line([center.x - 60, center.y, center.x + 60, center.y], {
                            stroke: "#000000",
                            strokeWidth: 2,
                        });
                        break;
                    }
                    case "rect": {
                        obj = new Rect({
                            fill: "#4A90D9",
                            height: 100,
                            left: center.x - 50,
                            rx: 4,
                            ry: 4,
                            stroke: "#2C5F8A",
                            strokeWidth: 1,
                            top: center.y - 50,
                            width: 100,
                        });
                        break;
                    }
                    case "text": {
                        obj = new IText(t`Edit me`, {
                            fill: "#000000",
                            fontFamily: "Inter, sans-serif",
                            fontSize: 24,
                            left: center.x - 50,
                            top: center.y - 15,
                        });
                        break;
                    }
                    default: {
                        break;
                    }
                }

                if (obj) {
                    canvas.add(obj);
                    canvas.setActiveObject(obj);
                    canvas.renderAll();
                    // Switch back to select after adding
                    handleSelectTool("select");
                }
            },
            [handleSelectTool, t],
        );

        // ---- Undo / Redo ----
        const handleUndo = useCallback(async () => {
            const canvas = fabricRef.current;

            if (!canvas) {
                return;
            }

            // Save current state to redo stack
            const current = JSON.stringify(canvas.toJSON());

            historyRef.current.pushToRedo(current);

            const prev = historyRef.current.undo();

            if (!prev) {
                return;
            }

            historyRef.current.setIgnore(true);
            await canvas.loadFromJSON(JSON.parse(prev) as TOptions<Canvas>);
            canvas.renderAll();
            historyRef.current.setIgnore(false);
            setCanUndo(historyRef.current.canUndo);
            setCanRedo(historyRef.current.canRedo);
            scheduleSave();
        }, [scheduleSave]);

        const handleRedo = useCallback(async () => {
            const canvas = fabricRef.current;

            if (!canvas) {
                return;
            }

            // Save current state to undo stack
            const current = JSON.stringify(canvas.toJSON());

            historyRef.current.push(current);

            const next = historyRef.current.redo();

            if (!next) {
                return;
            }

            historyRef.current.setIgnore(true);
            await canvas.loadFromJSON(JSON.parse(next) as TOptions<Canvas>);
            canvas.renderAll();
            historyRef.current.setIgnore(false);
            setCanUndo(historyRef.current.canUndo);
            setCanRedo(historyRef.current.canRedo);
            scheduleSave();
        }, [scheduleSave]);

        // ---- Delete selected ----
        const handleDeleteSelected = useCallback(() => {
            const canvas = fabricRef.current;

            if (!canvas) {
                return;
            }

            const active = canvas.getActiveObjects();

            if (active.length === 0) {
                return;
            }

            for (const obj of active) {
                canvas.remove(obj);
            }

            canvas.discardActiveObject();
            canvas.renderAll();
        }, []);

        // ---- Layer controls ----
        const handleBringForward = useCallback(() => {
            const canvas = fabricRef.current;

            if (!canvas) {
                return;
            }

            const active = canvas.getActiveObject();

            if (active) {
                canvas.bringObjectForward(active);
                canvas.renderAll();
            }
        }, []);

        const handleSendBackward = useCallback(() => {
            const canvas = fabricRef.current;

            if (!canvas) {
                return;
            }

            const active = canvas.getActiveObject();

            if (active) {
                canvas.sendObjectBackwards(active);
                canvas.renderAll();
            }
        }, []);

        // ---- Zoom ----
        const handleZoom = useCallback(
            (delta: number) => {
                const canvas = fabricRef.current;

                if (!canvas) {
                    return;
                }

                const newZoom = Math.max(0.1, Math.min(5, zoom + delta));

                setZoom(newZoom);
                canvas.setZoom(newZoom);
                canvas.renderAll();
            },
            [zoom],
        );

        // ---- Keyboard shortcuts ----
        useEffect(() => {
            const handleKeyDown = (e: KeyboardEvent) => {
                if (readOnly) {
                    return;
                }

                const canvas = fabricRef.current;

                if (!canvas) {
                    return;
                }

                // Don't capture shortcuts when editing text
                const active = canvas.getActiveObject();

                if (active instanceof IText && active.isEditing) {
                    return;
                }

                const isCtrl = e.ctrlKey || e.metaKey;

                if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    handleDeleteSelected();
                } else if (isCtrl && e.key === "z" && !e.shiftKey) {
                    e.preventDefault();
                    handleUndo();
                } else if (isCtrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
                    e.preventDefault();
                    handleRedo();
                } else if (isCtrl && e.key === "a") {
                    e.preventDefault();
                    canvas.discardActiveObject();
                    const allObjects = canvas.getObjects();

                    if (allObjects.length > 0) {
                        const sel = new ActiveSelection(allObjects, { canvas });

                        canvas.setActiveObject(sel);
                        canvas.renderAll();
                    }
                }
            };

            document.addEventListener("keydown", handleKeyDown);

            return () => document.removeEventListener("keydown", handleKeyDown);
        }, [readOnly, handleDeleteSelected, handleUndo, handleRedo]);

        return (
            <div className="flex h-full flex-col">
                {/* Toolbar */}
                {!readOnly && (
                    <div
                        className={`flex items-center gap-1 border-b px-3 py-1.5 ${
                            darkMode ? "border-white/10 bg-neutral-900" : "border-neutral-200 bg-white"
                        }`}
                    >
                        {/* Panel toggles */}
                        <div className="mr-1 flex items-center gap-0.5 border-r pr-2">
                            <ToolButton active={showPalette} label={t`Toggle element palette`} onClick={() => setShowPalette((v) => !v)}>
                                <PanelLeftIcon className="size-4" />
                            </ToolButton>
                            <ToolButton active={showProperties} label={t`Toggle property panel`} onClick={() => setShowProperties((v) => !v)}>
                                <PanelRightIcon className="size-4" />
                            </ToolButton>
                        </div>

                        {/* Tool selection */}
                        <div className="mr-1 flex items-center gap-0.5 border-r pr-2">
                            <ToolButton active={activeTool === "select"} label={t`Select`} onClick={() => handleSelectTool("select")}>
                                <MousePointerIcon className="size-4" />
                            </ToolButton>
                            <ToolButton label={t`Add Text`} onClick={() => handleAddShape("text")}>
                                <TypeIcon className="size-4" />
                            </ToolButton>
                            <ToolButton label={t`Add Rectangle`} onClick={() => handleAddShape("rect")}>
                                <SquareIcon className="size-4" />
                            </ToolButton>
                            <ToolButton label={t`Add Circle`} onClick={() => handleAddShape("circle")}>
                                <CircleIcon className="size-4" />
                            </ToolButton>
                            <ToolButton active={activeTool === "pencil"} label={t`Freehand Draw`} onClick={() => handleSelectTool("pencil")}>
                                <PencilIcon className="size-4" />
                            </ToolButton>
                        </div>

                        {/* Undo / Redo */}
                        <div className="mr-1 flex items-center gap-0.5 border-r pr-2">
                            <ToolButton disabled={!canUndo} label={t`Undo`} onClick={handleUndo}>
                                <Undo2Icon className="size-4" />
                            </ToolButton>
                            <ToolButton disabled={!canRedo} label={t`Redo`} onClick={handleRedo}>
                                <Redo2Icon className="size-4" />
                            </ToolButton>
                        </div>

                        {/* Layer controls */}
                        <div className="mr-1 flex items-center gap-0.5 border-r pr-2">
                            <ToolButton label={t`Bring Forward`} onClick={handleBringForward}>
                                <ArrowRightIcon className="size-4" />
                            </ToolButton>
                            <ToolButton label={t`Send Backward`} onClick={handleSendBackward}>
                                <ArrowLeftIcon className="size-4" />
                            </ToolButton>
                        </div>

                        {/* Delete */}
                        <div className="mr-1 flex items-center gap-0.5 border-r pr-2">
                            <ToolButton label={t`Delete Selected`} onClick={handleDeleteSelected}>
                                <Trash2Icon className="size-4" />
                            </ToolButton>
                        </div>

                        {/* Zoom */}
                        <div className="flex items-center gap-0.5">
                            <ToolButton label={t`Zoom Out`} onClick={() => handleZoom(-0.1)}>
                                <MinusIcon className="size-4" />
                            </ToolButton>
                            <span className="text-muted-foreground min-w-[3rem] text-center text-xs">{Math.round(zoom * 100)}%</span>
                            <ToolButton label={t`Zoom In`} onClick={() => handleZoom(0.1)}>
                                <PlusIcon className="size-4" />
                            </ToolButton>
                        </div>
                    </div>
                )}

                {/* Main content area with optional sidebars */}
                <div className="flex flex-1" style={{ minHeight: 0 }}>
                    {/* Element palette (left sidebar) */}
                    {!readOnly && showPalette && canvasReady && <CanvasElementPalette canvas={panelCanvas} darkMode={darkMode} />}

                    {/* Canvas container */}
                    <div
                        className={`flex flex-1 items-center justify-center overflow-auto ${darkMode ? "bg-neutral-800" : "bg-neutral-100"}`}
                        style={{ minHeight: 0 }}
                    >
                        <div
                            className="shadow-lg"
                            style={{
                                transform: `scale(${zoom})`,
                                transformOrigin: "center center",
                            }}
                        >
                            <canvas ref={canvasElementRef} />
                        </div>
                    </div>

                    {/* Property panel (right sidebar) */}
                    {!readOnly && showProperties && canvasReady && <CanvasPropertyPanel canvas={panelCanvas} darkMode={darkMode} />}
                </div>
            </div>
        );
    },
);

FabricCanvasEditor.displayName = "FabricCanvasEditor";

export { FabricCanvasEditor };
