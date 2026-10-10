"use client";

/**
 * LandingStickyBar - Expandable sticky composer at bottom of viewport
 *
 * Features:
 * - Appears when hero composer scrolls out of view
 * - Shows compact composer when collapsed (only input row visible)
 * - Expands to full composer on focus/click
 * - Collapses on blur/click outside (unless text is entered)
 * - Reuses the same Composer component as the hero and chat
 */

import cn from "@neore/ui/utils/cn";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import Composer from "@/features/chat/thread/composer";

import LandingChatProvider from "./landing-chat-provider";

interface LandingStickyBarProps {
    className?: string;
    visible: boolean;
}

const LandingStickyBar: FC<LandingStickyBarProps> = ({ className, visible }) => {
    const prefersReducedMotion = useReducedMotion();
    const composerText = useChatUIStore((state) => state.composerText);

    const [isExpanded, setIsExpanded] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Handle click outside to collapse
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(event.target as Node) && // Only collapse if no text entered
                !composerText.trim()
            ) {
                setIsExpanded(false);
            }
        };

        if (isExpanded) {
            document.addEventListener("mousedown", handleClickOutside);

            return () => document.removeEventListener("mousedown", handleClickOutside);
        }

        return undefined;
    }, [isExpanded, composerText]);

    const handleFocus = () => {
        setIsExpanded(true);
    };

    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    className={cn("fixed right-0 bottom-0 left-0 z-50", className)}
                    exit={{ opacity: 0, y: "100%" }}
                    initial={prefersReducedMotion ? false : { opacity: 0, y: "100%" }}
                    transition={{ damping: 35, stiffness: 500, type: "spring" }}
                >
                    <div className="mx-auto w-full max-w-(--thread-max-width) px-4 pb-4">
                        <motion.div layout onFocus={handleFocus} ref={containerRef} transition={{ duration: 0.15, ease: "easeOut" }}>
                            <LandingChatProvider>
                                <Composer compact={!isExpanded} minimal />
                            </LandingChatProvider>
                        </motion.div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default LandingStickyBar;
