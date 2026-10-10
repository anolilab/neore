/**
 * Mask Editor
 *
 * Canvas-based drawing tool for creating inpaint/outpaint masks.
 * Supports freehand brush and eraser with adjustable size.
 * Outputs a data URL of the mask image (white = edit region, black = keep).
 */
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import { Check, Eraser, Paintbrush, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface MaskEditorProps {
    /** Height of the canvas in pixels */
    height?: number;
    /** Source image URL to draw the mask on top of */
    imageUrl: string;
    /** Callback when editor is closed without saving */
    onCancel: () => void;
    /** Callback when mask is saved, receives data URL of the mask */
    onSave: (maskDataUrl: string) => void;
    /** Width of the canvas in pixels */
    width?: number;
}

type Tool = "brush" | "eraser";

const MaskEditor = ({ height = 512, imageUrl, onCancel, onSave, width = 512 }: MaskEditorProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const { t } = useLingui();
    const [tool, setTool] = useState<Tool>("brush");
    const [brushSize, setBrushSize] = useState(30);
    // Only read inside pointer handlers, never rendered — a ref avoids a re-render per stroke.
    const isDrawingRef = useRef(false);
    const [imageLoaded, setImageLoaded] = useState(false);
    const imageRef = useRef<HTMLImageElement | null>(null);

    // Initialize the canvas with the source image
    useEffect(() => {
        const canvas = canvasRef.current;
        const maskCanvas = maskCanvasRef.current;

        if (!canvas || !maskCanvas) return undefined;

        const context = canvas.getContext("2d");
        const maskContext = maskCanvas.getContext("2d");

        if (!context || !maskContext) return undefined;

        const img = new Image();

        img.crossOrigin = "anonymous";

        const handleLoad = () => {
            imageRef.current = img;

            // Set canvas dimensions to match image aspect ratio within bounds
            const aspectRatio = img.width / img.height;
            let canvasWidth = width;
            let canvasHeight = height;

            if (aspectRatio > 1) {
                canvasHeight = Math.round(width / aspectRatio);
            } else {
                canvasWidth = Math.round(height * aspectRatio);
            }

            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            maskCanvas.width = canvasWidth;
            maskCanvas.height = canvasHeight;

            // Draw the source image
            context.drawImage(img, 0, 0, canvasWidth, canvasHeight);

            // Initialize mask canvas as fully black (keep everything)
            maskContext.fillStyle = "#000000";
            maskContext.fillRect(0, 0, canvasWidth, canvasHeight);

            setImageLoaded(true);
        };

        img.addEventListener("load", handleLoad);
        img.src = imageUrl;

        return () => {
            img.removeEventListener("load", handleLoad);
        };
    }, [imageUrl, width, height]);

    // Redraw composite (image + mask overlay)
    const redraw = useCallback(() => {
        const canvas = canvasRef.current;
        const maskCanvas = maskCanvasRef.current;
        const img = imageRef.current;

        if (!canvas || !maskCanvas || !img) return;

        const context = canvas.getContext("2d");

        if (!context) return;

        // Draw original image
        context.drawImage(img, 0, 0, canvas.width, canvas.height);

        // Draw mask overlay (semi-transparent red for painted areas)
        context.globalAlpha = 0.4;
        context.drawImage(maskCanvas, 0, 0);
        context.globalAlpha = 1;
    }, []);

    const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;

        if (!canvas) return { x: 0, y: 0 };

        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;

        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
        };
    }, []);

    const drawAt = useCallback(
        (x: number, y: number) => {
            const maskCanvas = maskCanvasRef.current;

            if (!maskCanvas) return;

            const maskContext = maskCanvas.getContext("2d");

            if (!maskContext) return;

            maskContext.beginPath();
            maskContext.arc(x, y, brushSize / 2, 0, Math.PI * 2);

            // White = area to edit, black = area to keep (eraser restores).
            maskContext.fillStyle = tool === "brush" ? "#ffffff" : "#000000";

            maskContext.fill();
            redraw();
        },
        [brushSize, tool, redraw],
    );

    const handleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            isDrawingRef.current = true;

            const { x, y } = getCanvasCoords(e);

            drawAt(x, y);
        },
        [getCanvasCoords, drawAt],
    );

    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            if (!isDrawingRef.current) return;

            const { x, y } = getCanvasCoords(e);

            drawAt(x, y);
        },
        [getCanvasCoords, drawAt],
    );

    const handleMouseUp = useCallback(() => {
        isDrawingRef.current = false;
    }, []);

    const handleClear = useCallback(() => {
        const maskCanvas = maskCanvasRef.current;

        if (!maskCanvas) return;

        const maskContext = maskCanvas.getContext("2d");

        if (!maskContext) return;

        maskContext.fillStyle = "#000000";
        maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
        redraw();
    }, [redraw]);

    const handleSave = useCallback(() => {
        const maskCanvas = maskCanvasRef.current;

        if (!maskCanvas) return;

        // Export mask as data URL (white = edit, black = keep)
        const dataUrl = maskCanvas.toDataURL("image/png");

        onSave(dataUrl);
    }, [onSave]);

    return (
        <div className="flex flex-col gap-3">
            {/* Toolbar */}
            <div className="flex items-center gap-2">
                <div aria-label={t`Drawing tools`} className="bg-muted flex items-center gap-1 rounded-lg p-1" role="group">
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button
                                    aria-label={t`Brush (paint mask)`}
                                    aria-pressed={tool === "brush"}
                                    className={`rounded p-1.5 transition-colors ${tool === "brush" ? "bg-primary text-primary-foreground" : "hover:bg-muted-foreground/10"}`}
                                    onClick={() => setTool("brush")}
                                    type="button"
                                >
                                    <Paintbrush aria-hidden="true" className="size-4" />
                                </button>
                            }
                        />
                        <TooltipContent>
                            <p>
                                <Trans>Brush (paint mask)</Trans>
                            </p>
                        </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <button
                                    aria-label={t`Eraser (remove mask)`}
                                    aria-pressed={tool === "eraser"}
                                    className={`rounded p-1.5 transition-colors ${tool === "eraser" ? "bg-primary text-primary-foreground" : "hover:bg-muted-foreground/10"}`}
                                    onClick={() => setTool("eraser")}
                                    type="button"
                                >
                                    <Eraser aria-hidden="true" className="size-4" />
                                </button>
                            }
                        />
                        <TooltipContent>
                            <p>
                                <Trans>Eraser (remove mask)</Trans>
                            </p>
                        </TooltipContent>
                    </Tooltip>
                </div>

                {/* Brush size slider */}
                <div className="flex items-center gap-2">
                    <span className="text-muted-foreground text-[10px]">
                        <Trans>Size</Trans>
                    </span>
                    <input
                        aria-label={t`Brush size`}
                        className="h-1.5 w-20 accent-current"
                        max="100"
                        min="5"
                        onChange={(e) => setBrushSize(Number(e.target.value))}
                        type="range"
                        value={brushSize}
                    />
                    <span className="text-muted-foreground w-6 text-[10px]">{brushSize}</span>
                </div>

                <div className="flex-1" />

                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button aria-label={t`Clear mask`} className="size-7" onClick={handleClear} size="icon" variant="ghost">
                                <RotateCcw className="size-3.5" />
                            </Button>
                        }
                    />
                    <TooltipContent>
                        <p>
                            <Trans>Clear mask</Trans>
                        </p>
                    </TooltipContent>
                </Tooltip>

                <Button className="h-7 gap-1.5 px-2 text-xs" onClick={onCancel} size="sm" variant="ghost">
                    <X className="size-3" />
                    <Trans>Cancel</Trans>
                </Button>
                <Button className="h-7 gap-1.5 px-2 text-xs" disabled={!imageLoaded} onClick={handleSave} size="sm">
                    <Check className="size-3" />
                    <Trans>Apply Mask</Trans>
                </Button>
            </div>

            {/* Canvas */}
            <div className="relative overflow-hidden rounded border">
                <canvas
                    className="block max-h-[400px] w-full cursor-crosshair object-contain"
                    onMouseDown={handleMouseDown}
                    onMouseLeave={handleMouseUp}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    ref={canvasRef}
                />
                {/* Hidden mask canvas for export */}
                <canvas className="hidden" ref={maskCanvasRef} />
            </div>

            <p className="text-muted-foreground text-[10px]">
                <Trans>Paint over the areas you want to edit. White regions will be regenerated, dark regions will be preserved.</Trans>
            </p>
        </div>
    );
};

export default MaskEditor;
