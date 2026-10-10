"use client";

import cn from "@ui/utils/cn";
import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { memo, useMemo } from "react";

export interface TextShimmerProps {
    as?: keyof typeof MOTION_ELEMENTS;
    children: string;
    className?: string;
    duration?: number;
    spread?: number;
}

/**
 * The elements the shimmer can render as, each a motion component made ONCE
 * here. `motion.create(as)` in render made a new component type per render, so
 * React remounted the element and restarted the animation every time.
 */
const MOTION_ELEMENTS = {
    div: motion.div,
    h1: motion.h1,
    h2: motion.h2,
    h3: motion.h3,
    p: motion.p,
    span: motion.span,
};

const ShimmerComponent = ({ as = "p", children, className, duration = 2, spread = 2 }: TextShimmerProps) => {
    const MotionComponent = MOTION_ELEMENTS[as];

    const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

    return (
        <MotionComponent
            animate={{ backgroundPosition: "0% center" }}
            aria-live="polite"
            className={cn(
                "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
                "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))]",
                className,
            )}
            initial={{ backgroundPosition: "100% center" }}
            role="status"
            style={
                {
                    "--spread": `${dynamicSpread}px`,
                    backgroundImage: "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
                } as CSSProperties
            }
            transition={{
                duration,
                ease: "linear",
                repeat: Infinity,
            }}
        >
            {children}
        </MotionComponent>
    );
};

const Shimmer = memo(ShimmerComponent);

export default Shimmer;
