"use client";

import { useLingui } from "@lingui/react/macro";
import type { Doc } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { AlertCircle, Check, Loader2, Sparkles, X } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import getSessionToken from "@/lib/auth/server-functions";
import env from "@/lib/env";

/** Prompt optimization endpoint — routed through the LLM Gateway */
const OPTIMIZE_PROMPT_URL = `${env.VITE_LLM_GATEWAY_URL}/v1/prompts/optimize`;

interface PromptOptimizeDialogProps {
    onClose: () => void;
    onOptimized: (optimizedContent: string) => Promise<void>;
    open: boolean;
    prompt: Doc<"prompts">;
}

const PromptOptimizeDialog = ({ onClose, onOptimized, open, prompt }: PromptOptimizeDialogProps) => {
    const { t } = useLingui();
    const [isOptimizing, setIsOptimizing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [improvementInstructions, setImprovementInstructions] = useState("");
    const [optimizedContent, setOptimizedContent] = useState<string | null>(null);
    const [isApplying, setIsApplying] = useState(false);

    // Reset state when the dialog opens. Done during render rather than in an
    // effect so the dialog never paints one frame carrying the previous run's
    // result before it is cleared.
    const [wasOpen, setWasOpen] = useState(open);

    if (open !== wasOpen) {
        setWasOpen(open);

        if (open) {
            setOptimizedContent(null);
            setImprovementInstructions("");
            setError(null);
            setIsOptimizing(false);
        }
    }

    const handleOptimize = useCallback(async () => {
        setError(null);
        setIsOptimizing(true);

        try {
            const token = await getSessionToken();
            const jwtToken = token ?? undefined;

            const response = await fetch(OPTIMIZE_PROMPT_URL, {
                body: JSON.stringify({
                    content: prompt.content,
                    improvementInstructions: improvementInstructions.trim() || undefined,
                }),
                headers: {
                    "Content-Type": "application/json",
                    ...(jwtToken && { Authorization: `Bearer ${jwtToken}` }),
                },
                method: "POST",
            });

            if (!response.ok) {
                const errorData = (await response.json().catch(() => {
                    return {};
                })) as { error?: string };

                if (response.status === 429) {
                    throw new Error(errorData.error || t`Rate limit exceeded. Please try again later.`);
                }

                throw new Error(errorData.error || t`Failed to optimize prompt`);
            }

            const data = (await response.json()) as { optimizedPrompt?: string };

            if (!data.optimizedPrompt) {
                throw new Error(t`No optimized prompt received`);
            }

            setOptimizedContent(data.optimizedPrompt);
            toast.success(t`Prompt optimized successfully`);
        } catch (error_) {
            const message = error_ instanceof Error ? error_.message : t`Failed to optimize prompt`;

            setError(message);
            toast.error(message);
        } finally {
            setIsOptimizing(false);
        }
    }, [prompt.content, improvementInstructions, t]);

    const handleApply = useCallback(async () => {
        if (!optimizedContent) {
            return;
        }

        setIsApplying(true);

        try {
            await onOptimized(optimizedContent);
            toast.success(t`Prompt updated with optimized content`);
            onClose();
        } catch {
            toast.error(t`Failed to update prompt`);
        } finally {
            setIsApplying(false);
        }
    }, [optimizedContent, onOptimized, onClose, t]);

    const handleReject = useCallback(() => {
        setOptimizedContent(null);
        setImprovementInstructions("");
        toast.info(t`Optimization rejected`);
    }, [t]);

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="size-5" />
                        {t`Optimize Prompt`}
                    </DialogTitle>
                    <DialogDescription>
                        {optimizedContent
                            ? t`Review the optimized prompt below. You can apply it to update your prompt or reject it to try again.`
                            : t`Use AI to optimize your prompt for better results. Optionally provide specific instructions for how you'd like it improved.`}
                    </DialogDescription>
                </DialogHeader>

                <DialogPanel>
                    <div className="space-y-4">
                        {error && (
                            <div className="bg-destructive/10 border-destructive/20 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                                <AlertCircle className="size-4 flex-shrink-0" />
                                <span>{error}</span>
                            </div>
                        )}

                        {/* Original prompt */}
                        <div className="space-y-2">
                            <Label>{t`Original Prompt`}</Label>
                            <div className="bg-muted max-h-40 overflow-y-auto rounded-md p-3">
                                <p className="text-sm whitespace-pre-wrap">{prompt.content}</p>
                            </div>
                        </div>

                        {/* Improvement instructions (only show before optimization) */}
                        {!optimizedContent && (
                            <div className="space-y-2">
                                <Label htmlFor="improvement-instructions">
                                    {t`Optimization Instructions`} ({t`optional`})
                                </Label>
                                <Textarea
                                    disabled={isOptimizing}
                                    id="improvement-instructions"
                                    onChange={(e) => setImprovementInstructions(e.target.value)}
                                    placeholder={t`e.g., Make it more concise, add technical details, improve clarity, add examples...`}
                                    value={improvementInstructions}
                                />
                            </div>
                        )}

                        {/* Optimized prompt preview */}
                        {optimizedContent && (
                            <div className="space-y-2">
                                <Label className="text-primary flex items-center gap-2">
                                    <Sparkles className="size-4" />
                                    {t`Optimized Prompt`}
                                </Label>
                                <div className="border-primary/30 bg-primary/5 max-h-60 overflow-y-auto rounded-md border p-3">
                                    <Textarea
                                        className="border-0 bg-transparent p-0 focus-visible:ring-0"
                                        onChange={(e) => setOptimizedContent(e.target.value)}
                                        value={optimizedContent}
                                    />
                                </div>
                                <p className="text-muted-foreground text-xs">{t`You can edit the optimized prompt before applying it.`}</p>
                            </div>
                        )}
                    </div>
                </DialogPanel>

                <DialogFooter>
                    <Button onClick={onClose} variant="outline">
                        {t`Cancel`}
                    </Button>

                    {optimizedContent ? (
                        <>
                            <Button onClick={handleReject} variant="secondary">
                                <X className="mr-2 size-4" />
                                {t`Reject`}
                            </Button>
                            <Button disabled={isApplying} onClick={handleApply}>
                                {isApplying ? (
                                    <>
                                        <Loader2 className="mr-2 size-4 animate-spin" />
                                        {t`Applying...`}
                                    </>
                                ) : (
                                    <>
                                        <Check className="mr-2 size-4" />
                                        {t`Apply`}
                                    </>
                                )}
                            </Button>
                        </>
                    ) : (
                        <Button disabled={isOptimizing} onClick={handleOptimize}>
                            {isOptimizing ? (
                                <>
                                    <Loader2 className="mr-2 size-4 animate-spin" />
                                    {t`Optimizing...`}
                                </>
                            ) : (
                                <>
                                    <Sparkles className="mr-2 size-4" />
                                    {t`Optimize`}
                                </>
                            )}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default PromptOptimizeDialog;
