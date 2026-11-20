"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { RuleFileRefusal } from "@neore/backend/rule-file-limits";
import {
    isRuleGlobValid,
    MAX_RULE_FILE_LENGTH,
    MAX_RULE_FILES,
    MAX_RULE_FILES_BYTES,
    MAX_RULE_GLOB_LENGTH,
    MAX_RULE_GLOBS,
    MAX_RULE_TITLE_LENGTH,
    RULE_FILE_REFUSALS,
    ruleFilesStoredBytes,
} from "@neore/backend/rule-file-limits";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Textarea } from "@neore/ui/components/textarea";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useState } from "react";

import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useCRPC } from "@/lib/lunora/crpc";

/** The id and name the backend gives a project's older single context (`LEGACY_CONTEXT_RULE_ID`). */
const LEGACY_CONTEXT_ID = "context";
const LEGACY_CONTEXT_TITLE = "Project context";

/** The backend's code for a refused call: its own `data.code` when it names one, else the standard `code`. */
const errorCode = (error: unknown): unknown => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return data?.code ?? code;
};

const REFUSAL_CODES = new Set<unknown>(Object.values(RULE_FILE_REFUSALS));

/**
 * A save the backend refused at a rule-file limit: its code and the file of `files` it names, if it names one. A file it
 * names that the editor no longer holds gives nothing, and the refusal reads as any other.
 */
const limitRefusal = (error: unknown, files: RuleFileDraft[]): { code: RuleFileRefusal; file?: RuleFileDraft } | undefined => {
    const code = errorCode(error);

    if (!REFUSAL_CODES.has(code)) {
        return undefined;
    }

    const fileId = (error as { data?: { fileId?: unknown } }).data?.fileId;

    if (typeof fileId !== "string") {
        return { code: code as RuleFileRefusal };
    }

    const file = files.find((current) => current.id === fileId);

    return file && { code: code as RuleFileRefusal, file };
};

type RuleFileMode = "always" | "glob";

/** A file's field a save was refused for: marked invalid, described by the error and focused. */
type RuleFileField = "content" | "patterns" | "title";

/** What a save is refused for: a file's field, or (no field) the list as a whole, which only the error names. */
interface RuleFileProblem {
    field?: RuleFileField;
    fileId?: string;
    message: string;
}

/** The field each refusal names. */
const REFUSAL_FIELDS: Partial<Record<RuleFileRefusal, RuleFileField>> = {
    [RULE_FILE_REFUSALS.CONTENT_TOO_LONG]: "content",
    [RULE_FILE_REFUSALS.PATTERN_INVALID]: "patterns",
    [RULE_FILE_REFUSALS.PATTERNS_MISSING]: "patterns",
    [RULE_FILE_REFUSALS.PATTERNS_TOO_MANY]: "patterns",
    [RULE_FILE_REFUSALS.TITLE_MISSING]: "title",
    [RULE_FILE_REFUSALS.TITLE_TOO_LONG]: "title",
};

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

/** Whether a draft file is `saved` as it was: same id, name, mode, patterns and text. */
const sameFile = (file: RuleFileDraft | undefined, saved: RuleFileDraft): boolean =>
    file !== undefined &&
    file.id === saved.id &&
    file.title === saved.title &&
    file.mode === saved.mode &&
    file.patterns === saved.patterns &&
    file.content === saved.content;

/** The name a file is saved under: the older context's shown in the person's language goes back to the backend's own. */
const savedTitle = (file: RuleFileDraft, legacyTitle: string): string => {
    const title = file.title.trim();

    return title === legacyTitle && file.id === LEGACY_CONTEXT_ID ? LEGACY_CONTEXT_TITLE : title;
};

/** The list as `setProjectRuleFiles` takes it: patterns only on a file applied by pattern. */
const toSaved = (files: RuleFileDraft[], legacyTitle: string) =>
    files.map((file) => {
        return {
            content: file.content,
            ...(file.mode === "glob" && { globs: patternsOf(file.patterns) }),
            id: file.id,
            mode: file.mode,
            title: savedTitle(file, legacyTitle),
        };
    });

interface ListedRuleFiles {
    canEdit: boolean;
    files: { content: string; globs?: string[]; id: string; mode: RuleFileMode; title: string }[];
    legacyContextId?: string;
    revision: string;
}

/** The listed files after a save wrote `written`: a kept legacy context stays first, as the backend keeps it. */
const withSavedFiles = (
    listed: ListedRuleFiles | null | undefined,
    written: Pick<ListedRuleFiles, "files" | "revision">,
    keptId: string | undefined,
): ListedRuleFiles | null | undefined => {
    if (!listed) {
        return listed;
    }

    const kept = keptId === undefined ? undefined : listed.files.find((file) => file.id === keptId);

    return {
        canEdit: listed.canEdit,
        files: kept ? [kept, ...written.files] : written.files,
        ...(kept && { legacyContextId: keptId }),
        revision: written.revision,
    };
};

/**
 * One file's fields; every control is named after the file, so a list of them stays told apart. `invalid` names the
 * field a save was refused for: it is marked invalid, described by the error (`errorId`) and focused on each refused
 * save (`focusRequest`).
 */
const RuleFileFields: FC<{
    errorId: string;
    file: RuleFileDraft;
    focusRequest: number;
    index: number;
    invalid: RuleFileField | undefined;
    isFirst: boolean;
    isLast: boolean;
    onChange: (file: RuleFileDraft) => void;
    onMove: (offset: -1 | 1) => void;
    onRemove: () => void;
    onSave: () => void;
}> = ({ errorId, file, focusRequest, index, invalid, isFirst, isLast, onChange, onMove, onRemove, onSave }) => {
    const { t } = useLingui();
    const id = useId();
    const name = file.title.trim() || t`Rule file ${index + 1}`;
    const invalidProps = (field: RuleFileField) => (invalid === field ? { "aria-describedby": errorId, "aria-invalid": true } : {});

    // By id, not a ref: `Textarea` would hand a ref past its field control's own (`packages/ui` `Textarea`).
    useEffect(() => {
        if (invalid) {
            document.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${invalid}`)}`)?.focus();
        }
    }, [focusRequest, id, invalid]);

    return (
        <li aria-label={name} className="space-y-3 rounded-md border p-3">
            <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                    <Label htmlFor={`${id}-title`}>
                        {t`Name`}
                        <span aria-hidden="true" className="text-destructive">
                            *
                        </span>
                    </Label>
                    <Input
                        aria-required="true"
                        autoComplete="off"
                        id={`${id}-title`}
                        onChange={(event) => onChange({ ...file, title: event.target.value })}
                        onKeyDown={(event) => {
                            // Inside the project's form: Enter saves the rule files, the editor's own action, never the project.
                            if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                                return;
                            }

                            event.preventDefault();
                            onSave();
                        }}
                        value={file.title}
                        {...invalidProps("title")}
                    />
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
                    <Label htmlFor={`${id}-patterns`}>
                        {t`File patterns, one per line`}
                        <span aria-hidden="true" className="text-destructive">
                            *
                        </span>
                    </Label>
                    <Textarea
                        aria-required="true"
                        autoComplete="off"
                        className="min-h-14 font-mono text-xs"
                        id={`${id}-patterns`}
                        onChange={(event) => onChange({ ...file, patterns: event.target.value })}
                        placeholder="**/*.sql"
                        value={file.patterns}
                        {...invalidProps("patterns")}
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
                    {...invalidProps("content")}
                />
            </div>
        </li>
    );
};

/**
 * A project's rule files: instructions added to the project's runs, each always or only when the run's files match its
 * patterns. Edited as one list and saved together (`setProjectRuleFiles`), so adding, changing, reordering and deleting
 * are one save. A project's older single context shows as its first file. Only the project's owner edits them, the
 * rule of the project's other settings; others read them. `onDirtyChange` says whether unsaved changes are open, and
 * `onSavingChange` whether a save is on its way: it cannot be called back, so nothing may offer to discard it meanwhile.
 */
const ProjectRuleFiles: FC<{ onDirtyChange?: (dirty: boolean) => void; onSavingChange?: (saving: boolean) => void; projectId: string }> = ({
    onDirtyChange,
    onSavingChange,
    projectId,
}) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const errorId = useId();
    const queryClient = useQueryClient();
    const args = { projectId: projectId as Id<"projects"> };
    const listOptions = crpc.projects.functions.listProjectRuleFiles.queryOptions(args);
    // Not live (`NEVER_LIVE`): a `.global()` write reaches no other member's subscription; read again on focus.
    const { data, isError, refetch } = useQuery({
        ...listOptions,
        refetchOnWindowFocus: true,
        staleTime: 0,
    });
    // Sent even offline: Lunora's client queues it, where a paused TanStack mutation would be lost with the tab.
    const saved = useMutation({ ...crpc.projects.functions.setProjectRuleFiles.mutationOptions(), networkMode: "always" });
    const [draft, setDraft] = useState<RuleFileDraft[] | null>(null);
    // The revision of the list the draft started from: a save from it is refused once another save landed.
    const [baseRevision, setBaseRevision] = useState("");
    const [error, setError] = useState<string | undefined>(undefined);
    const [status, setStatus] = useState("");
    // The field the last refused save named, and how many times one was refused, so each refusal moves focus there again.
    const [invalid, setInvalid] = useState<{ field: RuleFileField; fileId: string } | undefined>(undefined);
    const [focusRequest, setFocusRequest] = useState(0);
    const legacyTitle = t`Project context`;
    const savedFiles = (data?.files ?? []).map((file) =>
        // The older single context arrives under the backend's English name; it shows in the person's language.
        toDraft(file.id === LEGACY_CONTEXT_ID && file.title === LEGACY_CONTEXT_TITLE ? { ...file, title: legacyTitle } : file),
    );
    const files = draft ?? savedFiles;
    const canEdit = data?.canEdit === true;
    const isDirty = draft !== null;
    // An older context longer than a rule file may be, left exactly as it was (first, same name, mode and text): it stays
    // where it is, as the backend keeps it. Any change to it makes it an ordinary file, held to the limits.
    const legacy = savedFiles[0];
    const keptLegacyId =
        legacy && legacy.id === data?.legacyContextId && legacy.content.length > MAX_RULE_FILE_LENGTH && sameFile(files[0], legacy) ? legacy.id : undefined;

    const isSaving = saved.isPending;

    useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    useEffect(() => {
        onSavingChange?.(isSaving);
    }, [isSaving, onSavingChange]);

    const conflictMessage = t`These rule files were changed meanwhile. Discard your changes to see the saved ones, then edit again.`;

    const change = (next: RuleFileDraft[]) => {
        if (draft === null) {
            setBaseRevision(data?.revision ?? "");
        }

        setDraft(next);
        setStatus("");
    };

    /** How a refusal reads, for `file` when it names one; the editor's own check and the backend's word it alike. */
    const refusalText = (code: RuleFileRefusal, file: RuleFileDraft | undefined): string => {
        const name = file?.title.trim() ?? "";
        const numberOf = (value: number) => formatNumber(value, i18n.locale);
        const texts: Record<RuleFileRefusal, () => string> = {
            [RULE_FILE_REFUSALS.CONTENT_TOO_LONG]: () => {
                const limit = numberOf(MAX_RULE_FILE_LENGTH);

                return t`"${name}" is longer than ${limit} characters. Shorten it or split it into several files.`;
            },
            [RULE_FILE_REFUSALS.PATTERN_INVALID]: () => {
                const limit = numberOf(MAX_RULE_GLOB_LENGTH);

                return t`Each file pattern in "${name}" must be at most ${limit} characters on one line.`;
            },
            [RULE_FILE_REFUSALS.PATTERNS_MISSING]: () => t`A file applied when files match needs at least one pattern.`,
            [RULE_FILE_REFUSALS.PATTERNS_TOO_MANY]: () => {
                const limit = numberOf(MAX_RULE_GLOBS);

                return t`"${name}" has more than ${limit} file patterns. Remove some, or move them into another file.`;
            },
            [RULE_FILE_REFUSALS.TITLE_MISSING]: () => t`Give every rule file a name.`,
            [RULE_FILE_REFUSALS.TITLE_TOO_LONG]: () => {
                const limit = numberOf(MAX_RULE_TITLE_LENGTH);

                return t`A rule file's name may be at most ${limit} characters.`;
            },
            [RULE_FILE_REFUSALS.TOO_LARGE]: () => {
                const limit = numberOf(MAX_RULE_FILES_BYTES / 1_000_000);

                return t`Together these rule files are larger than ${limit} MB. Shorten or remove some of them.`;
            },
            [RULE_FILE_REFUSALS.TOO_MANY]: () => {
                const limit = numberOf(MAX_RULE_FILES);

                return t`A project holds at most ${limit} rule files. Remove one first.`;
            },
        };

        return texts[code]();
    };

    /** The problem a refusal names, its field on the file it names, or the list as a whole. */
    const problemOf = (code: RuleFileRefusal, file: RuleFileDraft | undefined): RuleFileProblem => {
        const field = file && REFUSAL_FIELDS[code];

        return { ...(file && field && { field, fileId: file.id }), message: refusalText(code, file) };
    };

    /** What a save would refuse `file` for first, field by field as the editor shows them. */
    const fileRefusal = (file: RuleFileDraft): RuleFileRefusal | undefined => {
        const title = file.title.trim();

        if (!title) {
            return RULE_FILE_REFUSALS.TITLE_MISSING;
        }

        if (title.length > MAX_RULE_TITLE_LENGTH) {
            return RULE_FILE_REFUSALS.TITLE_TOO_LONG;
        }

        // In the backend's order, so a file past two limits is refused for the same one either way.
        if (file.id !== keptLegacyId && file.content.length > MAX_RULE_FILE_LENGTH) {
            return RULE_FILE_REFUSALS.CONTENT_TOO_LONG;
        }

        if (file.mode === "glob") {
            const patterns = patternsOf(file.patterns);

            if (patterns.length === 0) {
                return RULE_FILE_REFUSALS.PATTERNS_MISSING;
            }

            if (patterns.length > MAX_RULE_GLOBS) {
                return RULE_FILE_REFUSALS.PATTERNS_TOO_MANY;
            }

            if (patterns.some((pattern) => !isRuleGlobValid(pattern))) {
                return RULE_FILE_REFUSALS.PATTERN_INVALID;
            }
        }

        return undefined;
    };

    /** The list a save sends: a kept legacy context stays out of it. */
    const sentFiles = () => toSaved(keptLegacyId === undefined ? files : files.filter((file) => file.id !== keptLegacyId), legacyTitle);

    /** The first file and field a save would be refused for, in the order the list shows them, then the list's own limits. */
    const problem = (): RuleFileProblem | undefined => {
        for (const file of files) {
            const code = fileRefusal(file);

            if (code) {
                return problemOf(code, file);
            }
        }

        const ruleFiles = sentFiles();

        if (ruleFiles.length > MAX_RULE_FILES) {
            return problemOf(RULE_FILE_REFUSALS.TOO_MANY, undefined);
        }

        // Measured as the backend stores them, so the editor and the save agree to the byte.
        return ruleFilesStoredBytes(ruleFiles) > MAX_RULE_FILES_BYTES ? problemOf(RULE_FILE_REFUSALS.TOO_LARGE, undefined) : undefined;
    };

    /** Shows `refusal`: the error, its field marked invalid and focused when it names one. */
    const showProblem = (refusal: RuleFileProblem) => {
        setInvalid(refusal.field && refusal.fileId !== undefined ? { field: refusal.field, fileId: refusal.fileId } : undefined);
        setError(refusal.message);
        setFocusRequest((count) => count + 1);
    };

    const save = async () => {
        const refusal = problem();

        if (refusal) {
            showProblem(refusal);

            return;
        }

        setInvalid(undefined);

        const submitted = draft;
        const ruleFiles = sentFiles();
        const keep = keptLegacyId === undefined ? {} : { keepContext: true };

        try {
            const written = await saved.mutateAsync({ ...args, ...keep, revision: baseRevision, ruleFiles });

            // The list as written shows at once, before any read lands: the cached one is the list from before the save.
            queryClient.setQueryData(listOptions.queryKey, (current: typeof data) => withSavedFiles(current, written, keptLegacyId));
            // Edits typed while the save ran stay, now based on the list just saved.
            setDraft((current) => (current === submitted ? null : current));
            setBaseRevision(written.revision);
            setError(undefined);
            setStatus(t`Rule files saved.`);
            refetch().catch(() => undefined);
        } catch (saveError) {
            // A limit the backend holds that this editor did not (an older client): worded and placed as the editor's own.
            const atLimit = limitRefusal(saveError, files);

            if (atLimit) {
                showProblem(problemOf(atLimit.code, atLimit.file));
            } else {
                setError(refusalMessage(saveError, conflictMessage, t));
            }
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
                <ul className="space-y-3">
                    {files.map((file) => (
                        <li className="space-y-1 text-sm" key={file.id}>
                            <div className="flex items-center gap-2">
                                <span className="font-medium">{file.title}</span>
                                <Badge variant="outline">{file.mode === "always" ? t`Always` : patternsOf(file.patterns).join(", ")}</Badge>
                            </div>
                            <p className="text-muted-foreground max-h-48 overflow-y-auto break-words whitespace-pre-wrap">{file.content}</p>
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
                                    errorId={errorId}
                                    file={file}
                                    focusRequest={focusRequest}
                                    index={index}
                                    invalid={invalid?.fileId === file.id ? invalid.field : undefined}
                                    isFirst={index === 0}
                                    isLast={index === files.length - 1}
                                    key={file.id}
                                    onChange={(next) => change(files.map((current) => (current.id === file.id ? next : current)))}
                                    onMove={(offset) => change(moved(files, index, offset))}
                                    onRemove={() => change(files.filter((current) => current.id !== file.id))}
                                    onSave={() => {
                                        if (draft && !isSaving) {
                                            save().catch(() => undefined);
                                        }
                                    }}
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
                                    // A refusal of the whole list names no field: it describes the button that was refused.
                                    aria-describedby={error && !invalid ? errorId : undefined}
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
                                    // A save on its way still lands: discarding now would only hide what it writes.
                                    disabled={isSaving}
                                    onClick={() => {
                                        // Read again: after a refused save the cached list is the one another save replaced.
                                        refetch().catch(() => undefined);
                                        setDraft(null);
                                        setError(undefined);
                                        setInvalid(undefined);
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
                <p className="text-destructive text-sm" id={errorId} role="alert">
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
