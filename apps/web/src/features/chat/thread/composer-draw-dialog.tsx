"use client";

/**
 * ComposerDrawPanel - Freehand drawing canvas for creating image attachments
 *
 * Provides a full-featured drawing canvas with pen, eraser, color picker,
 * configurable stroke width, undo, and clear. Exports the drawing as a PNG File
 * that can be attached to a message.
 *
 * Rendered inline in the composer (not as a modal dialog).
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { ColorPicker } from "@neore/ui/components/color-picker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import { Eraser, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const DATA_URL_MIME_RE = /^[^:]*:([^;]*);/;

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const MAX_HISTORY = 20;

const COLOR_SWATCHES = ["#000000", "#ffffff", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#92400e", "#0ea5e9"];

const STROKE_SIZES: { label: string; tooltip: MessageDescriptor; value: number }[] = [
    { label: "S", tooltip: msg`Thin`, value: 2 },
    { label: "M", tooltip: msg`Medium`, value: 6 },
    { label: "L", tooltip: msg`Thick`, value: 14 },
];

interface ComposerDrawPanelProps {
    onClose: () => void;
    onDraw: (file: File) => void;
}

const ComposerDrawPanel: FC<ComposerDrawPanelProps> = ({ onClose, onDraw }) => {
    const { i18n, t } = useLingui();

    // Canvas & drawing refs
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isDrawingRef = useRef(false);
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    const historyRef = useRef<ImageData[]>([]);

    // Tool settings (mirrored to refs so pointer handlers always see the latest value)
    const [tool, setTool] = useState<"eraser" | "pen">("pen");
    const [color, setColor] = useState("#000000");
    const [strokeWidth, setStrokeWidth] = useState(6);
    const [canUndo, setCanUndo] = useState(false);

    const toolRef = useRef(tool);
    const colorRef = useRef(color);
    const strokeWidthRef = useRef(strokeWidth);

    useEffect(() => {
        toolRef.current = tool;
    }, [tool]);
    useEffect(() => {
        colorRef.current = color;
    }, [color]);
    useEffect(() => {
        strokeWidthRef.current = strokeWidth;
    }, [strokeWidth]);

    // Fill canvas with white background
    const fillWhite = useCallback(() => {
        const context = canvasRef.current?.getContext("2d");

        if (!context) {
            return;
        }

        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }, []);

    // Push current canvas state onto the undo history stack
    const pushHistory = () => {
        const context = canvasRef.current?.getContext("2d");

        if (!context) {
            return;
        }

        const snapshot = context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        if (historyRef.current.length >= MAX_HISTORY) {
            historyRef.current.shift();
        }

        historyRef.current.push(snapshot);
        setCanUndo(true);
    };

    // Initialise canvas on mount
    useEffect(() => {
        const timer = setTimeout(() => {
            historyRef.current = [];
            setCanUndo(false);
            fillWhite();
        }, 50);

        return () => clearTimeout(timer);
    }, [fillWhite]);

    // --- Pointer position helpers ---
    const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;

        if (!canvas) {
            return { x: 0, y: 0 };
        }

        const rect = canvas.getBoundingClientRect();

        return {
            x: (e.clientX - rect.left) * (CANVAS_WIDTH / rect.width),
            y: (e.clientY - rect.top) * (CANVAS_HEIGHT / rect.height),
        };
    };

    // --- Pointer event handlers ---
    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pushHistory(); // save state before stroke so it can be undone

        const pos = getPos(e);

        isDrawingRef.current = true;
        lastPointRef.current = pos;

        // Paint a dot on click (for tap / click without move)
        const context = canvasRef.current?.getContext("2d");

        if (!context) {
            return;
        }

        context.beginPath();
        context.arc(pos.x, pos.y, strokeWidthRef.current / 2, 0, Math.PI * 2);
        context.fillStyle = toolRef.current === "eraser" ? "#ffffff" : colorRef.current;
        context.fill();
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!isDrawingRef.current) {
            return;
        }

        const context = canvasRef.current?.getContext("2d");

        if (!context) {
            return;
        }

        const pos = getPos(e);
        const from = lastPointRef.current ?? pos;

        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(pos.x, pos.y);
        context.strokeStyle = toolRef.current === "eraser" ? "#ffffff" : colorRef.current;
        context.lineWidth = strokeWidthRef.current;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.stroke();

        lastPointRef.current = pos;
    };

    const handlePointerUp = () => {
        isDrawingRef.current = false;
        lastPointRef.current = null;
    };

    // --- Toolbar actions ---
    const handleUndo = () => {
        if (historyRef.current.length === 0) {
            return;
        }

        const context = canvasRef.current?.getContext("2d");

        if (!context) {
            return;
        }

        const state = historyRef.current.pop();

        if (!state) {
            return;
        }

        context.putImageData(state, 0, 0);
        setCanUndo(historyRef.current.length > 0);
    };

    const handleClear = () => {
        pushHistory(); // allow undoing the clear
        fillWhite();
    };

    const handleUseDraw = () => {
        const source = canvasRef.current;

        if (!source) {
            return;
        }

        // Composite the drawing onto a fresh white-background canvas before exporting.
        // This ensures the PNG always has an opaque white background regardless of
        // whether fillWhite() was called, and avoids async blob-timing issues.
        const out = document.createElement("canvas");

        out.width = CANVAS_WIDTH;
        out.height = CANVAS_HEIGHT;

        const context = out.getContext("2d");

        if (!context) {
            return;
        }

        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        context.drawImage(source, 0, 0);

        // toDataURL is synchronous — no timing issues with canvas being unmounted
        const dataUrl = out.toDataURL("image/png");
        const [header, b64] = dataUrl.split(",") as [string, string];
        const mime = (header.match(DATA_URL_MIME_RE) ?? [])[1] ?? "image/png";
        const binary = atob(b64);
        const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);

        const file = new File([bytes], `drawing-${Date.now()}.png`, { type: mime });

        onDraw(file);
        onClose();
    };

    // Shared button class for tool/size toggle buttons
    const toolButtonClass = (active: boolean) =>
        clsx(
            "flex h-8 w-8 items-center justify-center rounded-md border text-xs font-medium transition-colors",
            active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-transparent hover:bg-muted",
        );

    return (
        <div className="border-border bg-background flex flex-col overflow-hidden rounded-lg border shadow-sm">
            {/* ── Toolbar ── */}
            <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
                <span className="text-foreground mr-1 text-sm font-medium">{t`Draw an image`}</span>

                <div className="grow" />

                {/* Tool selector */}
                <div className="flex items-center gap-1">
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button className={toolButtonClass(tool === "pen")} onClick={() => setTool("pen")} type="button">
                                    <Pencil className="size-4" />
                                </button>
                            }
                        />
                        <TooltipContent side="bottom">{t`Pen`}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button className={toolButtonClass(tool === "eraser")} onClick={() => setTool("eraser")} type="button">
                                    <Eraser className="size-4" />
                                </button>
                            }
                        />
                        <TooltipContent side="bottom">{t`Eraser`}</TooltipContent>
                    </Tooltip>
                </div>

                <div className="bg-border h-6 w-px" />

                {/* Color picker */}
                <ColorPicker
                    hideContrastRatio
                    onValueChange={(value) => {
                        setColor(value.hex);
                        setTool("pen");
                    }}
                    swatches={COLOR_SWATCHES as `#${string}`[]}
                    type="hex"
                    value={color as `#${string}`}
                >
                    <button
                        aria-label={t`Pick color`}
                        className={clsx(
                            "size-7.5 rounded-md border transition-all hover:scale-105",
                            tool === "pen" ? "border-border scale-105 shadow-sm" : "border-border",
                            color === "#ffffff" && "shadow-[inset_0_0_0_1px_hsl(var(--border))]",
                        )}
                        style={{ backgroundColor: color }}
                        title={t`Pick color`}
                        type="button"
                    />
                </ColorPicker>

                <div className="bg-border h-6 w-px" />

                {/* Stroke width */}
                <div className="flex items-center gap-1">
                    {STROKE_SIZES.map(({ label, tooltip, value }) => (
                        <Tooltip key={value}>
                            <TooltipTrigger
                                render={
                                    <button
                                        aria-label={i18n._(tooltip)}
                                        className={toolButtonClass(strokeWidth === value)}
                                        onClick={() => setStrokeWidth(value)}
                                        type="button"
                                    >
                                        {label}
                                    </button>
                                }
                            />
                            <TooltipContent side="bottom">{i18n._(tooltip)}</TooltipContent>
                        </Tooltip>
                    ))}
                </div>

                <div className="bg-border h-6 w-px" />

                {/* Undo & Clear */}
                <div className="flex items-center gap-1">
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button className={clsx(toolButtonClass(false), "disabled:opacity-40")} disabled={!canUndo} onClick={handleUndo} type="button">
                                    <RotateCcw className="size-4" />
                                </button>
                            }
                        />
                        <TooltipContent side="bottom">{t`Undo`}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button className={toolButtonClass(false)} onClick={handleClear} type="button">
                                    <Trash2 className="size-4" />
                                </button>
                            }
                        />
                        <TooltipContent side="bottom">{t`Clear canvas`}</TooltipContent>
                    </Tooltip>
                </div>
            </div>

            {/* ── Canvas ── */}
            <div className="bg-muted/40 flex flex-1 items-center justify-center overflow-hidden p-4">
                <canvas
                    className="block max-h-full max-w-full cursor-crosshair touch-none rounded border shadow-sm"
                    height={CANVAS_HEIGHT}
                    onPointerCancel={handlePointerUp}
                    onPointerDown={handlePointerDown}
                    onPointerLeave={handlePointerUp}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    ref={canvasRef}
                    style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`, background: "#ffffff" }}
                    width={CANVAS_WIDTH}
                />
            </div>

            {/* ── Bottom action bar ── */}
            <div className="border-border flex items-center justify-end gap-2 border-t px-4 py-3">
                <Button onClick={onClose} size="sm" variant="ghost">
                    {t`Cancel`}
                </Button>

                <Button onClick={handleUseDraw} size="sm">
                    {t`Use Drawing`}
                </Button>
            </div>
        </div>
    );
};

ComposerDrawPanel.displayName = "ComposerDrawPanel";

export default ComposerDrawPanel;
