"use client";

import { useLingui } from "@lingui/react/macro";

import type { FieldDiff } from "../lib/skill-builder";

/**
 * What a refinement changed, field by field. Colour is never the only signal:
 * every line carries a +/− marker and screen-reader text.
 */
const LINE_STYLES = {
    added: "bg-emerald-500/10 px-3 whitespace-pre-wrap",
    removed: "bg-red-500/10 px-3 whitespace-pre-wrap line-through decoration-red-500/40",
    same: "text-muted-foreground px-3 whitespace-pre-wrap",
} as const;

const LINE_MARKERS = { added: "+ ", removed: "− ", same: "  " } as const;

const SkillBuilderDiff = ({ diff }: { diff: FieldDiff[] }) => {
    const { t } = useLingui();

    if (diff.length === 0) {
        return <p className="text-muted-foreground text-xs">{t`The refinement did not change any field.`}</p>;
    }

    const fieldLabels: Record<string, string> = {
        category: t`Category`,
        description: t`Description`,
        disableTools: t`Disabled tools`,
        enableTools: t`Enabled tools`,
        instructions: t`Instructions`,
        name: t`Name`,
        preferredModel: t`Preferred model`,
        reasoningEffort: t`Reasoning effort`,
        searchMode: t`Search mode`,
        slug: t`Command`,
        tags: t`Tags`,
        variables: t`Variables`,
    };
    const lineLabels = { added: t`Added:`, removed: t`Removed:` };
    const none = t`(none)`;

    return (
        <ul aria-label={t`Changes from the last refinement`} className="space-y-3">
            {diff.map((entry) => (
                <li className="rounded-md border text-xs" key={entry.field}>
                    <p className="bg-muted/50 border-b px-3 py-1.5 font-medium">{fieldLabels[entry.field] ?? entry.field}</p>
                    <div className="max-h-60 overflow-auto font-mono">
                        {(
                            entry.lines ?? [
                                { kind: "removed" as const, text: entry.before || none },
                                { kind: "added" as const, text: entry.after || none },
                            ]
                        ).map((line, index) => (
                            <div
                                className={LINE_STYLES[line.kind]}
                                // Lines are positional; the diff is rebuilt, never reordered.
                                key={index}
                            >
                                <span aria-hidden="true">{LINE_MARKERS[line.kind]}</span>
                                {line.kind !== "same" && <span className="sr-only">{lineLabels[line.kind]} </span>}
                                {line.text}
                            </div>
                        ))}
                    </div>
                </li>
            ))}
        </ul>
    );
};

export default SkillBuilderDiff;
