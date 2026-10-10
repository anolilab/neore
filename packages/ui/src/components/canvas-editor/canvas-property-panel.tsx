/**
 * CanvasPropertyPanel — Shows editable properties of the selected Fabric.js object.
 * Position, size, rotation, opacity, fill, stroke, and text-specific properties.
 */

"use client";

import { useLingui } from "@lingui/react/macro";
import type { Canvas, FabricObject } from "fabric";
import type { FC } from "react";
import { memo, useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ObjectProperties {
    angle: number;
    fill: string;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: string;
    height: number;
    left: number;
    opacity: number;
    // Circle-specific
    radius?: number;
    // Rect-specific
    rx?: number;
    ry?: number;
    stroke: string;
    strokeWidth: number;
    // Text-specific
    text?: string;
    textAlign?: string;
    top: number;
    type: string;
    width: number;
}

interface CanvasPropertyPanelProps {
    canvas: Canvas | null;
    darkMode?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getObjectProperties = (obj: FabricObject): ObjectProperties => {
    const bounds = obj.getBoundingRect();

    return {
        angle: Math.round(obj.angle ?? 0),
        fill: typeof obj.fill === "string" ? obj.fill : "#000000",
        fontFamily: (obj as any).fontFamily,
        fontSize: (obj as any).fontSize,
        fontWeight: (obj as any).fontWeight,
        height: Math.round(bounds.height),
        left: Math.round(obj.left ?? 0),
        opacity: obj.opacity ?? 1,
        // Circle
        radius: (obj as any).radius,
        // Rect
        rx: (obj as any).rx,
        ry: (obj as any).ry,
        stroke: typeof obj.stroke === "string" ? obj.stroke : "",
        strokeWidth: obj.strokeWidth ?? 0,
        // Text
        text: (obj as any).text,
        textAlign: (obj as any).textAlign,
        top: Math.round(obj.top ?? 0),
        type: obj.type ?? "object",
        width: Math.round(bounds.width),
    };
};

const TEXT_OBJECT_TYPES = new Set(["IText", "Text", "Textbox"]);

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PropertyRow: FC<{
    children: React.ReactNode;
    label: string;
}> = ({ children, label }) => (
    <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
        <div className="flex items-center gap-1">{children}</div>
    </div>
);

const PropertyInput: FC<{
    "aria-label": string;
    className?: string;
    max?: number;
    min?: number;
    onChange: (value: string) => void;
    step?: number;
    type?: "text" | "number" | "color";
    value: string | number;
}> = ({ "aria-label": ariaLabel, className, max, min, onChange, step, type = "text", value }) => (
    <input
        aria-label={ariaLabel}
        className={`bg-muted text-foreground rounded border px-1.5 py-0.5 text-xs ${type === "color" ? "h-6 w-8 cursor-pointer p-0" : "w-16"} ${className ?? ""}`}
        max={max}
        min={min}
        onChange={(e) => onChange(e.target.value)}
        step={step}
        type={type}
        value={value}
    />
);

const PropertySelect: FC<{
    "aria-label": string;
    onChange: (value: string) => void;
    options: { label: string; value: string }[];
    value: string;
}> = ({ "aria-label": ariaLabel, onChange, options, value }) => (
    <select
        aria-label={ariaLabel}
        className="bg-muted text-foreground w-20 rounded border px-1 py-0.5 text-xs"
        onChange={(e) => onChange(e.target.value)}
        value={value}
    >
        {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
                {opt.label}
            </option>
        ))}
    </select>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const CanvasPropertyPanel: FC<CanvasPropertyPanelProps> = memo(({ canvas, darkMode }) => {
    const { t } = useLingui();
    const [selected, setSelected] = useState<FabricObject | null>(null);
    const [props, setProps] = useState<ObjectProperties | null>(null);

    // Listen for selection changes
    useEffect(() => {
        if (!canvas) {
            return undefined;
        }

        const onSelect = () => {
            const active = canvas.getActiveObject();

            if (active) {
                setSelected(active);
                setProps(getObjectProperties(active));
            } else {
                setSelected(null);
                setProps(null);
            }
        };

        const onDeselect = () => {
            setSelected(null);
            setProps(null);
        };

        const onModified = () => {
            const active = canvas.getActiveObject();

            if (active) {
                setProps(getObjectProperties(active));
            }
        };

        canvas.on("selection:created", onSelect);
        canvas.on("selection:updated", onSelect);
        canvas.on("selection:cleared", onDeselect);
        canvas.on("object:modified", onModified);
        canvas.on("object:scaling", onModified);
        canvas.on("object:moving", onModified);
        canvas.on("object:rotating", onModified);

        return () => {
            canvas.off("selection:created", onSelect);
            canvas.off("selection:updated", onSelect);
            canvas.off("selection:cleared", onDeselect);
            canvas.off("object:modified", onModified);
            canvas.off("object:scaling", onModified);
            canvas.off("object:moving", onModified);
            canvas.off("object:rotating", onModified);
        };
    }, [canvas]);

    const updateProperty = useCallback(
        (key: string, value: unknown) => {
            if (!selected || !canvas) {
                return;
            }

            (selected as any).set(key, value);
            canvas.renderAll();
            canvas.fire("object:modified", { target: selected } as any);
            setProps(getObjectProperties(selected));
        },
        [selected, canvas],
    );

    if (!props || !selected) {
        return (
            <div
                className={`flex w-56 flex-col border-l p-3 ${darkMode ? "border-white/10 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-900"}`}
            >
                <p className="text-muted-foreground text-center text-xs">{t`Select an object to edit its properties`}</p>
            </div>
        );
    }

    const isText = TEXT_OBJECT_TYPES.has(props.type);
    const isCircle = props.type === "Circle";
    const isRect = props.type === "Rect";

    return (
        <div
            className={`flex w-56 flex-col gap-3 overflow-y-auto border-l p-3 ${darkMode ? "border-white/10 bg-neutral-900 text-white" : "border-neutral-200 bg-white text-neutral-900"}`}
        >
            {/* Object type label */}
            <div className="border-b pb-2">
                <span className="text-xs font-medium tracking-wider uppercase">{props.type}</span>
            </div>

            {/* Position */}
            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">{t`Position`}</span>
                <PropertyRow label="X">
                    <PropertyInput aria-label={t`X position`} onChange={(v) => updateProperty("left", Number(v))} type="number" value={props.left} />
                </PropertyRow>
                <PropertyRow label="Y">
                    <PropertyInput aria-label={t`Y position`} onChange={(v) => updateProperty("top", Number(v))} type="number" value={props.top} />
                </PropertyRow>
            </div>

            {/* Size */}
            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">{t`Size`}</span>
                {isCircle ? (
                    <PropertyRow label={t`Radius`}>
                        <PropertyInput
                            aria-label={t`Radius`}
                            min={1}
                            onChange={(v) => updateProperty("radius", Number(v))}
                            type="number"
                            value={props.radius ?? 50}
                        />
                    </PropertyRow>
                ) : (
                    <>
                        <PropertyRow label={t({ context: "width abbreviation", message: "W" })}>
                            <PropertyInput
                                aria-label={t`Width`}
                                min={1}
                                onChange={(v) => {
                                    const scale = Number(v) / (selected.width ?? 1);

                                    updateProperty("scaleX", scale);
                                }}
                                type="number"
                                value={props.width}
                            />
                        </PropertyRow>
                        <PropertyRow label={t({ context: "height abbreviation", message: "H" })}>
                            <PropertyInput
                                aria-label={t`Height`}
                                min={1}
                                onChange={(v) => {
                                    const scale = Number(v) / (selected.height ?? 1);

                                    updateProperty("scaleY", scale);
                                }}
                                type="number"
                                value={props.height}
                            />
                        </PropertyRow>
                    </>
                )}
            </div>

            {/* Transform */}
            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">{t`Transform`}</span>
                <PropertyRow label={t`Angle`}>
                    <PropertyInput
                        aria-label={t`Rotation angle`}
                        max={360}
                        min={0}
                        onChange={(v) => updateProperty("angle", Number(v))}
                        type="number"
                        value={props.angle}
                    />
                </PropertyRow>
                <PropertyRow label={t`Opacity`}>
                    <PropertyInput
                        aria-label={t`Opacity`}
                        max={1}
                        min={0}
                        onChange={(v) => updateProperty("opacity", Number(v))}
                        step={0.05}
                        type="number"
                        value={props.opacity}
                    />
                </PropertyRow>
            </div>

            {/* Appearance */}
            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">{t`Appearance`}</span>
                <PropertyRow label={t`Fill`}>
                    <PropertyInput aria-label={t`Fill color`} onChange={(v) => updateProperty("fill", v)} type="color" value={props.fill} />
                </PropertyRow>
                <PropertyRow label={t`Stroke`}>
                    <PropertyInput aria-label={t`Stroke color`} onChange={(v) => updateProperty("stroke", v)} type="color" value={props.stroke || "#000000"} />
                </PropertyRow>
                <PropertyRow label={t`Width`}>
                    <PropertyInput
                        aria-label={t`Stroke width`}
                        min={0}
                        onChange={(v) => updateProperty("strokeWidth", Number(v))}
                        type="number"
                        value={props.strokeWidth}
                    />
                </PropertyRow>
                {isRect && (
                    <PropertyRow label={t`Radius`}>
                        <PropertyInput
                            aria-label={t`Corner radius`}
                            min={0}
                            onChange={(v) => {
                                updateProperty("rx", Number(v));
                                updateProperty("ry", Number(v));
                            }}
                            type="number"
                            value={props.rx ?? 0}
                        />
                    </PropertyRow>
                )}
            </div>

            {/* Text properties */}
            {isText && (
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium">{t`Text`}</span>
                    <PropertyRow label={t`Size`}>
                        <PropertyInput
                            aria-label={t`Font size`}
                            min={6}
                            onChange={(v) => updateProperty("fontSize", Number(v))}
                            type="number"
                            value={props.fontSize ?? 24}
                        />
                    </PropertyRow>
                    <PropertyRow label={t`Font`}>
                        <PropertySelect
                            aria-label={t`Font family`}
                            onChange={(v) => updateProperty("fontFamily", v)}
                            options={[
                                { label: "Inter", value: "Inter, sans-serif" },
                                { label: "Arial", value: "Arial, sans-serif" },
                                { label: "Georgia", value: "Georgia, serif" },
                                { label: "Courier", value: "Courier New, monospace" },
                                { label: "Times", value: "Times New Roman, serif" },
                                { label: "Verdana", value: "Verdana, sans-serif" },
                            ]}
                            value={props.fontFamily ?? "Inter, sans-serif"}
                        />
                    </PropertyRow>
                    <PropertyRow label={t`Weight`}>
                        <PropertySelect
                            aria-label={t`Font weight`}
                            onChange={(v) => updateProperty("fontWeight", v)}
                            options={[
                                { label: t`Normal`, value: "normal" },
                                { label: t`Bold`, value: "bold" },
                                { label: t`Thin`, value: "100" },
                                { label: t`Light`, value: "300" },
                                { label: t`Medium`, value: "500" },
                                { label: t`Bold`, value: "700" },
                                { label: t`Black`, value: "900" },
                            ]}
                            value={props.fontWeight ?? "normal"}
                        />
                    </PropertyRow>
                    <PropertyRow label={t`Align`}>
                        <PropertySelect
                            aria-label={t`Text alignment`}
                            onChange={(v) => updateProperty("textAlign", v)}
                            options={[
                                { label: t`Left`, value: "left" },
                                { label: t`Center`, value: "center" },
                                { label: t`Right`, value: "right" },
                            ]}
                            value={props.textAlign ?? "left"}
                        />
                    </PropertyRow>
                </div>
            )}
        </div>
    );
});

CanvasPropertyPanel.displayName = "CanvasPropertyPanel";
export default CanvasPropertyPanel;
