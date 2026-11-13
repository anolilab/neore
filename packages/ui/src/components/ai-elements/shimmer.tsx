"use client";

import cn from "@ui/utils/cn";
import type { CSSProperties } from "react";
import { createElement, memo, useEffect, useState } from "react";

export interface TextShimmerProps {
    as?: "div" | "h1" | "h2" | "h3" | "p" | "span";
    children: string;
    className?: string;
    /** Seconds per sweep. */
    duration?: number;
    spread?: number;
}

/**
 * Reports whether `target` is on screen until the returned function stops it. Best-effort: where the observer is
 * missing, is not a constructor (a test stub), or throws, it reports nothing and the shimmer keeps animating.
 */
const watchOnScreen = (target: Element, onChange: (onScreen: boolean) => void): (() => void) | undefined => {
    if (typeof IntersectionObserver !== "function") {
        return undefined;
    }

    try {
        const observer = new IntersectionObserver((entries: IntersectionObserverEntry[]) => {
            const last = entries.at(-1);

            if (last) {
                onChange(last.isIntersecting);
            }
        });

        observer.observe(target);

        return () => {
            try {
                observer.disconnect();
            } catch {
                // Nothing left to stop.
            }
        };
    } catch {
        return undefined;
    }
};

/**
 * Text with a highlight sweeping across it. A CSS keyframe (`animate-text-shimmer` in `global.css`) moves the
 * background in 30 steps per sweep, so no script runs per frame and the text repaints 30 times a cycle, not on every
 * frame. An endless loop is motion the user cannot pause (WCAG 2.2.2): with reduced motion it does not run, and the
 * text stays at the sweep's end position. Off-screen it pauses (`data-paused`) where an IntersectionObserver can start.
 */
const ShimmerComponent = ({ as = "p", children, className, duration = 2, spread = 2 }: TextShimmerProps) => {
    // A callback ref into state: the effect runs again for a new element (another `as`).
    const [target, setTarget] = useState<HTMLElement | null>(null);
    const [offScreen, setOffScreen] = useState(false);

    useEffect(() => {
        if (!target) {
            return undefined;
        }

        return watchOnScreen(target, (onScreen: boolean) => setOffScreen(!onScreen));
    }, [target]);

    return createElement(
        as,
        {
            "aria-live": "polite",
            className: cn(
                "animate-text-shimmer relative inline-block bg-[length:250%_100%,auto] [background-position:0%_center] bg-clip-text text-transparent motion-reduce:animate-none",
                "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))]",
                className,
            ),
            "data-paused": offScreen ? "" : undefined,
            ref: setTarget,
            role: as.startsWith("h") ? undefined : "status",
            style: {
                "--shimmer-duration": `${duration}s`,
                "--spread": `${children.length * spread}px`,
                backgroundImage: "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
            } as CSSProperties,
        },
        children,
    );
};

const Shimmer = memo(ShimmerComponent);

export default Shimmer;
