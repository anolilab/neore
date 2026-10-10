"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Separator } from "@neore/ui/components/separator";
import { Textarea } from "@neore/ui/components/textarea";
import cn from "@neore/ui/utils/cn";
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, RotateCcw, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import useOptimizerStyleLabels from "@/features/chat/prompt-improvement/hooks/use-optimizer-style-labels";
import usePromptImprovement from "@/features/chat/prompt-improvement/hooks/use-prompt-improvement";
import usePromptImprovementStore from "@/features/chat/prompt-improvement/stores/prompt-improvement-store";
import { ErrorUtilities } from "@/lib/errors";

interface PromptImprovementPanelProps {
    className?: string;
}

const PromptImprovementPanel: FC<PromptImprovementPanelProps> = ({ className }) => {
    const { i18n, t } = useLingui();
    const styleLabels = useOptimizerStyleLabels();

    const composerText = useChatUIStore((state) => state.composerText);
    const setComposerText = useChatUIStore((state) => state.setComposerText);

    const {
        addImprovedPrompt,
        currentPrompt,
        currentPromptIndex,
        dismiss,
        error,
        hasImproved,
        improvedPrompts,
        improvementInstructions,
        isImproving,
        isOpen,
        iterateInput,
        nextPrompt,
        previousPrompt,
        retryCount,
        setCurrentPrompt,
        setError,
        setImprovedPrompts,
        setImprovementInstructions,
        setIsImproving,
        setIterateInput,
        style,
        threadId,
    } = usePromptImprovementStore(
        useShallow((state) => {
            return {
                addImprovedPrompt: state.addImprovedPrompt,
                currentPrompt: state.currentPrompt,
                currentPromptIndex: state.currentPromptIndex,
                dismiss: state.dismiss,
                error: state.error,
                hasImproved: state.hasImproved,
                improvedPrompts: state.improvedPrompts,
                improvementInstructions: state.improvementInstructions,
                isImproving: state.isImproving,
                isOpen: state.isOpen,
                iterateInput: state.iterateInput,
                nextPrompt: state.nextPrompt,
                previousPrompt: state.previousPrompt,
                retryCount: state.retryCount,
                setCurrentPrompt: state.setCurrentPrompt,
                setError: state.setError,
                setImprovedPrompts: state.setImprovedPrompts,
                setImprovementInstructions: state.setImprovementInstructions,
                setIsImproving: state.setIsImproving,
                setIterateInput: state.setIterateInput,
                style: state.style,
                threadId: state.threadId,
            };
        }),
    );

    const currentImprovedPrompt = improvedPrompts[currentPromptIndex] || "";
    const canGoPrevious = currentPromptIndex > 0;
    const canGoNext = currentPromptIndex < improvedPrompts.length - 1;

    const { improvePrompt, iterate } = usePromptImprovement(threadId);

    useEffect(() => {
        if (isOpen && composerText) {
            setCurrentPrompt(composerText);
        }
    }, [composerText, isOpen, setCurrentPrompt]);

    useEffect(() => {
        if (!threadId) {
            return;
        }

        const store = usePromptImprovementStore.getState();

        if (store.threadId && store.threadId !== threadId) {
            setImprovedPrompts([]);
        }
    }, [setImprovedPrompts, threadId]);

    const handleImprove = useCallback(async () => {
        setError(null);
        setIsImproving(true);

        try {
            const result = await improvePrompt(currentPrompt, { improvementInstructions, style });

            addImprovedPrompt(result);
        } catch (improveError: any) {
            setError(improveError);
        }

        setIsImproving(false);
    }, [addImprovedPrompt, currentPrompt, improvementInstructions, improvePrompt, setError, setIsImproving, style]);

    const handleIterate = useCallback(async () => {
        if (!currentImprovedPrompt.trim() || !iterateInput.trim()) {
            return;
        }

        setError(null);
        setIsImproving(true);

        try {
            const result = await iterate(currentImprovedPrompt, iterateInput, "user");

            addImprovedPrompt(result);
            setIterateInput("");
        } catch (iterateError: any) {
            setError(iterateError);
        }

        setIsImproving(false);
    }, [addImprovedPrompt, currentImprovedPrompt, iterate, iterateInput, setError, setIsImproving, setIterateInput]);

    const handleApply = useCallback(() => {
        if (!currentImprovedPrompt) {
            return;
        }

        setComposerText(currentImprovedPrompt);
        dismiss();
    }, [setComposerText, currentImprovedPrompt, dismiss]);

    const [isOnline, setIsOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);

    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);

        globalThis.addEventListener("online", handleOnline);
        globalThis.addEventListener("offline", handleOffline);

        return () => {
            globalThis.removeEventListener("online", handleOnline);
            globalThis.removeEventListener("offline", handleOffline);
        };
    }, []);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    animate={{ height: "auto", opacity: 1 }}
                    className={cn("bg-sidebar mx-auto w-full overflow-hidden rounded-t-lg", className)}
                    exit={{ height: 0, opacity: 0 }}
                    initial={{ height: 0, opacity: 0 }}
                    transition={{
                        height: { duration: 0.3, ease: "easeOut" },
                        opacity: { duration: 0.2, ease: "easeOut" },
                    }}
                >
                    <motion.div animate={{ y: 0 }} className="relative" exit={{ y: 20 }} initial={{ y: 20 }} transition={{ duration: 0.3, ease: "easeOut" }}>
                        <div className="relative z-0 px-2 pt-3 pb-1">
                            <div className="space-y-4">
                                {error && (
                                    <motion.div
                                        animate={{ opacity: 1, x: 0 }}
                                        className="bg-destructive/10 border-destructive/20 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                                        initial={{ opacity: 0, x: -10 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        <AlertCircle className="h-4 w-4 shrink-0" />
                                        <span>{ErrorUtilities.getUserMessage(error, i18n)}</span>
                                    </motion.div>
                                )}

                                {!isOnline && (
                                    <motion.div
                                        animate={{ opacity: 1, x: 0 }}
                                        className="bg-warning/10 border-warning/20 text-warning flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                                        initial={{ opacity: 0, x: -10 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        <WifiOff className="h-4 w-4 shrink-0" />
                                        <span>{t`You're offline. Please check your connection.`}</span>
                                    </motion.div>
                                )}

                                {retryCount > 0 && (
                                    <motion.div
                                        animate={{ opacity: 1 }}
                                        className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300"
                                        initial={{ opacity: 0 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        {t`Retrying... (Attempt ${retryCount + 1})`}
                                    </motion.div>
                                )}

                                <motion.div
                                    animate={{ opacity: 1, y: 0 }}
                                    className="space-y-2"
                                    initial={{ opacity: 0, y: 10 }}
                                    transition={{ delay: 0.1, duration: 0.3 }}
                                >
                                    <div className="flex items-center justify-between">
                                        <Label className="text-sm" htmlFor="improvement-instructions">
                                            {t`What would you like to improve? (optional)`}
                                        </Label>
                                        <span className="text-muted-foreground/70 text-[10px] tracking-widest uppercase">
                                            {t`Style: ${styleLabels.user[style].label}`}
                                        </span>
                                    </div>
                                    <div className="relative z-10">
                                        <Textarea
                                            disabled={isImproving}
                                            id="improvement-instructions"
                                            onChange={(e) => setImprovementInstructions(e.target.value)}
                                            onClick={(e) => e.stopPropagation()}
                                            onFocus={(e) => e.stopPropagation()}
                                            placeholder={t`e.g., Make it more concise, add technical details, improve clarity...`}
                                            value={improvementInstructions}
                                        />
                                    </div>
                                </motion.div>

                                <AnimatePresence>
                                    {hasImproved && improvedPrompts.length > 0 && (
                                        <motion.div
                                            animate={{ height: "auto", opacity: 1 }}
                                            className="space-y-2"
                                            exit={{ height: 0, opacity: 0 }}
                                            initial={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.3 }}
                                        >
                                            <div className="flex items-center justify-between">
                                                <Label className="text-sm" htmlFor="improved-prompt">
                                                    {t`Improved Prompt`}
                                                </Label>
                                                {improvedPrompts.length > 1 && (
                                                    <div className="flex items-center gap-2">
                                                        <Button disabled={!canGoPrevious || isImproving} onClick={previousPrompt} size="sm" variant="ghost">
                                                            <ChevronLeft className="h-4 w-4" />
                                                        </Button>
                                                        <span className="text-muted-foreground text-xs">
                                                            {currentPromptIndex + 1} /{improvedPrompts.length}
                                                        </span>
                                                        <Button disabled={!canGoNext || isImproving} onClick={nextPrompt} size="sm" variant="ghost">
                                                            <ChevronRight className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="relative z-10">
                                                <Textarea
                                                    className="max-h-32 min-h-32"
                                                    disabled={isImproving}
                                                    id="improved-prompt"
                                                    onChange={(e) => {
                                                        const updatedPrompts = [...improvedPrompts];

                                                        updatedPrompts[currentPromptIndex] = e.target.value;
                                                        setImprovedPrompts(updatedPrompts);
                                                    }}
                                                    onClick={(e) => e.stopPropagation()}
                                                    onFocus={(e) => e.stopPropagation()}
                                                    placeholder={t`The improved prompt will appear here...`}
                                                    value={currentImprovedPrompt}
                                                />
                                            </div>

                                            <div className="relative z-10 space-y-2 pt-1">
                                                <Label className="text-muted-foreground text-xs" htmlFor="iterate-input">
                                                    {t`Refine with feedback (optional)`}
                                                </Label>
                                                <div className="flex items-start gap-2">
                                                    <Textarea
                                                        className="min-h-12"
                                                        disabled={isImproving}
                                                        id="iterate-input"
                                                        onChange={(e) => setIterateInput(e.target.value)}
                                                        onClick={(e) => e.stopPropagation()}
                                                        onFocus={(e) => e.stopPropagation()}
                                                        placeholder={t`e.g., Make it stricter about JSON output, add a code example...`}
                                                        value={iterateInput}
                                                    />
                                                    <Button
                                                        disabled={isImproving || !iterateInput.trim() || !currentImprovedPrompt.trim()}
                                                        onClick={handleIterate}
                                                        size="sm"
                                                        variant="outline"
                                                    >
                                                        <RotateCcw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                                                        {t`Refine`}
                                                    </Button>
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>

                                <motion.div
                                    animate={{ opacity: 1 }}
                                    className="flex items-center justify-end gap-2"
                                    initial={{ opacity: 0 }}
                                    transition={{ delay: 0.2, duration: 0.2 }}
                                >
                                    {hasImproved && (
                                        <Button disabled={isImproving || !currentImprovedPrompt.trim()} onClick={handleApply} variant="outline">
                                            {t`Apply`}
                                        </Button>
                                    )}
                                    <Button className="text-black" disabled={isImproving || !currentPrompt.trim()} onClick={handleImprove}>
                                        {isImproving ? (
                                            <>
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                {t`Improving...`}
                                            </>
                                        ) : (
                                            t`Improve`
                                        )}
                                    </Button>
                                </motion.div>
                            </div>
                        </div>

                        <AnimatePresence>
                            {hasImproved && (
                                <motion.div animate={{ opacity: 1 }} exit={{ opacity: 0 }} initial={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                                    <Separator className="dark:opacity-25" />
                                    <div className="bg-card dark:bg-sidebar px-4 py-2">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <span className="text-muted-foreground/60 dark:text-muted-foreground/50 font-mono text-[10px] tracking-widest uppercase">
                                                    {t`Prompt improved`}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default PromptImprovementPanel;
