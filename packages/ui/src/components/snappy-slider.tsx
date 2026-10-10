import * as React from "react";

import { useComposedRefs } from "../lib/compose-refs";
import cn from "../utils/cn";

interface CustomSliderProps {
    className?: string;
    config?: {
        labelFormatter?: (value: number) => string;
        snappingThreshold?: number;
    };
    defaultValue: number;
    label: string;
    max?: number;
    min?: number;
    onChange: (value: number) => void;
    prefix?: string;
    ref?: React.Ref<HTMLDivElement>;
    resetKey?: number;
    snapping?: boolean;
    step?: number;
    suffix?: string;
    value?: number;
    values: number[];
}

const formatNumber = (value: number, step = 1): string => {
    // Attempt to convert to number if it isn't already
    const numberValue = value;

    // Throw error if conversion results in NaN
    if (Number.isNaN(numberValue)) {
        throw new TypeError(`Invalid number value: ${value}`);
    }

    const decimalPlaces = step.toString().split(".", 2)[1]?.length || 0;

    if (decimalPlaces === 0 && Number.isSafeInteger(numberValue)) {
        return numberValue.toString();
    }

    return numberValue.toFixed(decimalPlaces);
};

/**
 * SnappySlider is a highly interactive range input component that combines precise value control
 * with intuitive visual feedback. It features:
 *
 * - Snap-to points for accurate value selection
 * - Visual markers for predefined values
 * - Direct numeric input with keyboard controls
 * - Touch and mouse drag support
 * - Customizable step sizes and ranges
 * - Out-of-bounds value indication
 * - Double-click to reset functionality
 * - Prefix/suffix label support.
 */
const getSliderValueLabel = (params: { computedStep: number; currentValue: number; isOutOfBounds: boolean; sliderMax: number; sliderMin: number }): string => {
    const { computedStep, currentValue, isOutOfBounds, sliderMax, sliderMin } = params;

    if (!isOutOfBounds) {
        return formatNumber(currentValue, computedStep);
    }

    return currentValue < sliderMin ? `<${formatNumber(sliderMin, computedStep)}` : `>${formatNumber(sliderMax, computedStep)}`;
};

const EMPTY_SLIDER_CONFIG: NonNullable<CustomSliderProps["config"]> = {};

const SnappySlider = ({
    className,
    config = EMPTY_SLIDER_CONFIG,
    defaultValue,
    label,
    max: providedMax,
    min: providedMin,
    onChange,
    prefix,
    ref: _ref,
    resetKey: _resetKey,
    snapping = true,
    step,
    suffix,
    value,
    values,
    ...props
}: CustomSliderProps) => {
    const sliderRef = React.useRef<HTMLDivElement>(null);
    const { snappingThreshold = 1 } = config;

    const defaultValueArray = [...values, defaultValue].toSorted((a, b) => a - b);

    // Calculate input bounds using defaultValueArray
    const inputMin = providedMin ?? Math.min(...defaultValueArray);
    const inputMax = providedMax ?? Math.max(...defaultValueArray);

    // Filter values to only those within input range (if min/max provided)
    const sliderValues =
        providedMin !== undefined && providedMax !== undefined ? defaultValueArray.filter((v) => v >= providedMin && v <= providedMax) : defaultValueArray;

    // Calculate slider visual bounds from filtered values
    const sliderMin = Math.min(...sliderValues);
    const sliderMax = Math.max(...sliderValues);

    const computedStep = step ?? (label.includes("Duration") ? 1 : 0.1);

    // Track both controlled and internal state
    const [internalValue, setInternalValue] = React.useState(defaultValue);
    const currentValue = value ?? internalValue;

    // Update input display value
    const [inputValue, setInputValue] = React.useState(formatNumber(currentValue, computedStep));

    // Check if value is outside slider bounds
    const isOutOfBounds = currentValue < sliderMin || currentValue > sliderMax;

    // Calculate percentage for slider position (clamped to slider range)
    const sliderPercentage = ((Math.min(Math.max(currentValue, sliderMin), sliderMax) - sliderMin) / (sliderMax - sliderMin)) * 100;

    const [previousValue, setPreviousValue] = React.useState(value);

    // Update internal state when the controlled value changes. Done during render
    // rather than in an effect, so the thumb never paints the previous position.
    if (value !== previousValue) {
        setPreviousValue(value);

        if (value !== undefined) {
            setInternalValue(value);
            setInputValue(formatNumber(value, computedStep));
        }
    }

    const handleValueChange = React.useCallback(
        (newValue: number) => {
            setInternalValue(newValue);
            setInputValue(formatNumber(newValue, computedStep));
            onChange(newValue);
        },
        [computedStep, onChange],
    );

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setInputValue(e.target.value);
    };

    const handleInputBlur = () => {
        const newValue = Number(inputValue);

        if (Number.isNaN(newValue)) {
            setInputValue(formatNumber(currentValue, computedStep));
        } else {
            // Clamp to input range (which might be wider than slider range)
            const clampedValue = Math.max(inputMin, Math.min(inputMax, newValue));
            const steppedValue = Math.round(clampedValue / computedStep) * computedStep;

            setInputValue(formatNumber(steppedValue, computedStep));
            handleValueChange(steppedValue);
        }
    };

    // Update slider interaction logic
    const handleInteraction = React.useCallback(
        (clientX: number) => {
            const slider = sliderRef.current;

            if (!slider) {
                return;
            }

            const rect = slider.getBoundingClientRect();
            const percentage = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const rawValue = percentage * (sliderMax - sliderMin) + sliderMin;

            if (snapping) {
                // Use defaultValueArray for snap points instead of values
                const snapPoints = [...new Set([...defaultValueArray, currentValue])].toSorted((a, b) => a - b);
                const closestValue = snapPoints.reduce((prev, current) => (Math.abs(current - rawValue) < Math.abs(prev - rawValue) ? current : prev));

                if (Math.abs(closestValue - rawValue) <= snappingThreshold) {
                    handleValueChange(closestValue);

                    return;
                }
            }

            const steppedValue = Math.round(rawValue / computedStep) * computedStep;
            const clampedValue = Math.max(sliderMin, Math.min(sliderMax, steppedValue));

            handleValueChange(clampedValue);
        },
        [sliderMin, sliderMax, defaultValueArray, currentValue, computedStep, snapping, snappingThreshold, handleValueChange],
    );

    React.useEffect(() => {
        const slider = sliderRef.current;

        if (!slider) {
            return undefined;
        }

        const handleMouseMove = (moveEvent: MouseEvent) => {
            handleInteraction(moveEvent.clientX);
        };

        const handleMouseUp = () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            // Restore text selection when done dragging
            document.body.style.userSelect = "";
        };

        const handleTouchMove = (moveEvent: TouchEvent) => {
            handleInteraction(moveEvent.touches[0]?.clientX ?? 0);
        };

        const handleTouchEnd = () => {
            document.removeEventListener("touchmove", handleTouchMove);
            document.removeEventListener("touchend", handleTouchEnd);
        };

        const handleMouseDown = (e: MouseEvent) => {
            // Prevent text selection while dragging
            e.preventDefault();
            handleInteraction(e.clientX);

            // Add selection prevention to document during drag
            document.body.style.userSelect = "none";

            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
        };

        const handleTouchStart = (e: TouchEvent) => {
            e.preventDefault();
            handleInteraction(e.touches[0]?.clientX ?? 0);

            document.addEventListener("touchmove", handleTouchMove, { passive: false });
            document.addEventListener("touchend", handleTouchEnd, { passive: true });
        };

        slider.addEventListener("mousedown", handleMouseDown);
        slider.addEventListener("touchstart", handleTouchStart, { passive: false });

        return () => {
            slider.removeEventListener("mousedown", handleMouseDown);
            slider.removeEventListener("touchstart", handleTouchStart);
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.removeEventListener("touchmove", handleTouchMove);
            document.removeEventListener("touchend", handleTouchEnd);
            // Ensure we clean up the user-select style if component unmounts during drag
            document.body.style.userSelect = "";
        };
    }, [sliderMin, sliderMax, onChange, values, defaultValue, label, computedStep, snapping, snappingThreshold, handleInteraction]);

    React.useEffect(() => {
        const slider = sliderRef.current;

        if (!slider) {
            return undefined;
        }

        const handleDoubleClick = () => {
            onChange(defaultValue);
        };

        slider.addEventListener("dblclick", handleDoubleClick);

        return () => slider.removeEventListener("dblclick", handleDoubleClick);
    }, [onChange, defaultValue]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!(e.key === "ArrowUp" || e.key === "ArrowDown")) {
            return;
        }

        e.preventDefault();
        const parsedInputValue = Number(inputValue);

        if (Number.isNaN(parsedInputValue)) {
            return;
        }

        const newValue = parsedInputValue + (e.key === "ArrowUp" ? computedStep : -computedStep);
        const clampedValue = Math.max(sliderMin, Math.min(sliderMax, newValue));

        // Update both the input value and trigger the onChange
        setInputValue(formatNumber(clampedValue, computedStep));
        onChange(clampedValue);
    };

    // `sliderValues` may legitimately repeat a value, so the position in the list
    // is part of each mark's key.
    const marks = sliderValues.map((mark, index) => {
        return { key: `${mark}-${index}`, mark };
    });

    return (
        <div
            className={cn(
                "[--mark-slider-gap:0.25rem] [--mark-slider-height:0.5rem] [--mark-slider-marker-width:1px] [--mark-slider-track-height:0.375rem]",
                "flex flex-col gap-[var(--mark-slider-gap)] pb-7",
                className,
            )}
            {...props}
        >
            <SnappySliderHeader>
                <SnappySliderLabel>{label}</SnappySliderLabel>
                <SnappySliderValue
                    className={cn(isOutOfBounds && "opacity-75")}
                    onBlur={handleInputBlur}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    prefix={prefix}
                    suffix={suffix}
                    value={inputValue}
                />
            </SnappySliderHeader>
            <div className="relative h-[var(--mark-slider-height)]">
                <div className="absolute inset-0" ref={sliderRef}>
                    <div className="bg-primary/10 absolute top-1/2 h-[var(--mark-slider-track-height)] w-full -translate-y-1/2 overflow-hidden rounded-sm">
                        {/* Progress overlay */}
                        <div className={cn("bg-primary absolute top-0 z-[1] h-full")} style={{ width: `${sliderPercentage}%` }} />

                        {/* Regular marks */}
                        {marks.map(({ key, mark }) => {
                            if (mark === 0) {
                                return null;
                            }

                            const markPercentage = ((mark - sliderMin) / (sliderMax - sliderMin)) * 100;

                            if (markPercentage < 0 || markPercentage > 100) {
                                return null;
                            }

                            return (
                                <div
                                    className={cn(
                                        "absolute top-0 z-[2] h-full w-[var(--mark-slider-marker-width)] -translate-x-[calc(var(--mark-slider-marker-width)/2)]",
                                        "bg-white/90 dark:bg-black/90",
                                    )}
                                    key={key}
                                    style={{ left: `${markPercentage}%` }}
                                />
                            );
                        })}
                    </div>

                    {/* Zero marker */}
                    {sliderValues.includes(0) && (
                        <div className="absolute top-1/2 z-20 -translate-y-1/2" style={{ left: `${((0 - sliderMin) / (sliderMax - sliderMin)) * 100}%` }}>
                            <div className="h-3 w-[var(--mark-slider-marker-width)] -translate-x-[calc(var(--mark-slider-marker-width)/2)] bg-red-600" />
                        </div>
                    )}

                    {/* Thumb */}
                    <div
                        className={cn(
                            "absolute top-1/2 z-30 -translate-x-1/2 -translate-y-[35%] cursor-grab active:cursor-grabbing",
                            isOutOfBounds && "opacity-75",
                        )}
                        style={{ left: `${sliderPercentage}%` }}
                    >
                        {/* Triangle */}
                        <div className={cn("border-b-primary mt-2 h-0 w-0 border-[5px] border-transparent", isOutOfBounds && "border-b-primary/20")} />
                        {/* Square */}
                        <div className={cn("h-[10px] w-[10px]", isOutOfBounds ? "bg-primary/20" : "bg-primary")} />
                        {/* Text */}
                        <div className="absolute top-[22px] left-1/2 -translate-x-1/2 whitespace-nowrap">
                            <span className={cn("text-xs font-medium", isOutOfBounds && "opacity-75")}>
                                {getSliderValueLabel({ computedStep, currentValue, isOutOfBounds, sliderMax, sliderMin })}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

SnappySlider.displayName = "SnappySlider";

const SnappySliderHeader = ({ className, ref, ...props }: React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> }) => (
    <div className={cn("mb-0.5 flex items-center justify-between", className)} ref={ref} {...props} />
);

SnappySliderHeader.displayName = "SnappySliderHeader";

const SnappySliderLabel = ({ className, ref, ...props }: React.LabelHTMLAttributes<HTMLLabelElement> & { ref?: React.Ref<HTMLLabelElement> }) => (
    <label className={cn("text-primary/50 text-xs font-medium", className)} ref={ref} {...props} />
);

SnappySliderLabel.displayName = "SnappySliderLabel";

const SnappySliderValue = ({
    className,
    prefix,
    ref,
    suffix,
    ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
    prefix?: string;
    ref?: React.Ref<HTMLInputElement>;
    suffix?: string;
}) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const composedRef = useComposedRefs<HTMLInputElement>(ref, inputRef);
    const generatedId = React.useId();
    const inputId = props.id ?? generatedId;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        const input = e.currentTarget;
        const value = Number.parseFloat(input.value);

        switch (e.key) {
            case "ArrowDown": {
                e.preventDefault();

                if (!Number.isNaN(value)) {
                    const step = e.shiftKey ? 10 : 1;

                    input.value = String(value - step);
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                }

                break;
            }
            case "ArrowUp": {
                e.preventDefault();

                if (!Number.isNaN(value)) {
                    const step = e.shiftKey ? 10 : 1;

                    input.value = String(value + step);
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                }

                break;
            }
            case "Enter": {
                input.blur();
                break;
            }
            default: {
                break;
            }
        }
    };

    return (
        // A <label> rather than a <div> with an onClick: focusing the wrapped input
        // when the surrounding chrome is clicked is what a label already does.
        <label
            className="group bg-primary/5 focus-within:ring-primary inline-flex w-20 cursor-text items-center rounded px-0.5 focus-within:ring-1"
            htmlFor={inputId}
        >
            {prefix && <span className="text-primary/75 shrink-0 text-xs select-none">{prefix}</span>}
            <input
                className={cn(
                    "w-full min-w-0 border-none bg-transparent text-right text-xs focus:outline-none",
                    "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
                    "text-primary tabular-nums",
                    className,
                )}
                id={inputId}
                inputMode="decimal"
                onKeyDown={handleKeyDown}
                ref={composedRef}
                type="number"
                {...props}
            />
            {suffix && <span className="text-primary/75 shrink-0 text-xs select-none">{suffix}</span>}
        </label>
    );
};

SnappySliderValue.displayName = "SnappySliderValue";

export { SnappySlider };
