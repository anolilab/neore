"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";

import type { LineRange } from "../lib/guide";
import { rangeText } from "../lib/guide";

export interface GuideStopView {
    explanation: string;
    files: { path: string; ranges: LineRange[] }[];
    id: string;
    kind: "core" | "dependent" | "mechanical" | "uncovered";
    title: string;
}

export type GuideProposalView =
    | {
          body: string;
          id: string;
          kind: "comment";
          line: number;
          path: string;
          side: "new" | "old";
          startLine: number | null;
          status: "applied" | "dismissed" | "proposed";
      }
    | { id: string; kind: "label"; name: string; reason: string; status: "applied" | "dismissed" | "proposed" };

/** The stops of a guide in reading order. Every text in them is the model's or the host's: shown as text, never as markup. */
export const GuideStops = ({ onOpenFile, stops }: { onOpenFile: (path: string) => void; stops: ReadonlyArray<GuideStopView> }) => {
    const { t } = useLingui();
    const kindLabels = { core: t`Core change`, dependent: t`Depends on it`, mechanical: t`Mechanical changes`, uncovered: t`Not covered by the guide` };
    const rangeLabel = (range: LineRange): string => {
        const text = rangeText(range);
        const single = range.start === range.end;

        if (range.side === "old") {
            return single ? t`old line ${text}` : t`old lines ${text}`;
        }

        return single ? t`line ${text}` : t`lines ${text}`;
    };
    const notes = {
        core: undefined,
        dependent: undefined,
        mechanical: t`Renames, lockfiles, snapshots and generated files. Read last, and only as far as you need to.`,
        uncovered: t`The guide did not place these files. They are listed so none is missed.`,
    };

    return (
        <ol aria-label={t`Reading order`} className="space-y-3">
            {stops.map((stop, index) => (
                <li className="rounded-md border p-3" key={stop.id}>
                    <section aria-labelledby={`guide-stop-${stop.id}`} className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-muted-foreground text-xs">{index + 1}</span>
                            <Badge variant={stop.kind === "core" ? "default" : "secondary"}>{kindLabels[stop.kind]}</Badge>
                            <h3 className="min-w-0 text-sm font-medium break-words" id={`guide-stop-${stop.id}`}>
                                {stop.title === "" ? kindLabels[stop.kind] : stop.title}
                            </h3>
                        </div>
                        {stop.explanation !== "" && <p className="text-sm break-words whitespace-pre-wrap">{stop.explanation}</p>}
                        {notes[stop.kind] !== undefined && <p className="text-muted-foreground text-xs">{notes[stop.kind]}</p>}
                        <ul className="space-y-1">
                            {stop.files.map((file) => (
                                <li className="flex flex-wrap items-baseline gap-x-3 text-xs" key={file.path}>
                                    <Button
                                        className="h-auto min-w-0 px-1 py-0.5 font-mono text-xs"
                                        onClick={() => onOpenFile(file.path)}
                                        type="button"
                                        variant="link"
                                    >
                                        <span className="truncate">{file.path}</span>
                                    </Button>
                                    {file.ranges.map((range) => (
                                        <span className="text-muted-foreground" key={`${range.side}-${String(range.start)}-${String(range.end)}`}>
                                            {rangeLabel(range)}
                                        </span>
                                    ))}
                                </li>
                            ))}
                        </ul>
                    </section>
                </li>
            ))}
        </ol>
    );
};

/**
 * What the guide suggests. Nothing here is posted: applying a comment adds it to the review draft, which the person
 * still submits; a label is only a suggestion to make on the host.
 */
export const GuideProposals = ({
    busy,
    hostLabel,
    onApply,
    onDismiss,
    proposals,
}: {
    busy: boolean;
    hostLabel: string;
    onApply: (id: string) => void;
    onDismiss: (id: string) => void;
    proposals: ReadonlyArray<GuideProposalView>;
}) => {
    const { t } = useLingui();
    const statusLabels = { applied: t`Added to your review`, dismissed: t`Dismissed`, proposed: undefined };

    return (
        <ul aria-label={t`Suggestions`} className="space-y-2">
            {proposals.map((proposal) => (
                <li className="space-y-2 rounded-md border p-3" key={proposal.id}>
                    {proposal.kind === "comment" ? (
                        <>
                            <p className="font-mono text-xs break-words">
                                {proposal.path}:{proposal.startLine === null ? proposal.line : `${String(proposal.startLine)}–${String(proposal.line)}`}{" "}
                                {proposal.side === "old" && <span className="text-muted-foreground">{t`(old side)`}</span>}
                            </p>
                            <p className="text-sm break-words whitespace-pre-wrap">{proposal.body}</p>
                        </>
                    ) : (
                        <>
                            <p className="text-sm">
                                {t`Label`} <Badge variant="outline">{proposal.name}</Badge>
                            </p>
                            {proposal.reason !== "" && <p className="text-sm break-words whitespace-pre-wrap">{proposal.reason}</p>}
                            <p className="text-muted-foreground text-xs">{t`A suggestion only. Add the label on ${hostLabel} yourself if you agree.`}</p>
                        </>
                    )}
                    {statusLabels[proposal.status] === undefined ? (
                        <div className="flex gap-2">
                            {proposal.kind === "comment" && (
                                <Button disabled={busy} onClick={() => onApply(proposal.id)} size="sm" type="button">
                                    {t`Add to my review`}
                                </Button>
                            )}
                            <Button disabled={busy} onClick={() => onDismiss(proposal.id)} size="sm" type="button" variant="outline">
                                {t`Dismiss`}
                            </Button>
                        </div>
                    ) : (
                        <p className="text-muted-foreground text-xs">{statusLabels[proposal.status]}</p>
                    )}
                </li>
            ))}
        </ul>
    );
};
