"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import type { JSONContent } from "@tiptap/core";
import type { FC } from "react";
import { lazy, Suspense, useId, useState } from "react";

import { useAction } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import { stripCommentMarks } from "../lib/comment-mark";

const CanvasTextDiffViewer = lazy(() => import("@/features/canvas/components/canvas-text-diff-viewer"));

const EMPTY_DOC: JSONContent = { content: [], type: "doc" };

interface PageAgentDialogProps {
    currentJson: () => JSONContent | undefined;
    markdownToJSON: (markdown: string) => JSONContent | null;
    onApply: (proposal: { json: JSONContent; markdown: string }) => Promise<void>;
    onClose: () => void;
    open: boolean;
    pageId: string;
}

/**
 * The Page agent: describe a change, review the AI's rewrite in the canvas diff
 * viewer, then apply or discard. Nothing is written until "Apply".
 */
const PageAgentDialogBody: FC<Omit<PageAgentDialogProps, "open">> = ({ currentJson, markdownToJSON, onApply, onClose, pageId }) => {
    const { t } = useLingui();
    const id = useId();
    const proposePageEdit = useAction(api.pages.agent.proposePageEdit);
    const [instruction, setInstruction] = useState("");
    const [pending, setPending] = useState(false);
    const [proposal, setProposal] = useState<{ json: JSONContent; markdown: string } | null>(null);

    let liveStatus = "";

    if (pending) {
        liveStatus = t`Working…`;
    } else if (proposal) {
        liveStatus = t`Proposed changes ready for review`;
    }

    const handlePropose = async () => {
        setPending(true);

        try {
            const { proposedMarkdown } = await proposePageEdit({ instruction, pageId: pageId as never });
            const json = markdownToJSON(proposedMarkdown);

            if (!json) {
                throw new Error(t`The editor is not ready yet`);
            }

            setProposal({ json, markdown: proposedMarkdown });
        } catch (error) {
            showError(error instanceof Error ? error : t`The page agent could not edit this page`);
        } finally {
            setPending(false);
        }
    };

    const handleApply = async () => {
        if (!proposal) {
            return;
        }

        setPending(true);

        try {
            await onApply(proposal);
            onClose();
        } catch (error) {
            showError(error instanceof Error ? error : t`Could not apply the changes`);
        } finally {
            setPending(false);
        }
    };

    return (
        <DialogContent className="max-w-4xl">
            <DialogHeader>
                <DialogTitle>{t`Page agent`}</DialogTitle>
                <DialogDescription>{t`Describe a change. You review the result before anything is saved; applying it creates a version you can restore.`}</DialogDescription>
            </DialogHeader>
            <form
                className="contents"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();

                    if (proposal) {
                        void handleApply();
                    } else if (instruction.trim()) {
                        void handlePropose();
                    }
                }}
            >
                <DialogPanel>
                    {proposal ? (
                        <div className="h-[60vh] overflow-hidden rounded-md border">
                            <Suspense
                                fallback={
                                    <p className="text-muted-foreground p-3 text-xs" role="status">
                                        {t`Loading comparison…`}
                                    </p>
                                }
                            >
                                <CanvasTextDiffViewer commit={{ doc: proposal.json, parent: stripCommentMarks(currentJson() ?? EMPTY_DOC), steps: [] }} />
                            </Suspense>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <Label htmlFor={id}>{t`What should change?`}</Label>
                            <Textarea
                                id={id}
                                maxLength={2000}
                                onChange={(event) => setInstruction(event.target.value)}
                                placeholder={t`e.g. Tighten the introduction and add a summary at the end`}
                                value={instruction}
                            />
                        </div>
                    )}
                    <p aria-live="polite" className="sr-only" role="status">
                        {liveStatus}
                    </p>
                </DialogPanel>
                <DialogFooter>
                    {proposal ? (
                        <>
                            <Button disabled={pending} onClick={() => setProposal(null)} type="button" variant="outline">
                                {t`Discard`}
                            </Button>
                            <Button aria-busy={pending} disabled={pending} type="submit">
                                {t`Apply changes`}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button onClick={onClose} type="button" variant="outline">
                                {t`Cancel`}
                            </Button>
                            <Button aria-busy={pending} disabled={pending || !instruction.trim()} type="submit">
                                {pending ? t`Thinking…` : t`Propose changes`}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </form>
        </DialogContent>
    );
};

const PageAgentDialog: FC<PageAgentDialogProps> = ({ open, ...props }) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <PageAgentDialogBody {...props} />}
    </Dialog>
);

export default PageAgentDialog;
