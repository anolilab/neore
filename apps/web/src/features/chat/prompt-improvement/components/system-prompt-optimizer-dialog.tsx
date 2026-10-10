"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, BookmarkPlus, ChevronLeft, ChevronRight, Loader2, RotateCcw, Sparkles } from "lucide-react";
import type { FC } from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import useOptimizerStyleLabels from "@/features/chat/prompt-improvement/hooks/use-optimizer-style-labels";
import type { SystemOptimizerStyle } from "@/features/chat/prompt-improvement/lib/optimizer-client";
import { iteratePromptRequest, optimizeSystemPromptRequest } from "@/features/chat/prompt-improvement/lib/optimizer-client";
import getSessionToken from "@/lib/auth/server-functions";
import { ErrorUtilities } from "@/lib/errors";
import { useCRPC } from "@/lib/lunora/crpc";

interface SystemPromptOptimizerDialogProps {
    /** Original prompt the user is starting from (often the current customInstructions or thread system prompt). */
    initialPrompt: string;
    /** Optional target model the optimized prompt is for. Passed as context to the optimizer. */
    modelId?: string;

    /**
     * Called when the user accepts an optimized prompt. The dialog closes automatically after.
     * The handler should persist the value.
     */
    onApply: (optimizedPrompt: string) => void | Promise<void>;
    /** Called when the dialog should close. */
    onOpenChange: (open: boolean) => void;
    /** Whether the dialog is open. */
    open: boolean;

    /**
     * Thread ID to associate the optimization with. Defaults to "system-prompt-optimizer" when
     * the dialog is invoked outside a chat thread (e.g. settings page).
     */
    threadId?: string;
    /** Optional dialog title override. */
    title?: string;
}

const STYLE_OPTIONS: SystemOptimizerStyle[] = ["general", "analytical", "output-format"];

type SystemPromptOptimizerDialogBodyProps = Omit<SystemPromptOptimizerDialogProps, "open">;

const SystemPromptOptimizerDialogBody: FC<SystemPromptOptimizerDialogBodyProps> = ({ initialPrompt, modelId, onApply, onOpenChange, threadId, title }) => {
    const { i18n, t } = useLingui();
    const styleLabels = useOptimizerStyleLabels();

    const getJwtToken = useCallback(async (): Promise<string | undefined> => {
        const token = await getSessionToken();

        return token ?? undefined;
    }, []);

    const crpc = useCRPC();
    const { isPending: isCreatingPreset, mutateAsync: createPreset } = useMutation(crpc.system_prompts.functions.createPreset.mutationOptions());

    const [style, setStyle] = useState<SystemOptimizerStyle>("general");
    const [prompt, setPrompt] = useState(initialPrompt);
    const [improvementInstructions, setImprovementInstructions] = useState("");
    const [iterateInput, setIterateInput] = useState("");
    const [optimized, setOptimized] = useState<{ history: string[]; index: number }>({ history: [], index: 0 });
    const [isOptimizing, setIsOptimizing] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const [saveAsPresetOpen, setSaveAsPresetOpen] = useState(false);
    const [presetName, setPresetName] = useState("");

    const { history: optimizedHistory, index: currentIndex } = optimized;
    const currentOptimized = optimizedHistory[currentIndex] ?? "";
    const canGoPrevious = currentIndex > 0;
    const canGoNext = currentIndex < optimizedHistory.length - 1;

    const handleOptimize = useCallback(async () => {
        setError(null);
        setIsOptimizing(true);

        try {
            const jwtToken = await getJwtToken();
            const optimizedPrompt = await optimizeSystemPromptRequest({
                improvementInstructions,
                jwtToken,
                modelId,
                prompt,
                style,
                threadId,
            });

            setOptimized((state) => {
                return { history: [...state.history, optimizedPrompt], index: state.history.length };
            });
        } catch (error_: any) {
            setError(error_);
        }

        setIsOptimizing(false);
    }, [getJwtToken, improvementInstructions, modelId, prompt, style, threadId]);

    const handleIterate = useCallback(async () => {
        if (!currentOptimized.trim() || !iterateInput.trim()) {
            return;
        }

        setError(null);
        setIsOptimizing(true);

        try {
            const jwtToken = await getJwtToken();
            const refined = await iteratePromptRequest({
                iterateInput,
                jwtToken,
                lastOptimizedPrompt: currentOptimized,
                mode: "system",
                threadId,
            });

            setOptimized((state) => {
                return { history: [...state.history, refined], index: state.history.length };
            });
            setIterateInput("");
        } catch (error_: any) {
            setError(error_);
        }

        setIsOptimizing(false);
    }, [currentOptimized, getJwtToken, iterateInput, threadId]);

    const handleApply = useCallback(async () => {
        if (!currentOptimized.trim()) {
            return;
        }

        try {
            await onApply(currentOptimized);
            toast.success(t`System prompt applied`);
            onOpenChange(false);
        } catch {
            toast.error(t`Failed to apply system prompt`);
        }
    }, [currentOptimized, onApply, onOpenChange, t]);

    const handleSaveAsPreset = useCallback(async () => {
        const trimmedName = presetName.trim();

        if (!trimmedName || !currentOptimized.trim()) {
            return;
        }

        try {
            await createPreset({
                modelId: modelId || undefined,
                name: trimmedName,
                prompt: currentOptimized,
            });
            toast.success(t`Saved as preset`);
            setSaveAsPresetOpen(false);
            setPresetName("");
        } catch (error_: any) {
            toast.error(error_?.message ?? t`Failed to save preset`);
        }
    }, [createPreset, currentOptimized, modelId, presetName, t]);

    return (
        <>
            <DialogHeader>
                <DialogTitle>{title ?? t`Optimize system prompt`}</DialogTitle>
                <DialogDescription>
                    {t`Rewrites your system prompt using a structured template (role, rules, workflows). The model treats your input as evidence to optimize, not as a task to execute.`}
                </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
                {error && (
                    <div
                        className="bg-destructive/10 border-destructive/20 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                        role="alert"
                    >
                        <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
                        <span>{ErrorUtilities.getUserMessage(error, i18n)}</span>
                    </div>
                )}

                <div className="space-y-2">
                    <Label htmlFor="system-prompt-style">{t`Optimization style`}</Label>
                    <Select<SystemOptimizerStyle>
                        onValueChange={(value) => {
                            if (value) {
                                setStyle(value);
                            }
                        }}
                        value={style}
                    >
                        <SelectTrigger id="system-prompt-style">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {STYLE_OPTIONS.map((option) => (
                                <SelectItem key={option} value={option}>
                                    <div className="flex flex-col">
                                        <span>{styleLabels.system[option].label}</span>
                                        <span className="text-muted-foreground text-xs">{styleLabels.system[option].description}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="system-prompt-input">{t`Original system prompt`}</Label>
                    <Textarea
                        className="min-h-32"
                        disabled={isOptimizing}
                        id="system-prompt-input"
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder={t`Paste or write a system prompt to optimize...`}
                        value={prompt}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="system-prompt-instructions">{t`Optimization notes (optional)`}</Label>
                    <Textarea
                        disabled={isOptimizing}
                        id="system-prompt-instructions"
                        onChange={(e) => setImprovementInstructions(e.target.value)}
                        placeholder={t`e.g., Emphasize concise outputs, target a beginner audience...`}
                        value={improvementInstructions}
                    />
                </div>

                {optimizedHistory.length > 0 && (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="system-prompt-output">{t`Optimized prompt`}</Label>
                            {optimizedHistory.length > 1 && (
                                <div className="flex items-center gap-2">
                                    <Button
                                        aria-label={t`Previous version`}
                                        disabled={!canGoPrevious || isOptimizing}
                                        onClick={() =>
                                            setOptimized((state) => {
                                                return { ...state, index: Math.max(0, state.index - 1) };
                                            })
                                        }
                                        size="sm"
                                        variant="ghost"
                                    >
                                        <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                                    </Button>
                                    <span className="text-muted-foreground text-xs">
                                        {currentIndex + 1} /{optimizedHistory.length}
                                    </span>
                                    <Button
                                        aria-label={t`Next version`}
                                        disabled={!canGoNext || isOptimizing}
                                        onClick={() =>
                                            setOptimized((state) => {
                                                return { ...state, index: Math.min(state.history.length - 1, state.index + 1) };
                                            })
                                        }
                                        size="sm"
                                        variant="ghost"
                                    >
                                        <ChevronRight aria-hidden="true" className="h-4 w-4" />
                                    </Button>
                                </div>
                            )}
                        </div>
                        <Textarea
                            className="min-h-48"
                            disabled={isOptimizing}
                            id="system-prompt-output"
                            onChange={(e) =>
                                setOptimized((state) => {
                                    const history = [...state.history];

                                    history[state.index] = e.target.value;

                                    return { ...state, history };
                                })
                            }
                            value={currentOptimized}
                        />

                        <div className="space-y-2 pt-1">
                            <Label className="text-muted-foreground text-xs" htmlFor="system-iterate-input">
                                {t`Refine with feedback (optional)`}
                            </Label>
                            <div className="flex items-start gap-2">
                                <Textarea
                                    className="min-h-12"
                                    disabled={isOptimizing}
                                    id="system-iterate-input"
                                    onChange={(e) => setIterateInput(e.target.value)}
                                    placeholder={t`e.g., Make it more concise, require markdown output, add safety rules...`}
                                    value={iterateInput}
                                />
                                <Button
                                    disabled={isOptimizing || !iterateInput.trim() || !currentOptimized.trim()}
                                    onClick={handleIterate}
                                    size="sm"
                                    variant="outline"
                                >
                                    <RotateCcw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                                    {t`Refine`}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {saveAsPresetOpen && optimizedHistory.length > 0 && (
                    <div className="bg-muted/50 space-y-2 rounded-md border p-3">
                        <Label className="text-xs" htmlFor="save-as-preset-name">
                            {t`Preset name`}
                        </Label>
                        <div className="flex items-center gap-2">
                            <Input
                                autoFocus
                                id="save-as-preset-name"
                                maxLength={80}
                                onChange={(e) => setPresetName(e.target.value)}
                                onKeyDown={(e) => {
                                    // Enter also confirms an IME candidate; ignore it mid-composition.
                                    if (e.nativeEvent.isComposing) {
                                        return;
                                    }

                                    if (e.key === "Enter" && presetName.trim()) {
                                        e.preventDefault();
                                        void handleSaveAsPreset();
                                    }
                                }}
                                placeholder={t`e.g., Strict JSON coder`}
                                type="text"
                                value={presetName}
                            />
                            <Button disabled={isCreatingPreset || !presetName.trim()} onClick={handleSaveAsPreset} size="sm" type="button">
                                {isCreatingPreset ? t`Saving...` : t`Save`}
                            </Button>
                            <Button
                                onClick={() => {
                                    setSaveAsPresetOpen(false);
                                    setPresetName("");
                                }}
                                size="sm"
                                type="button"
                                variant="ghost"
                            >
                                {t`Cancel`}
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
                <Button onClick={() => onOpenChange(false)} variant="ghost">
                    {t`Cancel`}
                </Button>
                {optimizedHistory.length > 0 && !saveAsPresetOpen && (
                    <Button
                        disabled={isOptimizing || !currentOptimized.trim()}
                        onClick={() => setSaveAsPresetOpen(true)}
                        size="default"
                        type="button"
                        variant="outline"
                    >
                        <BookmarkPlus aria-hidden="true" className="mr-2 h-4 w-4" />
                        {t`Save as preset`}
                    </Button>
                )}
                {optimizedHistory.length > 0 && (
                    <Button disabled={isOptimizing || !currentOptimized.trim()} onClick={handleApply} variant="outline">
                        {t`Apply`}
                    </Button>
                )}
                <Button disabled={isOptimizing || !prompt.trim()} onClick={handleOptimize}>
                    {isOptimizing ? (
                        <>
                            <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
                            {t`Optimizing...`}
                        </>
                    ) : (
                        <>
                            <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />
                            {optimizedHistory.length > 0 ? t`Re-optimize` : t`Optimize`}
                        </>
                    )}
                </Button>
            </DialogFooter>
        </>
    );
};

const SystemPromptOptimizerDialog: FC<SystemPromptOptimizerDialogProps> = ({ initialPrompt, modelId, onApply, onOpenChange, open, threadId, title }) => (
    <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
            <SystemPromptOptimizerDialogBody
                initialPrompt={initialPrompt}
                key={`${String(open)}|${initialPrompt}`}
                modelId={modelId}
                onApply={onApply}
                onOpenChange={onOpenChange}
                threadId={threadId}
                title={title}
            />
        </DialogContent>
    </Dialog>
);

export default SystemPromptOptimizerDialog;
