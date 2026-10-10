"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@ui/components/badge";
import type { badgeVariants } from "@ui/components/badge-variants";
import { Button } from "@ui/components/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import { Separator } from "@ui/components/separator";
import cn from "@ui/utils/cn";
import type { HexColor, HslaColor, HsvaColor, RgbaColor } from "@uiw/color-convert";
import { hexToHsva, hslaToHsva, hsvaToHex, hsvaToHsla, hsvaToHslString, hsvaToRgba, rgbaToHsva } from "@uiw/color-convert";
import Hue from "@uiw/react-color-hue";
import Saturation from "@uiw/react-color-saturation";
import type { VariantProps } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import React from "react";

const getColorAsHsva = (color: `#${string}` | HsvaColor | HslaColor | RgbaColor): HsvaColor => {
    if (typeof color === "string") {
        return hexToHsva(color);
    }

    if ("h" in color && "s" in color && "v" in color) {
        return color;
    }

    if ("r" in color) {
        return rgbaToHsva(color);
    }

    return hslaToHsva(color);
};

type ColorPickerValue = {
    hex: string;
    hsl: HslaColor;
    rgb: RgbaColor;
};

type ColorPickerProps = {
    children: React.ReactElement;
    className?: string;
    hideContrastRatio?: boolean;
    hideDefaultSwatches?: boolean;
    onValueChange?: (value: ColorPickerValue) => void;
    swatches?: HexColor[];
    type?: "hsl" | "rgb" | "hex";
    value?: `#${string}` | HsvaColor | HslaColor | RgbaColor;
};

const EMPTY_SWATCHES: HexColor[] = [];

const ColorPicker = ({
    children,
    className,
    hideContrastRatio,
    hideDefaultSwatches,
    onValueChange,
    swatches = EMPTY_SWATCHES,
    type = "hsl",
    value,
}: ColorPickerProps) => {
    const { t } = useLingui();
    const [colorType, setColorType] = React.useState(type);
    const [colorHsv, setColorHsv] = React.useState<HsvaColor>(value ? getColorAsHsva(value) : { a: 1, h: 0, s: 0, v: 0 });

    const [previousValue, setPreviousValue] = React.useState(value);

    // Adjusted during render rather than in an effect: the swatch never paints
    // one frame of the previous colour.
    if (value !== previousValue) {
        setPreviousValue(value);

        if (value) {
            setColorHsv(getColorAsHsva(value));
        }
    }

    const handleValueChange = (color: HsvaColor) => {
        setColorHsv(color);
        onValueChange?.({
            hex: hsvaToHex(color),
            hsl: hsvaToHsla(color),
            rgb: hsvaToRgba(color),
        });
    };

    return (
        <Popover>
            <PopoverTrigger render={children} />
            <PopoverContent
                className={cn("w-[350px] p-0", className)}
                style={
                    {
                        "--selected-color": hsvaToHslString(colorHsv),
                    } as React.CSSProperties
                }
            >
                <div className="space-y-2 p-4">
                    <Saturation
                        className="border-border border"
                        hsva={colorHsv}
                        onChange={(newColor: HsvaColor) => {
                            handleValueChange(newColor);
                        }}
                        style={{
                            aspectRatio: "4/2",
                            borderRadius: "0.3rem",
                            height: "auto",
                            width: "100%",
                        }}
                    />
                    <Hue
                        className="[&>div:first-child]:overflow-hidden [&>div:first-child]:!rounded"
                        hue={colorHsv.h}
                        onChange={(newHue: { h: number }) => {
                            handleValueChange({ ...colorHsv, ...newHue });
                        }}
                        style={
                            {
                                "--alpha-pointer-background-color": "hsl(var(--foreground))",
                                borderRadius: "0.3rem",
                                height: "0.9rem",
                                width: "100%",
                            } as React.CSSProperties
                        }
                    />

                    <div className="flex items-center gap-2">
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={
                                    <Button className="shrink-0 justify-between uppercase" variant="outline">
                                        {colorType}
                                        <ChevronDownIcon aria-hidden="true" className="ms-2 -me-1 opacity-60" size={16} strokeWidth={2} />
                                    </Button>
                                }
                            />
                            <DropdownMenuContent>
                                <DropdownMenuCheckboxItem checked={colorType === "hex"} onCheckedChange={() => setColorType("hex")}>
                                    HEX
                                </DropdownMenuCheckboxItem>
                                <DropdownMenuCheckboxItem checked={colorType === "hsl"} onCheckedChange={() => setColorType("hsl")}>
                                    HSL
                                </DropdownMenuCheckboxItem>
                                <DropdownMenuCheckboxItem checked={colorType === "rgb"} onCheckedChange={() => setColorType("rgb")}>
                                    RGB
                                </DropdownMenuCheckboxItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <div className="flex grow">
                            {colorType === "hsl" && (
                                <ObjectColorInput
                                    label="hsl"
                                    onValueChange={(hslaValue) => {
                                        handleValueChange(hslaToHsva(hslaValue));
                                    }}
                                    value={hsvaToHsla(colorHsv)}
                                />
                            )}
                            {colorType === "rgb" && (
                                <ObjectColorInput
                                    label="rgb"
                                    onValueChange={(rgbaValue) => {
                                        handleValueChange(rgbaToHsva(rgbaValue));
                                    }}
                                    value={hsvaToRgba(colorHsv)}
                                />
                            )}
                            {colorType === "hex" && (
                                <Input
                                    className="flex"
                                    onChange={(e) => {
                                        try {
                                            handleValueChange(hexToHsva(e.target.value));
                                        } catch {
                                            // Invalid hex color, ignore
                                        }
                                    }}
                                    value={hsvaToHex(colorHsv)}
                                />
                            )}
                        </div>
                    </div>
                    {(swatches.length > 0 || !hideDefaultSwatches) && <Separator />}
                    {!hideDefaultSwatches && (
                        <div className="flex flex-wrap justify-start gap-2">
                            {["#F8371A", "#F97C1B", "#FAC81C", "#3FD0B6", "#2CADF6", "#6462FC", ...swatches]
                                .toSorted((a, b) => hexToHsva(a).h - hexToHsva(b).h)
                                .map((color) => (
                                    <button
                                        aria-label={t`Set color to ${color}`}
                                        className="ring-offset-background size-5 cursor-pointer rounded bg-[var(--swatch-color)] ring-2 ring-[var(--swatch-color)00] ring-offset-1 transition-all duration-100 hover:ring-[var(--swatch-color)]"
                                        key={`${color}-swatch`}
                                        onClick={() => handleValueChange(hexToHsva(color))}
                                        onKeyUp={(e) => (e.key === "Enter" ? handleValueChange(hexToHsva(color)) : null)}
                                        style={
                                            {
                                                "--swatch-color": color,
                                            } as React.CSSProperties
                                        }
                                        type="button"
                                    />
                                ))}
                        </div>
                    )}
                    {!hideContrastRatio && (
                        <>
                            <Separator />
                            <ContrastRatio color={colorHsv} />
                        </>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
};

type ContrastRatioProps = {
    color: HsvaColor;
};

const ValidationBadge = ({
    children,
    className,
    ratio,
    ratioLimit,
    ...props
}: Omit<VariantProps<typeof badgeVariants>, "variant"> &
    React.ComponentProps<typeof Badge> & {
        ratio: number;
        ratioLimit: number;
    }) => (
    <Badge
        className={cn(
            "text-muted-foreground gap-2 rounded-full",
            ratio > ratioLimit && "border-transparent bg-emerald-500/20 text-emerald-700 dark:text-emerald-400",
            className,
        )}
        variant="outline"
        {...props}
    >
        {ratio > 4.5 ? <CheckIcon size={16} /> : <XIcon size={16} />}
        {children}
    </Badge>
);

const ContrastRatio = ({ color }: ContrastRatioProps) => {
    const { t } = useLingui();
    // Both ratios are a pure function of `color`, so they are computed rather
    // than mirrored into state by an effect.
    const { darkModeContrastRatio, lightModeContrastValue } = React.useMemo(() => {
        const rgb = hsvaToRgba(color);

        const toSRGB = (c: number) => {
            const channel = c / 255;

            return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        };

        const r = toSRGB(rgb.r);
        const g = toSRGB(rgb.g);
        const b = toSRGB(rgb.b);

        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        const darkModeRatio = (1 + 0.05) / (luminance + 0.05);
        const lightModeRatio = (luminance + 0.05) / 0.05;

        return {
            darkModeContrastRatio: Number(darkModeRatio.toFixed(2)),
            lightModeContrastValue: Number(lightModeRatio.toFixed(2)),
        };
    }, [color]);

    return (
        <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
                <div className="flex size-10 items-center justify-center rounded bg-[var(--selected-color)]">
                    <span className="font-medium text-black dark:text-white">A</span>
                </div>
                <div className="flex flex-col justify-between">
                    <span className="text-muted-foreground text-xs text-nowrap whitespace-nowrap">{t`Contrast Ratio`}</span>
                    <span className="hidden text-sm dark:flex">{darkModeContrastRatio}</span>
                    <span className="text-sm dark:hidden">{lightModeContrastValue}</span>
                </div>
            </div>
            <div className="flex items-center justify-end gap-1">
                <ValidationBadge className="dark:hidden" ratio={lightModeContrastValue} ratioLimit={4.5}>
                    AA
                </ValidationBadge>
                <ValidationBadge className="dark:hidden" ratio={lightModeContrastValue} ratioLimit={7}>
                    AAA
                </ValidationBadge>
                <ValidationBadge className="hidden dark:flex" ratio={darkModeContrastRatio} ratioLimit={4.5}>
                    AA
                </ValidationBadge>
                <ValidationBadge className="hidden dark:flex" ratio={darkModeContrastRatio} ratioLimit={7}>
                    AAA
                </ValidationBadge>
            </div>
        </div>
    );
};

type ObjectColorInputProps =
    | {
          label: "hsl";
          onValueChange?: (value: HslaColor) => void;
          value: HslaColor;
      }
    | {
          label: "rgb";
          onValueChange?: (value: RgbaColor) => void;
          value: RgbaColor;
      };

const ObjectColorInput = ({ label, onValueChange, value }: ObjectColorInputProps) => {
    const handleChange = (value_: HslaColor | RgbaColor) => {
        // The union's two call signatures differ only in their parameter type and
        // both receive the same merged object, so the branch on `label` only ever
        // existed to satisfy the narrowing.
        const notify = onValueChange as ((next: HslaColor | RgbaColor) => void) | undefined;

        notify?.({ ...value, ...value_ });
    };

    return (
        <div className="-mt-px flex">
            <div className="relative min-w-0 flex-1 focus-within:z-10">
                <Input
                    className="peer rounded-e-none shadow-none [direction:inherit]"
                    onChange={(e) =>
                        handleChange({
                            ...value,
                            [label === "hsl" ? "h" : "r"]: Number(e.target.value) || 0,
                        })
                    }
                    value={label === "hsl" ? value.h.toFixed(0) : value.r}
                />
            </div>
            <div className="relative -ms-px min-w-0 flex-1 focus-within:z-10">
                <Input
                    className="peer rounded-none shadow-none [direction:inherit]"
                    onChange={(e) =>
                        handleChange({
                            ...value,
                            [label === "hsl" ? "s" : "g"]: Number(e.target.value) || 0,
                        })
                    }
                    value={label === "hsl" ? value.s.toFixed(0) : value.g}
                />
            </div>
            <div className="relative -ms-px min-w-0 flex-1 focus-within:z-10">
                <Input
                    className="peer rounded-s-none shadow-none [direction:inherit]"
                    onChange={(e) =>
                        handleChange({
                            ...value,
                            [label === "hsl" ? "l" : "b"]: Number(e.target.value) || 0,
                        })
                    }
                    value={label === "hsl" ? value.l.toFixed(0) : value.b}
                />
            </div>
        </div>
    );
};

export { ColorPicker };
export type { ColorPickerProps, ColorPickerValue };
