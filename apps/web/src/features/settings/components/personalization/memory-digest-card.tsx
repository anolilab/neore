"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Heading } from "@neore/ui/components/heading";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon, XIcon } from "lucide-react";
import type { FC } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import { isMemoryType, MEMORY_TYPE_COLORS, useMemoryTypeLabels } from "./memory-types";

/**
 * The newest nightly-reflection digest ("what I learned today") the user has not
 * dismissed, from `memory_reflection.getLatestMemoryDigest`. Renders nothing when
 * there is none.
 */
const MemoryDigestCard: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const typeLabels = useMemoryTypeLabels();
    const digestQuery = crpc.memory.reflection.getLatestMemoryDigest.queryOptions({});
    const { data: digest } = useQuery(digestQuery);

    const { isPending, mutate: dismiss } = useMutation({
        ...crpc.memory.reflection.dismissMemoryDigest.mutationOptions(),
        onError: () => {
            toast.error(t`Failed to dismiss the digest`);
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: digestQuery.queryKey });
        },
    });

    if (!digest) {
        return null;
    }

    const { stats } = digest;
    // Shown when the model wrote no summary (it was unavailable or over budget).
    const fallbackSummary = t`${stats.newMemories} new, ${stats.merged} merged, ${stats.promoted} promoted, ${stats.contradictionsResolved} contradictions resolved, ${stats.decayed + stats.retired} faded.`;

    return (
        <section aria-labelledby="memory-digest-title" className="bg-muted/40 relative space-y-2 rounded-md border p-3">
            <div className="flex items-start justify-between gap-2">
                <Heading className="flex items-center gap-1.5 text-sm font-medium" fallbackLevel={3} id="memory-digest-title">
                    <SparklesIcon aria-hidden="true" className="text-muted-foreground size-4" />
                    {t`What I learned (${digest.localDay})`}
                </Heading>
                <Button aria-label={t`Dismiss digest`} disabled={isPending} onClick={() => dismiss({ digestId: digest._id })} size="icon-sm" variant="ghost">
                    <XIcon aria-hidden="true" className="size-3.5" />
                </Button>
            </div>
            <p className="text-sm leading-snug">{digest.summary || fallbackSummary}</p>
            {digest.learned.length > 0 && (
                <ul className="space-y-1">
                    {digest.learned.map((item) => (
                        <li className="flex items-start gap-1.5 text-xs" key={item.memoryId}>
                            {isMemoryType(item.type) && (
                                <Badge className={`shrink-0 px-1.5 py-0 text-[10px] ${MEMORY_TYPE_COLORS[item.type]}`} variant="secondary">
                                    {typeLabels[item.type]}
                                </Badge>
                            )}
                            <span>{item.memory}</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};

export default MemoryDigestCard;
