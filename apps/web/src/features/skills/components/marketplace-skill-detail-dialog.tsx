"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Skeleton } from "@neore/ui/components/skeleton";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, GitFork, Loader2, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import { formatRating, functionQueryPrefix } from "../lib/marketplace";
import StarRatingInput from "./star-rating-input";

interface MarketplaceSkillDetailDialogProps {
    onClose: () => void;
    /** Called after a fork, so the caller can refresh the user's own skill list. */
    onForked?: () => void;
    skillId: Id<"skills"> | null;
}

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

const MarketplaceSkillDetailDialog = ({ onClose, onForked, skillId }: MarketplaceSkillDetailDialogProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    const detailQuery = crpc.skills.marketplace.getSkillDetail;
    const { data: skill, error, isPending } = useQuery(detailQuery.queryOptions(skillId ? { skillId } : skipToken));

    // Lunora query results never go stale on their own (`staleTime: Infinity`),
    // so every write refetches the detail and — for ratings — the result cards.
    const refresh = async () => {
        // The args are irrelevant — only the function part of each key is kept.
        const prefixes = [
            detailQuery.queryKey({ skillId: skillId ?? ("" as Id<"skills">) }),
            crpc.skills.marketplace.browseSkills.queryKey({}),
            crpc.skills.marketplace.searchSkills.queryKey({ query: "" }),
        ].map((queryKey) => functionQueryPrefix(queryKey));

        await Promise.all(prefixes.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    };

    const install = useMutation(
        crpc.skills.marketplace.installSkill.mutationOptions({
            onError: (mutationError: Error) => toast.error(errorMessage(mutationError, t`Failed to install skill`)),
            onSuccess: async () => {
                toast.success(t`Skill installed — use it with /${skill?.slug ?? ""}`);
                await refresh();
            },
        }),
    );
    const uninstall = useMutation(
        crpc.skills.marketplace.uninstallSkill.mutationOptions({
            onError: (mutationError: Error) => toast.error(errorMessage(mutationError, t`Failed to remove skill`)),
            onSuccess: async () => {
                toast.success(t`Skill removed`);
                await refresh();
            },
        }),
    );
    const fork = useMutation(
        crpc.skills.marketplace.forkSkill.mutationOptions({
            onError: (mutationError: Error) => toast.error(errorMessage(mutationError, t`Failed to fork skill`)),
            onSuccess: () => {
                toast.success(t`Forked — the copy is in My skills, ready to edit.`);
                onForked?.();
                onClose();
            },
        }),
    );
    const rate = useMutation(
        crpc.skills.marketplace.rateSkill.mutationOptions({
            onError: (mutationError: Error) => toast.error(errorMessage(mutationError, t`Failed to save rating`)),
            onSuccess: async () => {
                toast.success(t`Thanks for rating`);
                await refresh();
            },
        }),
    );

    const isBusy = install.isPending || uninstall.isPending || fork.isPending;

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={skillId !== null}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{skill ? skill.name : t`Skill details`}</DialogTitle>
                    <DialogDescription>{skill ? skill.description : t`Loading skill details…`}</DialogDescription>
                </DialogHeader>
                <DialogPanel className="max-h-[60vh] min-h-0 flex-1 overflow-y-auto">
                    {isPending && skillId && (
                        <div aria-busy="true" className="space-y-3" role="status">
                            <span className="sr-only">{t`Loading skill details…`}</span>
                            <Skeleton className="h-4 w-1/3" />
                            <Skeleton className="h-32 w-full" />
                        </div>
                    )}
                    {error && (
                        <p className="text-destructive text-sm" role="alert">
                            {errorMessage(error, t`This skill is no longer available.`)}
                        </p>
                    )}
                    {skill && (
                        <div className="space-y-5">
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">/{skill.slug}</code>
                                {skill.category && <Badge variant="secondary">{skill.category}</Badge>}
                                {skill.tags?.map((tag) => (
                                    <Badge key={tag} variant="outline">
                                        {tag}
                                    </Badge>
                                ))}
                            </div>

                            <dl className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-sm">
                                <div className="flex items-center gap-1">
                                    <dt className="sr-only">{t`Rating`}</dt>
                                    <Star aria-hidden="true" className="size-4 fill-amber-400 text-amber-400" />
                                    <dd>{skill.ratingCount > 0 ? t`${formatRating(skill.rating)} from ${skill.ratingCount} ratings` : t`No ratings yet`}</dd>
                                </div>
                                <div className="flex items-center gap-1">
                                    <dt>{t`Used`}</dt>
                                    <dd>{t`${skill.usageCount} times`}</dd>
                                </div>
                            </dl>

                            {(skill.config?.additionalTools?.length ?? 0) > 0 && (
                                <div className="space-y-1">
                                    <h3 className="text-sm font-medium">{t`Tools`}</h3>
                                    <p className="text-muted-foreground font-mono text-xs">{skill.config?.additionalTools?.join(", ")}</p>
                                </div>
                            )}

                            {(skill.variables?.length ?? 0) > 0 && (
                                <div className="space-y-1">
                                    <h3 className="text-sm font-medium">{t`Variables`}</h3>
                                    <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
                                        {skill.variables?.map((variable) => (
                                            <li key={variable.name}>
                                                <code>{`{{${variable.name}}}`}</code>
                                                {variable.required && ` (${t`required`})`}
                                                {variable.description && ` — ${variable.description}`}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            <div className="space-y-1">
                                <h3 className="text-sm font-medium">{t`Instructions`}</h3>
                                <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{skill.instructions}</pre>
                            </div>

                            {!skill.isOwner && (
                                <StarRatingInput
                                    disabled={rate.isPending}
                                    legend={skill.myRating === null ? t`Rate this skill` : t`Your rating`}
                                    onChange={(rating) => rate.mutate({ rating, skillId: skill._id })}
                                    value={skill.myRating}
                                />
                            )}
                        </div>
                    )}
                </DialogPanel>
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="outline">
                        {t`Close`}
                    </Button>
                    {skill && (
                        <>
                            <Button
                                aria-busy={fork.isPending}
                                disabled={isBusy}
                                onClick={() => fork.mutate({ skillId: skill._id })}
                                type="button"
                                variant="secondary"
                            >
                                {fork.isPending ? (
                                    <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
                                ) : (
                                    <GitFork aria-hidden="true" className="mr-2 size-4" />
                                )}
                                {t`Fork`}
                            </Button>
                            {!skill.isOwner && skill.isInstalled && (
                                <Button
                                    aria-busy={uninstall.isPending}
                                    disabled={isBusy}
                                    onClick={() => uninstall.mutate({ skillId: skill._id })}
                                    type="button"
                                    variant="outline"
                                >
                                    {uninstall.isPending ? (
                                        <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
                                    ) : (
                                        <Trash2 aria-hidden="true" className="mr-2 size-4" />
                                    )}
                                    {t`Remove`}
                                </Button>
                            )}
                            {!skill.isOwner && !skill.isInstalled && (
                                <Button aria-busy={install.isPending} disabled={isBusy} onClick={() => install.mutate({ skillId: skill._id })} type="button">
                                    {install.isPending ? (
                                        <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
                                    ) : (
                                        <Download aria-hidden="true" className="mr-2 size-4" />
                                    )}
                                    {t`Install`}
                                </Button>
                            )}
                            {skill.isInstalled && !skill.isOwner && (
                                <span className="text-muted-foreground inline-flex items-center gap-1 self-center text-xs">
                                    <Check aria-hidden="true" className="size-3" />
                                    {t`Installed`}
                                </span>
                            )}
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default MarketplaceSkillDetailDialog;
