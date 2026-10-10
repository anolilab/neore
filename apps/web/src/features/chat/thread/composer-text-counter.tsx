"use client";

/**
 * Text Counter - Shows character/line count for long text
 */

import { useLingui } from "@lingui/react/macro";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useMemo } from "react";

const WHITESPACE_RE = /\s+/;

interface ComposerTextCounterProps {
    text: string;
    /** Show counter when text exceeds this character count */
    threshold?: number;
}

const ComposerTextCounter: FC<ComposerTextCounterProps> = ({ text, threshold = 300 }) => {
    const { t } = useLingui();

    const stats = useMemo(() => {
        const chars = text.length;
        const lines = text.split("\n").length;
        const words = text.trim().split(WHITESPACE_RE).filter(Boolean).length;

        return { chars, lines, words };
    }, [text]);

    const isShowCounter = stats.chars > threshold;

    return (
        <AnimatePresence>
            {isShowCounter && (
                <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute top-2 right-2 z-10"
                    exit={{ opacity: 0, y: -5 }}
                    initial={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.15 }}
                >
                    <div
                        className={clsx(
                            "flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium",
                            "bg-white/90 backdrop-blur-sm dark:bg-neutral-900/90",
                            "border border-gray-200 dark:border-neutral-800",
                            "shadow-sm",
                        )}
                    >
                        <span className="text-gray-600 dark:text-gray-400">{t`${stats.chars} chars`}</span>
                        <span className="text-gray-300 dark:text-gray-700">•</span>
                        <span className="text-gray-600 dark:text-gray-400">{t`${stats.lines} lines`}</span>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default ComposerTextCounter;
