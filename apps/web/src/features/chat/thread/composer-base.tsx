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
import { useImperativeHandle, useRef } from "react";

export type ComposerMode = "text" | "image" | "video" | "audio";

export interface ComposerBaseRef {
    blur: () => void;
    focus: () => void;
}

export interface ComposerBaseProps {
    /** Plays the entrance (fade and slide in) when the composer mounts. Off for a composer that moves between split-view panes. */
    animateEntrance?: boolean;
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

/** A faint wash of the mode's colour from the top-left corner: the composer's cue for which mode it is in. */
const MODE_TINT = {
    audio: "from-rose-500/[0.03] dark:from-rose-400/[0.05]",
    image: "from-violet-500/[0.03] dark:from-violet-400/[0.05]",
    text: "from-lime-500/[0.03] dark:from-lime-400/[0.04]",
    video: "from-sky-500/[0.03] dark:from-sky-400/[0.05]",
} as const;

/**
 * Container component that provides the composer structure.
 */
const ComposerBase = ({
    animateEntrance = true,
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
    const skipEntrance = prefersReducedMotion || !animateEntrance;

    return (
        <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className={cn("relative w-full", className)}
            data-dragging={isDragging}
            initial={skipEntrance ? false : { opacity: 0, scale: 0.98, y: 20 }}
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
            {/* Main composer container: one raised panel, the input sits on it without a box of its own. */}
            <motion.div
                className={clsx(
                    "surface-raised w-full overflow-hidden rounded-2xl",
                    "data-[dragging=true]:outline-ring data-[dragging=true]:bg-accent/50 data-[dragging=true]:-outline-offset-2 data-[dragging=true]:outline-2 data-[dragging=true]:outline-dashed",
                    "relative z-10",
                )}
                data-dragging={isDragging}
                data-mode={mode}
                data-view-transition={viewTransitionName}
            >
                <div aria-hidden="true" className={clsx("pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent", MODE_TINT[mode])} />
                {/* Content wrapper, above the tint */}
                <div className="relative z-10">
                    {/* Mode settings row (image/video/audio options) */}
                    <AnimatePresence mode="popLayout">
                        {modeSettings && (
                            <motion.div
                                animate={{ height: "auto", opacity: 1 }}
                                className="flex flex-row items-center justify-between gap-2 overflow-hidden px-3 pt-2 pb-0"
                                exit={{ height: 0, opacity: 0 }}
                                initial={skipEntrance ? false : { height: 0, opacity: 0 }}
                                key="mode-settings"
                                transition={{ duration: 0.15, ease: "easeOut" }}
                            >
                                {modeSettings}
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Input area: no box of its own, the panel is the surface */}
                    <div className="relative flex px-2 pt-2">
                        {leftPanel && <div className="border-surface-edge flex shrink-0 self-stretch border-r">{leftPanel}</div>}
                        <div className="relative flex min-w-0 flex-1 items-center justify-center px-1">{children}</div>
                    </div>

                    {/* Bottom toolbar — hidden in compact mode, separated by a subtle border */}
                    <AnimatePresence>
                        {bottomToolbar && !compact && (
                            <motion.div
                                animate={{ height: "auto", opacity: 1 }}
                                className="flex w-full flex-row flex-wrap items-center gap-1 px-2 pt-1 pb-2"
                                exit={{ height: 0, opacity: 0 }}
                                initial={skipEntrance ? false : { height: 0, opacity: 0 }}
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
