"use client";

/**
 * ComposerBase - Shared visual component for composer
 *
 * Used by both the chat Composer and the landing page composer.
 * Provides the container structure with slots for customization.
 */

import cn from "@neore/ui/utils/cn";
import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";

export type ComposerMode = "text" | "image" | "video" | "audio";

export interface ComposerBaseRef {
    blur: () => void;
    focus: () => void;
}

export interface ComposerBaseProps {
    /** Content to render in the bottom toolbar */
    bottomToolbar?: ReactNode;
    /** The input area content (textarea, buttons, etc.) */
    children: ReactNode;
    className?: string;
    /** Compact mode - hides bottom toolbar for minimal appearance */
    compact?: boolean;
    /** Data attribute for drag state */
    isDragging?: boolean;
    /** Panel rendered to the left of the input inside the recessed area */
    leftPanel?: ReactNode;
    /** Current composer mode */
    mode: ComposerMode;
    /** Content to render in the mode settings row (above input) */
    modeSettings?: ReactNode;
    /** Drag event handlers */
    onDragEnter?: (e: React.DragEvent) => void;
    onDragLeave?: (e: React.DragEvent) => void;
    onDragOver?: (e: React.DragEvent) => void;
    onDrop?: (e: React.DragEvent) => void;
    /** View transition name for morph animations */
    viewTransitionName?: string;
}

const MODE_STYLES = {
    audio: {
        borderColor: { dark: "rgba(255,255,255,0.08)", light: "rgba(0,0,0,0.1)" },
        gradient: { dark: "from-rose-400/[0.03]", light: "from-rose-500/[0.02]" },
    },
    image: {
        borderColor: { dark: "rgba(255,255,255,0.08)", light: "rgba(0,0,0,0.1)" },
        gradient: { dark: "from-violet-400/[0.03]", light: "from-violet-500/[0.02]" },
    },
    text: {
        borderColor: { dark: "rgba(255,255,255,0.08)", light: "rgba(0,0,0,0.1)" },
        gradient: { dark: "from-lime-400/[0.03]", light: "from-lime-500/[0.02]" },
    },
    video: {
        borderColor: { dark: "rgba(255,255,255,0.08)", light: "rgba(0,0,0,0.1)" },
        gradient: { dark: "from-sky-400/[0.03]", light: "from-sky-500/[0.02]" },
    },
} as const;

/**
 * Container component that provides the composer structure.
 */
const ComposerBase = ({
    bottomToolbar,
    children,
    className,
    compact = false,
    isDragging,
    leftPanel,
    mode,
    modeSettings,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
    ref,
    viewTransitionName,
}: ComposerBaseProps & { ref?: React.RefObject<ComposerBaseRef | null> }) => {
    const containerRef = useRef<HTMLDivElement>(null);

    // Detect theme (dark mode)
    const [isDark, setIsDark] = useState(false);

    useEffect(() => {
        const checkTheme = () => {
            setIsDark(document.documentElement.classList.contains("dark"));
        };

        checkTheme();

        const observer = new MutationObserver(checkTheme);

        observer.observe(document.documentElement, {
            attributeFilter: ["class"],
            attributes: true,
        });

        return () => observer.disconnect();
    }, []);

    const modeStyle = MODE_STYLES[mode] ?? MODE_STYLES.text;
    const borderColor = isDark ? modeStyle.borderColor.dark : modeStyle.borderColor.light;
    const gradient = isDark ? modeStyle.gradient.dark : modeStyle.gradient.light;

    useImperativeHandle(ref, () => {
        return {
            blur: () => {
                const input = containerRef.current?.querySelector(".tiptap") as HTMLElement | null;

                input?.blur();
            },
            focus: () => {
                const input = containerRef.current?.querySelector(".tiptap") as HTMLElement | null;

                input?.focus();
            },
        };
    }, []);

    const prefersReducedMotion = useReducedMotion();

    return (
        <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className={cn("relative w-full", className)}
            data-dragging={isDragging}
            initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.98, y: 20 }}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
            ref={containerRef}
            transition={{
                damping: 30,
                mass: 0.8,
                stiffness: 400,
                type: "spring",
            }}
        >
            {/* Main composer container — single clean border */}
            <motion.div
                className={clsx(
                    "bg-card/70 w-full overflow-hidden rounded-xl backdrop-blur-xl",
                    "border transition-[border-color,box-shadow] duration-300",
                    "data-[dragging=true]:border-ring data-[dragging=true]:bg-accent/50 data-[dragging=true]:border-dashed",
                    "relative",
                )}
                data-dragging={isDragging}
                data-view-transition={viewTransitionName}
                style={{
                    borderColor: isDragging ? undefined : borderColor,
                }}
            >
                {/* Mode-specific gradient background overlay */}
                <div className={clsx("pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent", gradient)} />

                {/* Content wrapper with relative positioning above gradient */}
                <div className="relative z-10">
                    {/* Mode settings row (image/video/audio options) */}
                    <AnimatePresence mode="popLayout">
                        {modeSettings && (
                            <motion.div
                                animate={{ height: "auto", opacity: 1 }}
                                className="flex flex-row items-center justify-between gap-2 overflow-hidden px-3 pt-2 pb-0"
                                exit={{ height: 0, opacity: 0 }}
                                initial={prefersReducedMotion ? false : { height: 0, opacity: 0 }}
                                key="mode-settings"
                                transition={{ duration: 0.15, ease: "easeOut" }}
                            >
                                {modeSettings}
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Input area — deep recessed panel, visually pressed into the card */}
                    <div className="p-2">
                        <div
                            className={clsx(
                                "relative overflow-hidden rounded-md",
                                "dark:bg-brand-charcoal",
                                "bg-zinc-100/70",
                                "border border-black/[0.06] dark:border-white/[0.04]",
                            )}
                        >
                            <div className="relative flex">
                                {leftPanel && (
                                    <div className="flex shrink-0 self-stretch border-r border-black/[0.06] dark:border-white/[0.04]">{leftPanel}</div>
                                )}
                                <div className="relative flex w-full items-center justify-center px-1">{children}</div>
                            </div>
                        </div>
                    </div>

                    {/* Bottom toolbar — hidden in compact mode, separated by a subtle border */}
                    <AnimatePresence>
                        {bottomToolbar && !compact && (
                            <motion.div
                                animate={{ height: "auto", opacity: 1 }}
                                className="flex w-full flex-row items-center gap-1 px-2 pb-1"
                                exit={{ height: 0, opacity: 0 }}
                                initial={prefersReducedMotion ? false : { height: 0, opacity: 0 }}
                                style={{ borderTopColor: borderColor }}
                                transition={{ duration: 0.15, ease: "easeOut" }}
                            >
                                {bottomToolbar}
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </motion.div>
        </motion.div>
    );
};

ComposerBase.displayName = "ComposerBase";

export { ComposerBase };
