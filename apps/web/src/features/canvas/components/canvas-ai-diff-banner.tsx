"use client";

/**
 * Canvas AI Diff Banner — Notification banner that appears when AI modifies the open document.
 * Provides quick actions: View Changes, Undo, and Dismiss.
 */

import { useLingui } from "@lingui/react/macro";
import { SparklesIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";

interface CanvasAiDiffBannerProps {
    onDismiss: () => void;
    onUndo: () => void;
    onViewChanges: () => void;
    visible: boolean;
}

const CanvasAiDiffBanner: FC<CanvasAiDiffBannerProps> = ({ onDismiss, onUndo, onViewChanges, visible }) => {
    const { t } = useLingui();

    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    animate={{ height: "auto", opacity: 1 }}
                    className="overflow-hidden border-b"
                    exit={{ height: 0, opacity: 0 }}
                    initial={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <div className="flex items-center justify-between gap-2 bg-blue-50 px-4 py-2 dark:bg-blue-950/30">
                        <div className="flex items-center gap-2">
                            <SparklesIcon className="size-4 text-blue-500" />
                            <span className="text-sm font-medium text-blue-700 dark:text-blue-300">{t`AI updated this document`}</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                className="rounded-md px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/40"
                                onClick={onViewChanges}
                                type="button"
                            >
                                {t`View Changes`}
                            </button>
                            <button
                                className="rounded-md px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/40"
                                onClick={onUndo}
                                type="button"
                            >
                                {t`Undo`}
                            </button>
                            <button
                                aria-label={t`Dismiss`}
                                className="text-muted-foreground hover:text-foreground rounded-md p-1"
                                onClick={onDismiss}
                                type="button"
                            >
                                <XIcon aria-hidden="true" className="size-3.5" />
                            </button>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default CanvasAiDiffBanner;
