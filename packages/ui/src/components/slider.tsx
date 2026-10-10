"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import cn from "@ui/utils/cn";
import * as React from "react";

export interface SliderProps extends Omit<SliderPrimitive.Root.Props, "onValueChange" | "onValueCommitted"> {
    /**
     * Simplified callback that fires when the slider value changes.
     * For the full event details, use onValueChangeWithDetails instead.
     */
    onValueChange?: (value: number | ReadonlyArray<number>) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onValueChangeWithDetails?: SliderPrimitive.Root.Props["onValueChange"];

    /**
     * Simplified callback that fires when the slider value is committed (on pointerup).
     * For the full event details, use onValueCommittedWithDetails instead.
     */
    onValueCommitted?: (value: number | ReadonlyArray<number>) => void;

    /**
     * Full callback matching Base UI's signature with event details.
     */
    onValueCommittedWithDetails?: SliderPrimitive.Root.Props["onValueCommitted"];
}

const Slider = ({
    className,
    defaultValue,
    max = 100,
    min = 0,
    onValueChange,
    onValueChangeWithDetails,
    onValueCommitted,
    onValueCommittedWithDetails,
    value,
    ...props
}: SliderProps) => {
    const handleValueChange: SliderPrimitive.Root.Props["onValueChange"] = (newValue, eventDetails) => {
        onValueChange?.(newValue);
        onValueChangeWithDetails?.(newValue, eventDetails);
    };

    const handleValueCommitted: SliderPrimitive.Root.Props["onValueCommitted"] = (newValue, eventDetails) => {
        onValueCommitted?.(newValue);
        onValueCommittedWithDetails?.(newValue, eventDetails);
    };
    const thumbValues = React.useMemo(() => {
        if (Array.isArray(value)) {
            return value;
        }

        return Array.isArray(defaultValue) ? defaultValue : [min, max];
    }, [value, defaultValue, min, max]);

    return (
        <SliderPrimitive.Root
            className="data-horizontal:w-full data-vertical:h-full"
            data-slot="slider"
            defaultValue={defaultValue}
            max={max}
            min={min}
            onValueChange={handleValueChange}
            onValueCommitted={handleValueCommitted}
            thumbAlignment="edge"
            value={value}
            {...props}
        >
            <SliderPrimitive.Control
                className={cn(
                    "relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
                    className,
                )}
            >
                <SliderPrimitive.Track
                    className="bg-muted relative overflow-hidden rounded-md select-none data-horizontal:h-3 data-horizontal:w-full data-vertical:h-full data-vertical:w-3"
                    data-slot="slider-track"
                >
                    <SliderPrimitive.Indicator className="bg-primary select-none data-horizontal:h-full data-vertical:w-full" data-slot="slider-range" />
                </SliderPrimitive.Track>
                {Array.from({ length: thumbValues.length }, (_, index) => (
                    <SliderPrimitive.Thumb
                        className="border-primary ring-ring/30 block size-4 shrink-0 rounded-md border bg-white shadow-sm transition-colors select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
                        data-slot="slider-thumb"
                        key={index}
                    />
                ))}
            </SliderPrimitive.Control>
        </SliderPrimitive.Root>
    );
};

export { Slider };
