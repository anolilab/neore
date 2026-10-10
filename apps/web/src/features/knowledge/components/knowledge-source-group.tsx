"use client";

import { useLingui } from "@lingui/react/macro";
import { readKnowledgeCitation } from "@neore/backend/knowledge/citations";
import { DefaultSourceGroup } from "@neore/chat-ui/chat/message-content";
import type { SourceDocumentPart, SourceUrlPart } from "@neore/chat-ui/types";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@neore/ui/components/popover";
import { BookOpenIcon } from "lucide-react";
import type { FC } from "react";
import { memo, useMemo } from "react";

type SourcePart = (SourceDocumentPart | SourceUrlPart) & { providerMetadata?: unknown };

/**
 * A reply's sources, with knowledge-base passages as citation chips.
 *
 * Chip `n` is the reply's `n`th source — the same position the inline `[n]`
 * markers resolve against (`@neore/chat-ui` message content), which clicks the
 * chip carrying `data-citation-chip="n"`. Knowledge sources are recorded first
 * (`backend/lunora/knowledge/citations.ts`), so their positions are the
 * numbers the model was told to cite. Web sources keep the default list.
 */
const KnowledgeSourceGroup: FC<{ sources: SourcePart[] }> = memo(({ sources }) => {
    const { t } = useLingui();
    const { citations, others } = useMemo(() => {
        const knowledge: { citation: NonNullable<ReturnType<typeof readKnowledgeCitation>>; position: number; sourceId: string }[] = [];
        const rest: SourcePart[] = [];

        for (const [index, source] of sources.entries()) {
            const citation = source.type === "source-document" ? readKnowledgeCitation(source.providerMetadata) : undefined;

            if (citation) {
                knowledge.push({ citation, position: index + 1, sourceId: source.sourceId });
            } else {
                rest.push(source);
            }
        }

        return { citations: knowledge, others: rest };
    }, [sources]);

    if (citations.length === 0) {
        return <DefaultSourceGroup sources={sources} />;
    }

    return (
        <>
            <div aria-label={t`Knowledge base sources`} className="not-prose mb-3 flex flex-wrap gap-1.5" role="list">
                {citations.map(({ citation, position, sourceId }) => (
                    <div key={sourceId} role="listitem">
                        <Popover>
                            <PopoverTrigger
                                aria-label={t`Source ${position}: ${citation.fileName}, passage ${citation.chunkIndex + 1}`}
                                className="bg-muted hover:bg-muted/70 focus-visible:ring-ring inline-flex max-w-56 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
                                data-citation-chip={position}
                            >
                                <span className="bg-background flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold">
                                    {position}
                                </span>
                                <BookOpenIcon aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />
                                <span className="truncate">{citation.fileName}</span>
                            </PopoverTrigger>
                            <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)]">
                                <PopoverHeader>
                                    <PopoverTitle className="truncate text-sm">{citation.fileName}</PopoverTitle>
                                    <PopoverDescription className="text-xs">{t`Passage ${citation.chunkIndex + 1}, cited as [${position}]`}</PopoverDescription>
                                </PopoverHeader>
                                <blockquote className="text-muted-foreground mt-2 max-h-72 overflow-y-auto border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap">
                                    {citation.passage}
                                </blockquote>
                            </PopoverContent>
                        </Popover>
                    </div>
                ))}
            </div>
            {others.length > 0 && <DefaultSourceGroup firstIndex={citations.length + 1} sources={others} />}
        </>
    );
});

KnowledgeSourceGroup.displayName = "KnowledgeSourceGroup";

export default KnowledgeSourceGroup;
