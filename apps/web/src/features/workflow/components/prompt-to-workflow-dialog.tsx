/**
 * Prompt-to-Workflow Dialog
 *
 * AI-powered dialog that generates a complete workflow from a natural language
 * description. Uses the `generateWorkflowFromPrompt` Lunora action.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@ui/components/responsive-dialog";
import { Textarea } from "@ui/components/textarea";
import { useReactFlow } from "@xyflow/react";
import { Loader2, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";

import { useAction } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../stores/workflow-store";
import type { WorkflowContent } from "../types";

/** Shown in the viewer's language; a clicked example becomes the prompt the user sends. */
const EXAMPLE_PROMPTS: MessageDescriptor[] = [
    msg`Generate an image from a text prompt and upscale it to 4x`,
    msg`Take an input image, remove the background, then apply style transfer`,
    msg`Transcribe an audio file, summarize the text with AI, then convert back to speech`,
    msg`Generate 4 images with different models and compare them side by side`,
    msg`Process a text file with AI to extract key points, then generate an image based on the summary`,
];

const PromptToWorkflowDialog = () => {
    const { i18n, t } = useLingui();
    const [isOpen, setIsOpen] = useState(false);
    const [prompt, setPrompt] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadContent = useWorkflowStore((state) => state.loadContent);
    const { fitView } = useReactFlow();
    const generateWorkflow = useAction(api.workflow.generate.generateWorkflowFromPrompt);

    const handleGenerate = useCallback(async () => {
        if (!prompt.trim() || isGenerating) return;

        setIsGenerating(true);
        setError(null);

        try {
            const result = await generateWorkflow({ prompt: prompt.trim() });

            if (result && result.nodes && result.edges) {
                loadContent({
                    edges: result.edges as WorkflowContent["edges"],
                    nodes: result.nodes as WorkflowContent["nodes"],
                    viewport: (result as { viewport?: WorkflowContent["viewport"] }).viewport,
                });
                setIsOpen(false);
                setPrompt("");
                requestAnimationFrame(() => {
                    fitView({ duration: 400, padding: 0.15 });
                });
            }
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : t`Failed to generate workflow`);
        }

        setIsGenerating(false);
    }, [prompt, isGenerating, generateWorkflow, loadContent, fitView, t]);

    const handleExampleClick = (example: string) => {
        setPrompt(example);
    };

    return (
        <Dialog onOpenChange={setIsOpen} open={isOpen}>
            <DialogTrigger
                render={
                    <Button className="gap-2" size="sm" variant="outline">
                        <Sparkles className="size-4" />
                        <Trans>AI Generate</Trans>
                    </Button>
                }
            />
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        <Trans>Generate Workflow with AI</Trans>
                    </DialogTitle>
                    <DialogDescription>
                        <Trans>Describe what you want your workflow to do and AI will generate the nodes and connections for you.</Trans>
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div>
                        <Textarea
                            autoFocus
                            disabled={isGenerating}
                            onChange={(e) => setPrompt(e.target.value)}
                            onKeyDown={(e) => {
                                if (!(e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
                                    return;
                                }

                                e.preventDefault();
                                handleGenerate();
                            }}
                            placeholder={t`Describe your workflow... e.g., 'Generate an image from text, upscale it, then remove the background'`}
                            rows={3}
                            value={prompt}
                        />
                    </div>

                    {error && <div className="text-destructive rounded bg-red-500/10 p-2 text-xs">{error}</div>}

                    <div>
                        <p className="text-muted-foreground mb-2 text-xs font-medium">
                            <Trans>Examples:</Trans>
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                            {EXAMPLE_PROMPTS.map((descriptor) => {
                                const example = i18n._(descriptor);

                                return (
                                    <button
                                        className="bg-muted hover:bg-muted/80 rounded-full px-2.5 py-1 text-[11px] transition-colors"
                                        disabled={isGenerating}
                                        key={descriptor.id}
                                        onClick={() => handleExampleClick(example)}
                                        type="button"
                                    >
                                        {example.length > 50 ? `${example.slice(0, 50)}...` : example}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button disabled={isGenerating} onClick={() => setIsOpen(false)} variant="ghost">
                            <Trans>Cancel</Trans>
                        </Button>
                        <Button disabled={!prompt.trim() || isGenerating} onClick={handleGenerate}>
                            {isGenerating ? (
                                <>
                                    <Loader2 className="mr-1.5 size-4 animate-spin" />
                                    <Trans>Generating...</Trans>
                                </>
                            ) : (
                                <>
                                    <Sparkles className="mr-1.5 size-4" />
                                    <Trans>Generate</Trans>
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default PromptToWorkflowDialog;
