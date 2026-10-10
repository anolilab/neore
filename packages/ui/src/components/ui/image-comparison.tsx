"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import type { MotionValue, SpringOptions } from "motion/react";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { createContext, use, useMemo, useState } from "react";

type ImageComparisonContextValue = {
    motionSliderPosition: MotionValue<number>;
    setSliderPosition: (pos: number) => void;
    sliderPosition: number;
};

const ImageComparisonContext = createContext<ImageComparisonContextValue | undefined>(undefined);

export type ImageComparisonProps = {
    children: React.ReactNode;
    className?: string;
    enableHover?: boolean;
    springOptions?: SpringOptions;
};

const DEFAULT_SPRING_OPTIONS = {
    bounce: 0,
    duration: 0,
};

const ImageComparison = ({ children, className, enableHover, springOptions }: ImageComparisonProps) => {
    const { t } = useLingui();
    const [isDragging, setIsDragging] = useState(false);
    const motionValue = useMotionValue(50);
    const motionSliderPosition = useSpring(motionValue, springOptions ?? DEFAULT_SPRING_OPTIONS);
    const [sliderPosition, setSliderPosition] = useState(50);

    const handleDrag = (event: React.MouseEvent | React.TouchEvent) => {
        if (!isDragging && !enableHover) {
            return;
        }

        const containerRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const clientX = "touches" in event ? event.touches[0]?.clientX : (event as React.MouseEvent).clientX;

        if (clientX === undefined) {
            return;
        }

        const x = clientX - containerRect.left;

        const percentage = Math.min(Math.max((x / containerRect.width) * 100, 0), 100);

        motionValue.set(percentage);
        setSliderPosition(percentage);
    };

    /**
     * Keyboard operation. The component was pointer-only — no role, no tab
     * stop, no key handling — so the comparison slider could not be moved at
     * all without a mouse or touch (WCAG 2.1.1).
     *
     * Arrow keys step by 5%, Home/End jump to either extreme, matching the
     * native `input[type=range]` conventions a screen reader will announce for
     * `role="slider"`.
     */
    const step = (delta: number) => {
        const next = Math.min(Math.max(sliderPosition + delta, 0), 100);

        motionValue.set(next);
        setSliderPosition(next);
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
        const moves: Record<string, number> = { ArrowDown: -5, ArrowLeft: -5, ArrowRight: 5, ArrowUp: 5 };
        const delta = moves[event.key];

        if (delta !== undefined) {
            event.preventDefault();
            step(delta);

            return;
        }

        if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const target = event.key === "Home" ? 0 : 100;

            motionValue.set(target);
            setSliderPosition(target);
        }
    };

    const contextValue = useMemo<ImageComparisonContextValue>(() => {
        return { motionSliderPosition, setSliderPosition, sliderPosition };
    }, [motionSliderPosition, sliderPosition]);

    return (
        <ImageComparisonContext value={contextValue}>
            <div
                aria-label={t`Comparison slider position`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.round(sliderPosition)}
                className={cn("relative overflow-hidden select-none", enableHover && "cursor-ew-resize", className)}
                onKeyDown={handleKeyDown}
                onMouseDown={() => !enableHover && setIsDragging(true)}
                onMouseLeave={() => !enableHover && setIsDragging(false)}
                onMouseMove={handleDrag}
                onMouseUp={() => !enableHover && setIsDragging(false)}
                onTouchEnd={() => !enableHover && setIsDragging(false)}
                onTouchMove={handleDrag}
                onTouchStart={() => !enableHover && setIsDragging(true)}
                role="slider"
                tabIndex={0}
            >
                {children}
            </div>
        </ImageComparisonContext>
    );
};

const ImageComparisonImage = ({ alt, className, position, src }: { alt: string; className?: string; position: "left" | "right"; src: string }) => {
    const { motionSliderPosition } = use(ImageComparisonContext)!;
    const leftClipPath = useTransform(motionSliderPosition, (value) => `inset(0 0 0 ${value}%)`);
    const rightClipPath = useTransform(motionSliderPosition, (value) => `inset(0 ${100 - value}% 0 0)`);

    return (
        <motion.img
            alt={alt}
            className={cn("absolute inset-0 h-full w-full object-cover", className)}
            src={src}
            style={{
                clipPath: position === "left" ? leftClipPath : rightClipPath,
            }}
        />
    );
};

const ImageComparisonSlider = ({ children, className }: { children?: React.ReactNode; className: string }) => {
    const { motionSliderPosition } = use(ImageComparisonContext)!;

    const left = useTransform(motionSliderPosition, (value) => `${value}%`);

    return (
        <motion.div
            className={cn("absolute top-0 bottom-0 w-1 cursor-ew-resize", className)}
            style={{
                left,
            }}
        >
            {children}
        </motion.div>
    );
};

export { ImageComparison, ImageComparisonImage, ImageComparisonSlider };
