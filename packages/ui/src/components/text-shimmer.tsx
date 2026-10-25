"use client";

import { motion, useReducedMotion } from "motion/react";
import type { JSX } from "react";
import React, { memo, useMemo } from "react";

import cn from "../utils/cn";

interface TextShimmerProps {
    as?: React.ElementType;
    children: string;
    className?: string;
    duration?: number;
    spread?: number;
}

const TextShimmer = memo(({ as: Component = "p", children, className, duration = 2, spread = 2 }: TextShimmerProps) => {
    // An endless loop is motion the user cannot pause (WCAG 2.2.2), and the global CSS rule does not reach Motion.
    const prefersReducedMotion = useReducedMotion();
    const MotionComponent = motion.create(Component as keyof JSX.IntrinsicElements);

    const dynamicSpread = useMemo(() => children.length * spread, [children, spread]);

    return (
        <MotionComponent
            animate={{ backgroundPosition: "0% center" }}
            className={cn(
                "relative inline-block bg-[length:250%_100%,auto] bg-clip-text",
                "text-transparent [--base-color:#a1a1aa] [--base-gradient-color:#000]",
                "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]",
                "dark:[--base-color:#71717a] dark:[--base-gradient-color:#ffffff] dark:[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]",
                className,
            )}
            initial={{ backgroundPosition: "100% center" }}
            style={
                {
                    "--spread": `${dynamicSpread}px`,
                    backgroundImage: `var(--bg), linear-gradient(var(--base-color), var(--base-color))`,
                } as React.CSSProperties
            }
            transition={prefersReducedMotion ? { duration: 0 } : { duration, ease: "linear", repeat: Infinity }}
        >
            {children}
        </MotionComponent>
    );
});

export default TextShimmer;
