/**
 * CanvasElementPalette — Sidebar with draggable/clickable elements to add to the canvas.
 * Includes basic shapes, text presets, and image upload.
 */

"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Canvas } from "fabric";
import { CircleIcon, DiamondIcon, ImageIcon, MinusIcon, SquareIcon, StarIcon, TriangleIcon, TypeIcon } from "lucide-react";
import type { ChangeEvent, FC } from "react";
import { memo, useCallback, useRef, useState } from "react";

interface CanvasElementPaletteProps {
    canvas: Canvas | null;
    darkMode?: boolean;
}

// ---------------------------------------------------------------------------
// Shape definitions
// ---------------------------------------------------------------------------

interface ShapeEntry {
    create: (canvas: Canvas) => void;
    icon: FC<{ className?: string }>;
    id: string;
    label: MessageDescriptor;
}

const SHAPES: ShapeEntry[] = [
    {
        create: async (canvas) => {
            const { Rect } = await import("fabric");

            const center = canvas.getCenterPoint();
            const obj = new Rect({
                fill: "#4A90D9",
                height: 80,
                left: center.x - 60,
                rx: 4,
                ry: 4,
                stroke: "#2C5F8A",
                strokeWidth: 1,
                top: center.y - 40,
                width: 120,
            });

            canvas.add(obj);
            canvas.setActiveObject(obj);
            canvas.renderAll();
        },
        icon: SquareIcon,
        id: "rect",
        label: msg`Rectangle`,
    },
    {
        create: async (canvas) => {
            const { Circle } = await import("fabric");

            const center = canvas.getCenterPoint();
            const obj = new Circle({
                fill: "#D94A4A",
                left: center.x - 40,
                radius: 40,
                stroke: "#8A2C2C",
                strokeWidth: 1,
                top: center.y - 40,
            });

            canvas.add(obj);
            canvas.setActiveObject(obj);
            canvas.renderAll();
        },
        icon: CircleIcon,
        id: "circle",
        label: msg`Circle`,
    },
    {
        create: async (canvas) => {
            const { Triangle } = await import("fabric");

            const center = canvas.getCenterPoint();
            const obj = new Triangle({
                fill: "#4AD97A",
                height: 70,
                left: center.x - 40,
                stroke: "#2C8A4F",
                strokeWidth: 1,
                top: center.y - 35,
                width: 80,
            });

            canvas.add(obj);
            canvas.setActiveObject(obj);
            canvas.renderAll();
        },
        icon: TriangleIcon,
        id: "triangle",
        label: msg`Triangle`,
    },
    {
        create: async (canvas) => {
            const { Rect } = await import("fabric");

            const center = canvas.getCenterPoint();
            const obj = new Rect({
                angle: 45,
                fill: "#D9A84A",
                height: 70,
                left: center.x - 35,
                stroke: "#8A6B2C",
                strokeWidth: 1,
                top: center.y - 35,
                width: 70,
            });

            canvas.add(obj);
            canvas.setActiveObject(obj);
            canvas.renderAll();
        },
        icon: DiamondIcon,
        id: "diamond",
        label: msg`Diamond`,
    },
    {
        create: async (canvas) => {
            const { Line } = await import("fabric");

            const center = canvas.getCenterPoint();
            const obj = new Line([center.x - 60, center.y, center.x + 60, center.y], {
                stroke: "#000000",
                strokeWidth: 2,
            });

            canvas.add(obj);
            canvas.setActiveObject(obj);
            canvas.renderAll();
        },
        icon: MinusIcon,
        id: "line",
        label: msg`Line`,
    },
    {
        create: async (canvas) => {
            const { Path } = await import("fabric");

            const center = canvas.getCenterPoint();
            // 5-point star SVG path
            const starPath = "M 50 0 L 61 35 L 98 35 L 68 57 L 79 91 L 50 70 L 21 91 L 32 57 L 2 35 L 39 35 Z";
            const obj = new Path(starPath, {
                fill: "#FFD700",
                left: center.x - 49,
                scaleX: 0.8,
                scaleY: 0.8,
                stroke: "#B8860B",
                strokeWidth: 1,
                top: center.y - 45,
            });

            canvas.add(obj);
            canvas.setActiveObject(obj);
            canvas.renderAll();
        },
        icon: StarIcon,
        id: "star",
        label: msg`Star`,
    },
];

// ---------------------------------------------------------------------------
// Text presets
// ---------------------------------------------------------------------------

interface TextPreset {
    fontSize: number;
    fontWeight: string;
    id: string;
    label: MessageDescriptor;
    text: MessageDescriptor;
}

const TEXT_PRESETS: TextPreset[] = [
    { fontSize: 48, fontWeight: "bold", id: "heading", label: msg`Heading`, text: msg`Heading` },
    { fontSize: 32, fontWeight: "600", id: "subheading", label: msg`Subheading`, text: msg`Subheading` },
    { fontSize: 18, fontWeight: "normal", id: "body", label: msg`Body Text`, text: msg`Body text` },
    { fontSize: 14, fontWeight: "normal", id: "caption", label: msg`Caption`, text: msg`Caption text` },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const CanvasElementPalette: FC<CanvasElementPaletteProps> = memo(({ canvas, darkMode }) => {
    const { i18n, t } = useLingui();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [imageUrl, setImageUrl] = useState("");

    const addText = useCallback(
        async (preset: TextPreset) => {
            if (!canvas) {
                return;
            }

            const { IText } = await import("fabric");

            const center = canvas.getCenterPoint();
            const obj = new IText(i18n._(preset.text), {
                fill: "#000000",
                fontFamily: "Inter, sans-serif",
                fontSize: preset.fontSize,
                fontWeight: preset.fontWeight,
                left: center.x - 80,
                top: center.y - 20,
            });

            canvas.add(obj);
            canvas.setActiveObject(obj);
            canvas.renderAll();
        },
        [canvas, i18n],
    );

    const addImageFromUrl = useCallback(
        async (url: string) => {
            if (!canvas || !url) {
                return;
            }

            const { FabricImage } = await import("fabric");
            const img = await FabricImage.fromURL(url, { crossOrigin: "anonymous" });

            const center = canvas.getCenterPoint();
            // Scale to fit within 300px while maintaining aspect ratio
            const maxDim = 300;
            const scale = Math.min(maxDim / (img.width ?? maxDim), maxDim / (img.height ?? maxDim), 1);

            img.set({
                left: center.x - ((img.width ?? 100) * scale) / 2,
                scaleX: scale,
                scaleY: scale,
                top: center.y - ((img.height ?? 100) * scale) / 2,
            });
            canvas.add(img);
            canvas.setActiveObject(img);
            canvas.renderAll();
        },
        [canvas],
    );

    const handleFileUpload = useCallback(
        (e: ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];

            if (!file || !canvas) {
                return;
            }

            e.target.value = "";

            const reader = new FileReader();

            reader.addEventListener("load", () => {
                const dataUrl = reader.result as string;

                addImageFromUrl(dataUrl);
            });
            reader.readAsDataURL(file);
        },
        [canvas, addImageFromUrl],
    );

    const handleUrlSubmit = useCallback(() => {
        if (!imageUrl.trim()) {
            return;
        }

        addImageFromUrl(imageUrl.trim());
        setImageUrl("");
    }, [imageUrl, addImageFromUrl]);

    const sectionClass = `text-xs font-medium uppercase tracking-wider mb-1.5 ${darkMode ? "text-neutral-400" : "text-neutral-500"}`;
    const itemClass = `flex items-center gap-2 rounded-md px-2 py-1.5 text-xs cursor-pointer transition-colors ${
        darkMode ? "hover:bg-white/10 text-neutral-200" : "hover:bg-neutral-100 text-neutral-700"
    }`;

    return (
        <div className={`flex w-48 flex-col gap-4 overflow-y-auto border-r p-3 ${darkMode ? "border-white/10 bg-neutral-900" : "border-neutral-200 bg-white"}`}>
            {/* Shapes */}
            <div>
                <p className={sectionClass}>{t`Shapes`}</p>
                <div className="grid grid-cols-3 gap-1">
                    {SHAPES.map((shape) => {
                        const shapeLabel = i18n._(shape.label);

                        return (
                            <button
                                aria-label={t`Add ${shapeLabel}`}
                                className={`flex flex-col items-center gap-1 rounded-md p-2 text-xs transition-colors ${
                                    darkMode ? "text-neutral-300 hover:bg-white/10" : "text-neutral-600 hover:bg-neutral-100"
                                }`}
                                key={shape.id}
                                onClick={() => canvas && shape.create(canvas)}
                                type="button"
                            >
                                <shape.icon aria-hidden="true" className="size-5" />
                                <span className="text-[10px]">{shapeLabel}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Text presets */}
            <div>
                <p className={sectionClass}>{t`Text`}</p>
                <div className="flex flex-col gap-0.5">
                    {TEXT_PRESETS.map((preset) => (
                        <button className={itemClass} key={preset.id} onClick={() => addText(preset)} type="button">
                            <TypeIcon className="size-3.5 shrink-0" />
                            <span>{i18n._(preset.label)}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Image */}
            <div>
                <p className={sectionClass}>{t`Image`}</p>
                <input accept="image/*" className="hidden" onChange={handleFileUpload} ref={fileInputRef} type="file" />
                <button className={itemClass} onClick={() => fileInputRef.current?.click()} type="button">
                    <ImageIcon className="size-3.5 shrink-0" />
                    <span>{t`Upload Image`}</span>
                </button>
                <div className="mt-1.5 flex gap-1">
                    <input
                        aria-label={t`Image URL`}
                        className="bg-muted text-foreground w-full rounded border px-1.5 py-1 text-xs"
                        onChange={(e) => setImageUrl(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
                        placeholder={t`Paste image URL`}
                        type="text"
                        value={imageUrl}
                    />
                </div>
            </div>
        </div>
    );
});

CanvasElementPalette.displayName = "CanvasElementPalette";
export default CanvasElementPalette;
