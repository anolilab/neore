"use client";

import cn from "@ui/utils/cn";
import type { CSSProperties } from "react";
import { createElement, memo } from "react";

export interface TextShimmerProps {
    as?: "div" | "h1" | "h2" | "h3" | "p" | "span";
    children: string;
    className?: string;
    /** Seconds per sweep. */
    duration?: number;
    spread?: number;
}

/**
 * Text with a highlight sweeping across it. A CSS keyframe (`animate-text-shimmer` in `global.css`) moves the
 * background in 30 steps per sweep, so no script runs per frame and the text repaints 30 times a cycle, not on every
 * frame. An endless loop is motion the user cannot pause (WCAG 2.2.2): with reduced motion it does not run, and the
 * text stays at the sweep's end position.
 */
const ShimmerComponent = ({ as = "p", children, className, duration = 2, spread = 2 }: TextShimmerProps) =>
    createElement(
        as,
        {
            "aria-live": "polite",
            className: cn(
                "animate-text-shimmer relative inline-block bg-[length:250%_100%,auto] [background-position:0%_center] bg-clip-text text-transparent motion-reduce:animate-none",
                "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))]",
                className,
            ),
            role: as.startsWith("h") ? undefined : "status",
            style: {
                "--shimmer-duration": `${duration}s`,
                "--spread": `${children.length * spread}px`,
                backgroundImage: "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
            } as CSSProperties,
        },
        children,
    );

const Shimmer = memo(ShimmerComponent);

export default Shimmer;
