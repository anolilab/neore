"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@neore/ui/components/popover";
import { useQuery } from "@tanstack/react-query";
import { BrainIcon } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import { MEMORY_TYPE_COLORS, useMemoryTypeLabels } from "@/features/settings/components/personalization/memory-types";
import { useCRPC } from "@/lib/lunora/crpc";

interface MemoryUsageActionProps {
    /** From the UI message's `memoryUsage`. */
    usage: { count: number; messageId: string };
}

/**
 * Answers "why was this used": which memories were injected into this reply's
 * prompt, with their retrieval score and what has become of them since. Loaded
 * only when opened.
 */
const MemoryUsageAction: FC<MemoryUsageActionProps> = ({ usage }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const typeLabels = useMemoryTypeLabels();
    const [open, setOpen] = useState(false);
    const { data, isError, isLoading } = useQuery({
        ...crpc.memory.functions.getMessageMemoryUsage.queryOptions({ messageId: usage.messageId }),
        enabled: open,
    });

    return (
        <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger render={<Button aria-label={t`Memories used for this reply (${usage.count})`} size="icon-sm" type="button" variant="ghost" />}>
                <BrainIcon aria-hidden="true" className="size-4" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80">
                <PopoverHeader>
                    <PopoverTitle>{t`Memories used`}</PopoverTitle>
                    <PopoverDescription>{t`These memories were added to the AI's context for this reply because they matched your message.`}</PopoverDescription>
                </PopoverHeader>
                <div aria-live="polite" role="status">
                    {isLoading && <p className="text-muted-foreground">{t`Loading…`}</p>}
                    {isError && <p className="text-destructive">{t`Could not load the memories.`}</p>}
                </div>
                {data && (
                    <ul className="max-h-72 space-y-2 overflow-y-auto">
                        {data.map((item) => (
                            <li className="space-y-0.5" key={item.memoryId}>
                                <div className="flex items-center gap-1.5">
                                    {item.type && (
                                        <Badge className={`px-1.5 py-0 text-[10px] ${MEMORY_TYPE_COLORS[item.type]}`} variant="secondary">
                                            {typeLabels[item.type]}
                                        </Badge>
                                    )}
                                    <span className="text-muted-foreground text-[10px]">{t`relevance ${Math.round(item.score * 100)}%`}</span>
                                    {item.status === "superseded" && <span className="text-muted-foreground text-[10px]">{t`since replaced`}</span>}
                                </div>
                                <p className={item.status === "deleted" ? "text-muted-foreground italic" : undefined}>
                                    {item.status === "deleted" ? t`This memory has since been deleted.` : item.memory}
                                </p>
                            </li>
                        ))}
                    </ul>
                )}
            </PopoverContent>
        </Popover>
    );
};

export default MemoryUsageAction;
