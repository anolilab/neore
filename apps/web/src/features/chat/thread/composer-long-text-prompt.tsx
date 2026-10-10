"use client";

/**
 * Long Text Conversion Prompt
 *
 * Suggests converting long text input into an attachment for cleaner UX
 */

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { FileTextIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useCallback, useState } from "react";

interface ComposerLongTextPromptProps {
    /** Minimum lines threshold */
    minLines?: number;
    onConvert: () => void;
    text: string;
    /** Character threshold for showing prompt */
    threshold?: number;
}

const ComposerLongTextPrompt: FC<ComposerLongTextPromptProps> = ({ minLines = 10, onConvert, text, threshold = 500 }) => {
    const { t } = useLingui();
    const [dismissed, setDismissed] = useState(false);

    // Clearing the composer re-arms the prompt. Adjusting during render (rather than in an
    // effect) keeps `showPrompt` derived, so the banner never flashes a stale value.
    if (dismissed && text.length === 0) {
        setDismissed(false);
    }

    const isShowPrompt = !dismissed && (text.length > threshold || text.split("\n").length > minLines);

    const handleDismiss = useCallback(() => {
        setDismissed(true);
    }, []);

    const handleConvert = useCallback(() => {
        onConvert();
        setDismissed(true);
    }, [onConvert]);

    return (
        <AnimatePresence>
            {isShowPrompt && (
                <motion.div
                    animate={{ height: "auto", opacity: 1, y: 0 }}
                    className="overflow-hidden"
                    exit={{ height: 0, opacity: 0, y: -10 }}
                    initial={{ height: 0, opacity: 0, y: -10 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                >
                    <div className="mx-2 mb-2 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 p-2.5 dark:border-blue-900/30 dark:bg-blue-950/20">
                        <FileTextIcon className="size-4 shrink-0 text-blue-600 dark:text-blue-400" />
                        <div className="flex-1 text-sm">
                            <span className="font-medium text-blue-900 dark:text-blue-100">{t`Long text detected`}</span>
                            <span className="ml-1 text-blue-700 dark:text-blue-300">{t`Convert to attachment for better readability?`}</span>
                        </div>
                        <Button
                            className="h-7 shrink-0 text-xs text-blue-600 hover:bg-blue-100 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-900/30 dark:hover:text-blue-300"
                            onClick={handleConvert}
                            size="sm"
                            variant="ghost"
                        >
                            {t`Convert`}
                        </Button>
                        <button
                            aria-label={t`Dismiss`}
                            className="shrink-0 rounded-sm p-1 text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/30"
                            onClick={handleDismiss}
                            type="button"
                        >
                            <XIcon aria-hidden="true" className="size-3.5" />
                        </button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default ComposerLongTextPrompt;
