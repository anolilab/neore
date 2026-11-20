"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Textarea } from "@neore/ui/components/textarea";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useCRPC } from "@/lib/lunora/crpc";

/** Rule files one project holds, and characters one file holds; mirror the backend's limits (`projects/rule-files.ts`). */
const MAX_RULE_FILES = 20;
const MAX_RULE_FILE_LENGTH = 100_000;
/** The id and name the backend gives a project's older single context (`LEGACY_CONTEXT_RULE_ID`). */
const LEGACY_CONTEXT_ID = "context";
const LEGACY_CONTEXT_TITLE = "Project context";

/** The backend's code for a refused call: its own `data.code` when it names one, else the standard `code`. */
const errorCode = (error: unknown): unknown => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return data?.code ?? code;
};

type RuleFileMode = "always" | "glob";

/** A rule file as the editor holds it: its patterns as typed, one per line. */
interface RuleFileDraft {
    content: string;
    id: string;
    mode: RuleFileMode;
    patterns: string;
    title: string;
}

const patternsOf = (patterns: string): string[] =>
    patterns
        .split("\n")
        .map((pattern) => pattern.trim())
        .filter(Boolean);

const toDraft = (file: { content: string; globs?: string[]; id: string; mode: RuleFileMode; title: string }): RuleFileDraft => {
    return { content: file.content, id: file.id, mode: file.mode, patterns: (file.globs ?? []).join("\n"), title: file.title };
};

/** `files` with the one at `index` swapped with its neighbour `offset` away. */
const moved = (files: RuleFileDraft[], index: number, offset: -1 | 1): RuleFileDraft[] =>
    files.map((file, position) => {
        if (position === index) {
            return files[index + offset] ?? file;
        }

        return position === index + offset ? (files[index] ?? file) : file;
    });

/** A refused save in the person's language: `conflict` for one from an older view, else the error as the app words it. */
const refusalMessage = (error: unknown, conflict: string, t: Parameters<typeof getLocalizedError>[0]["t"]): string =>
    errorCode(error) === "CONFLICT" ? conflict : getLocalizedError({ error, t });

/** The list as `setProjectRuleFiles` takes it: patterns only on a file applied by pattern. */
const toSaved = (files: RuleFileDraft[]) =>
    files.map((file) => {
        return {
            content: file.content,
            ...(file.mode === "glob" && { globs: patternsOf(file.patterns) }),
            id: file.id,
            mode: file.mode,
            title: file.title.trim(),
        };
    });

/** One file's fields; every control is named after the file, so a list of them stays told apart. */
const RuleFileFields: FC<{
    file: RuleFileDraft;
    index: number;
    isFirst: boolean;
    isLast: boolean;
    onChange: (file: RuleFileDraft) => void;
    onMove: (offset: -1 | 1) => void;
    onRemove: () => void;
}> = ({ file, index, isFirst, isLast, onChange, onMove, onRemove }) => {
    const { t } = useLingui();
    const id = useId();
    const name = file.title.trim() || t`Rule file ${index + 1}`;

    return (
        <li aria-label={name} className="space-y-3 rounded-md border p-3">
            <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                    <Label htmlFor={`${id}-title`}>{t`Name`}</Label>
                    <Input autoComplete="off" id={`${id}-title`} onChange={(event) => onChange({ ...file, title: event.target.value })} value={file.title} />
                </div>
                <Button aria-label={t`Move ${name} up`} disabled={isFirst} onClick={() => onMove(-1)} size="icon" type="button" variant="ghost">
                    <ArrowUp aria-hidden="true" className="size-4" />
                </Button>
                <Button aria-label={t`Move ${name} down`} disabled={isLast} onClick={() => onMove(1)} size="icon" type="button" variant="ghost">
                    <ArrowDown aria-hidden="true" className="size-4" />
                </Button>
                <Button aria-label={t`Delete ${name}`} onClick={onRemove} size="icon" type="button" variant="ghost">
                    <Trash2 aria-hidden="true" className="size-4" />
                </Button>
            </div>
            <div aria-labelledby={`${id}-mode`} className="space-y-1" role="group">
                <span className="text-sm font-medium" id={`${id}-mode`}>{t`Applies`}</span>
                <RadioGroup className="flex gap-4" onValueChange={(mode) => onChange({ ...file, mode: mode as RuleFileMode })} value={file.mode}>
                    <Label className="flex items-center gap-2 font-normal">
                        <RadioGroupItem value="always" />
                        {t`Always`}
                    </Label>
                    <Label className="flex items-center gap-2 font-normal">
                        <RadioGroupItem value="glob" />
                        {t`When files match`}
                    </Label>
                </RadioGroup>
            </div>
            {file.mode === "glob" && (
                <div className="space-y-1">
                    <Label htmlFor={`${id}-patterns`}>{t`File patterns, one per line`}</Label>
                    <Textarea
                        autoComplete="off"
                        className="min-h-14 font-mono text-xs"
                        id={`${id}-patterns`}
                        onChange={(event) => onChange({ ...file, patterns: event.target.value })}
                        placeholder="**/*.sql"
                        value={file.patterns}
                    />
                </div>
            )}
            <div className="space-y-1">
                <Label htmlFor={`${id}-content`}>{t`Instructions`}</Label>
                <Textarea
                    autoComplete="off"
                    id={`${id}-content`}
                    onChange={(event) => onChange({ ...file, content: event.target.value })}
                    value={file.content}
                />
            </div>
        </li>
    );
};

/**
 * A project's rule files: instructions added to the project's runs, each always or only when the run's files match its
 * patterns. Edited as one list and saved together (`setProjectRuleFiles`), so adding, changing, reordering and deleting
 * are one save. A project's older single context shows as its first file. Only the project's owner (a member, for an
 * organization project nobody owns) edits them; others read them.
 */
const ProjectRuleFiles: FC<{ projectId: string }> = ({ projectId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const args = { projectId: projectId as Id<"projects"> };
    // Not live (`NEVER_LIVE`): a `.global()` write reaches no other member's subscription; read again on focus.
    const { data, isError, refetch } = useQuery({
        ...crpc.projects.functions.listProjectRuleFiles.queryOptions(args),
        refetchOnWindowFocus: true,
        staleTime: 0,
    });
    const saved = useMutation(crpc.projects.functions.setProjectRuleFiles.mutationOptions());
    const [draft, setDraft] = useState<RuleFileDraft[] | null>(null);
    // The revision of the list the draft started from: a save from it is refused once another save landed.
    const [baseRevision, setBaseRevision] = useState("");
    const [error, setError] = useState<string | undefined>(undefined);
    const [status, setStatus] = useState("");
    const files =
        draft ??
        (data?.files ?? []).map((file) =>
            // The older single context arrives under the backend's English name; it shows in the person's language.
            toDraft(file.id === LEGACY_CONTEXT_ID && file.title === LEGACY_CONTEXT_TITLE ? { ...file, title: t`Project context` } : file),
        );
    const canEdit = data?.canEdit === true;

    const conflictMessage = t`These rule files were changed meanwhile. Discard your changes to see the saved ones, then edit again.`;

    const change = (next: RuleFileDraft[]) => {
        if (draft === null) {
            setBaseRevision(data?.revision ?? "");
        }

        setDraft(next);
        setStatus("");
    };

    const problem = (): string | undefined => {
        if (files.some((file) => !file.title.trim())) {
            return t`Give every rule file a name.`;
        }

        if (files.some((file) => file.mode === "glob" && patternsOf(file.patterns).length === 0)) {
            return t`A file applied when files match needs at least one pattern.`;
        }

        const long = files.find((file) => file.content.length > MAX_RULE_FILE_LENGTH);

        if (long) {
            const limit = formatNumber(MAX_RULE_FILE_LENGTH, i18n.locale);
            const name = long.title.trim();

            return t`"${name}" is longer than ${limit} characters. Shorten it or split it into several files.`;
        }

        return undefined;
    };

    const save = async () => {
        const refusal = problem();

        if (refusal) {
            setError(refusal);

            return;
        }

        try {
            await saved.mutateAsync({ ...args, revision: baseRevision, ruleFiles: toSaved(files) });
            await refetch();
            setDraft(null);
            setError(undefined);
            setStatus(t`Rule files saved.`);
        } catch (saveError) {
            setError(refusalMessage(saveError, conflictMessage, t));
        }
    };

    return (
        <section aria-labelledby={headingId} className="bg-muted/30 space-y-4 rounded-lg border p-4">
            <div className="space-y-1">
                <h3 className="text-sm font-medium" id={headingId}>{t`Rule files`}</h3>
                <p className="text-muted-foreground text-xs">
                    {t`Instructions added to this project's chats: always, or only when the chat's attached files match a pattern such as **/*.sql.`}
                </p>
            </div>
            {isError && (
                <p className="text-destructive text-sm" role="alert">
                    {t`The rule files could not be loaded.`}
                </p>
            )}
            {data && !canEdit && (
                <ul className="space-y-2">
                    {files.map((file) => (
                        <li className="flex items-center gap-2 text-sm" key={file.id}>
                            <span className="font-medium">{file.title}</span>
                            <Badge variant="outline">{file.mode === "always" ? t`Always` : patternsOf(file.patterns).join(", ")}</Badge>
                        </li>
                    ))}
                </ul>
            )}
            {data && canEdit && (
                <>
                    {files.length > 0 && (
                        <ol className="space-y-3">
                            {files.map((file, index) => (
                                <RuleFileFields
                                    file={file}
                                    index={index}
                                    isFirst={index === 0}
                                    isLast={index === files.length - 1}
                                    key={file.id}
                                    onChange={(next) => change(files.map((current) => (current.id === file.id ? next : current)))}
                                    onMove={(offset) => change(moved(files, index, offset))}
                                    onRemove={() => change(files.filter((current) => current.id !== file.id))}
                                />
                            ))}
                        </ol>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            disabled={files.length >= MAX_RULE_FILES}
                            onClick={() => change([...files, { content: "", id: crypto.randomUUID(), mode: "always", patterns: "", title: "" }])}
                            size="sm"
                            type="button"
                            variant="outline"
                        >
                            <Plus aria-hidden="true" className="size-4" />
                            {t`Add rule file`}
                        </Button>
                        {draft && (
                            <>
                                <Button
                                    disabled={saved.isPending}
                                    onClick={() => {
                                        save().catch(() => undefined);
                                    }}
                                    size="sm"
                                    type="button"
                                >
                                    {saved.isPending ? t`Saving...` : t`Save rule files`}
                                </Button>
                                <Button
                                    onClick={() => {
                                        setDraft(null);
                                        setError(undefined);
                                    }}
                                    size="sm"
                                    type="button"
                                    variant="ghost"
                                >
                                    {t`Discard changes`}
                                </Button>
                            </>
                        )}
                    </div>
                </>
            )}
            {error && (
                <p className="text-destructive text-sm" role="alert">
                    {error}
                </p>
            )}
            <p className="sr-only" role="status">
                {status}
            </p>
        </section>
    );
};

export default ProjectRuleFiles;
