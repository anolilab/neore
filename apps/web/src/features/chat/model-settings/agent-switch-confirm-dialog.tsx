"use client";

import { useLingui } from "@lingui/react/macro";
import { estimateInputCostMicrodollars } from "@neore/ai/models";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@neore/ui/components/alert-dialog";
import { Button } from "@neore/ui/components/button";
import type { FC } from "react";

import { formatCredits } from "@/features/chat/thread/format-cost";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

export interface PendingAgentSwitch {
    model: string;
    preview: { contextTokens: number; defaultMode: "full" | "portable"; handoffTokens: number };
}

interface AgentSwitchConfirmDialogProps {
    onCancel: () => void;
    onConfirm: (mode: "full" | "portable") => void;
    pending: PendingAgentSwitch | null;
}

/**
 * Asked before the divider is written, on a conversation long enough that the new model reads it cold:
 * what the next reply costs if the whole history is kept, and what it costs after a handoff (a summary of
 * the older turns and the recent ones verbatim). The figures are the floor — input tokens at the target's
 * price — and say nothing of a provider's cache-write surcharge.
 */
const AgentSwitchConfirmDialog: FC<AgentSwitchConfirmDialogProps> = ({ onCancel, onConfirm, pending }) => {
    const { i18n, t } = useLingui();
    const models = useFeatureFlaggedModels();
    const target = models.find((candidate) => candidate.id === pending?.model);
    const price = target?.pricing?.input_per_million;
    const creditsFor = (tokens: number): string | null =>
        price === undefined ? null : `~${formatCredits(estimateInputCostMicrodollars(tokens, price), i18n.locale)}`;
    const name = target?.name ?? pending?.model ?? "";
    const full = pending ? creditsFor(pending.preview.contextTokens) : null;
    const handoff = pending ? creditsFor(pending.preview.handoffTokens) : null;

    return (
        <AlertDialog onOpenChange={(open) => !open && onCancel()} open={pending !== null}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{t`Switch to ${name}?`}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {t`This conversation is long. ${name} has not seen it, so its next reply reads it without the cache and costs more than usual.`}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {pending ? (
                    <dl className="text-sm">
                        <div className="flex justify-between gap-4 py-1">
                            <dt>{t`Hand over a summary and the recent messages`}</dt>
                            <dd className="text-foreground font-medium tabular-nums">{handoff === null ? t`n/a` : t`${handoff} credits`}</dd>
                        </div>
                        <div className="flex justify-between gap-4 py-1">
                            <dt>{t`Keep the full history`}</dt>
                            <dd className="text-foreground font-medium tabular-nums">{full === null ? t`n/a` : t`${full} credits`}</dd>
                        </div>
                    </dl>
                ) : null}
                <AlertDialogFooter>
                    <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
                    <Button onClick={() => onConfirm("full")} variant="outline">
                        {t`Keep full history`}
                    </Button>
                    <Button onClick={() => onConfirm("portable")}>{t`Hand over a summary`}</Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
};

export default AgentSwitchConfirmDialog;
