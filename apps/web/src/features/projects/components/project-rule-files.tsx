"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { RuleFileRefusal } from "@neore/backend/rule-file-limits";
import {
    isRuleDescriptionValid,
    isRuleGlobValid,
    isRuleTitleReserved,
    MAX_RULE_DESCRIPTION_LENGTH,
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
import { ArrowDown, ArrowUp, FileUp, FolderUp, Plus, Trash2 } from "lucide-react";
import type { ChangeEvent, FC, KeyboardEvent } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useCRPC } from "@/lib/lunora/crpc";

import { fitTitle, importRuleFiles, needsMode, unreservedTitle } from "../lib/rule-file-import";
import ComputerRuleFileImport from "./computer-rule-file-import";
import type { RepoImportResult } from "./repo-rule-file-import";
import RepoRuleFileImport from "./repo-rule-file-import";

/** The id and name the backend gives a project's older single context (`LEGACY_CONTEXT_RULE_ID`). */
const LEGACY_CONTEXT_ID = "context";
const LEGACY_CONTEXT_TITLE = "Project context";

/** How many files an import note names of those it left out; the rest are counted. */
const NAMED_LEFT_OUT = 5;

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

type RuleFileMode = "always" | "auto" | "glob";

/** A file's field a save was refused for: marked invalid, described by the error and focused. */
type RuleFileField = "content" | "description" | "patterns" | "title";

/** What a save is refused for: a file's field, or (no field) the list as a whole, which only the error names. */
interface RuleFileProblem {
    field?: RuleFileField;
    fileId?: string;
    message: string;
}

/** The field each refusal names. */
const REFUSAL_FIELDS: Partial<Record<RuleFileRefusal, RuleFileField>> = {
    [RULE_FILE_REFUSALS.CONTENT_TOO_LONG]: "content",
    [RULE_FILE_REFUSALS.DESCRIPTION_INVALID]: "description",
    [RULE_FILE_REFUSALS.DESCRIPTION_MISSING]: "description",
    [RULE_FILE_REFUSALS.PATTERN_INVALID]: "patterns",
    [RULE_FILE_REFUSALS.PATTERNS_MISSING]: "patterns",
    [RULE_FILE_REFUSALS.PATTERNS_TOO_MANY]: "patterns",
    [RULE_FILE_REFUSALS.TITLE_MISSING]: "title",
    [RULE_FILE_REFUSALS.TITLE_RESERVED]: "title",
    [RULE_FILE_REFUSALS.TITLE_TOO_LONG]: "title",
};

/** A rule file as the editor holds it: its patterns as typed, one per line; a description kept while its mode changes. */
interface RuleFileDraft {
    content: string;
    description: string;
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

const toDraft = (file: { content: string; description?: string; globs?: string[]; id: string; mode: RuleFileMode; title: string }): RuleFileDraft => {
    return {
        content: file.content,
        description: file.description ?? "",
        id: file.id,
        mode: file.mode,
        patterns: (file.globs ?? []).join("\n"),
        title: file.title,
    };
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
    file.description === saved.description &&
    file.content === saved.content;

/** The name a file is saved under: the older context's shown in the person's language goes back to the backend's own. */
const savedTitle = (file: RuleFileDraft, legacyTitle: string): string => {
    const title = file.title.trim();

    return title === legacyTitle && file.id === LEGACY_CONTEXT_ID ? LEGACY_CONTEXT_TITLE : title;
};

/** The list as `setProjectRuleFiles` takes it: patterns only on a file applied by pattern, a description only on one read when needed. */
const toSaved = (files: RuleFileDraft[], legacyTitle: string) =>
    files.map((file) => {
        return {
            content: file.content,
            ...(file.mode === "auto" && { description: file.description.trim() }),
            ...(file.mode === "glob" && { globs: patternsOf(file.patterns) }),
            id: file.id,
            mode: file.mode,
            title: savedTitle(file, legacyTitle),
        };
    });

interface ListedRuleFiles {
    canEdit: boolean;
    files: { content: string; description?: string; globs?: string[]; id: string; mode: RuleFileMode; title: string }[];
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
 * save (`focusRequest`). `deleteFocusRequest` moves focus to its Delete button, where a deleted file's focus lands.
 */
const RuleFileFields: FC<{
    deleteFocusRequest: number;
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
}> = ({ deleteFocusRequest, errorId, file, focusRequest, index, invalid, isFirst, isLast, onChange, onMove, onRemove, onSave }) => {
    const { t } = useLingui();
    const id = useId();
    const name = file.title.trim() || t`Rule file ${index + 1}`;
    const invalidProps = (field: RuleFileField) => (invalid === field ? { "aria-describedby": errorId, "aria-invalid": true } : {});
    // Inside the project's form: Enter in a one-line field saves the rule files, the editor's own action, never the project.
    const saveOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) {
            return;
        }

        event.preventDefault();
        onSave();
    };

    // By id, not a ref: `Textarea` would hand a ref past its field control's own (`packages/ui` `Textarea`).
    useEffect(() => {
        if (invalid) {
            document.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${invalid}`)}`)?.focus();
        }
    }, [focusRequest, id, invalid]);

    // The request this row was mounted with is not its own: a row mounted again keeps focus where it is.
    const handledDelete = useRef(deleteFocusRequest);

    useEffect(() => {
        if (deleteFocusRequest === handledDelete.current) {
            return;
        }

        handledDelete.current = deleteFocusRequest;

        if (deleteFocusRequest > 0) {
            document.querySelector<HTMLElement>(`#${CSS.escape(`${id}-delete`)}`)?.focus();
        }
    }, [deleteFocusRequest, id]);

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
                        onKeyDown={saveOnEnter}
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
                <Button aria-label={t`Delete ${name}`} id={`${id}-delete`} onClick={onRemove} size="icon" type="button" variant="ghost">
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
                    <Label className="flex items-center gap-2 font-normal">
                        <RadioGroupItem value="auto" />
                        {t`When needed`}
                    </Label>
                </RadioGroup>
            </div>
            {file.mode === "auto" && (
                <div className="space-y-1">
                    <Label htmlFor={`${id}-description`}>
                        {t`When to read it`}
                        <span aria-hidden="true" className="text-destructive">
                            *
                        </span>
                    </Label>
                    <Input
                        aria-required="true"
                        autoComplete="off"
                        id={`${id}-description`}
                        maxLength={MAX_RULE_DESCRIPTION_LENGTH}
                        onChange={(event) => onChange({ ...file, description: event.target.value })}
                        onKeyDown={saveOnEnter}
                        placeholder={t`For example: how we write database migrations`}
                        value={file.description}
                        {...invalidProps("description")}
                    />
                    <p className="text-muted-foreground text-xs">{t`Chats see the name and this line, and read the file when it applies.`}</p>
                </div>
            )}
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

/** The ids an element is described by, or none: `aria-describedby` with no id left. */
const describedBy = (ids: (string | false | undefined)[]): string | undefined => {
    const present = ids.filter((id): id is string => typeof id === "string" && id !== "");

    return present.length > 0 ? present.join(" ") : undefined;
};

/**
 * A project's rule files: instructions added to the project's runs, each always or only when the run's files match its
 * patterns. Edited as one list and saved together (`setProjectRuleFiles`), so adding, changing, reordering and deleting
 * are one save. A project's older single context shows as its first file. Only the project's owner edits them, the
 * rule of the project's other settings; others read them. `onDirtyChange` says whether unsaved changes are open, and
 * `onSavingChange` whether a save is on its way: it cannot be called back, so nothing may offer to discard it meanwhile.
 * `blockedSaveRequest` counts the project saves refused for those changes: each says so beside Save and focuses it.
 */
const ProjectRuleFiles: FC<{
    blockedSaveRequest?: number;
    onDirtyChange?: (dirty: boolean) => void;
    onSavingChange?: (saving: boolean) => void;
    projectId: string;
}> = ({ blockedSaveRequest = 0, onDirtyChange, onSavingChange, projectId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const errorId = useId();
    const blockedId = useId();
    const saveId = useId();
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
    // Where focus goes after a Delete: the file now in the deleted one's place, else the one before it, else the Add
    // button (`null`); counted, so each Delete moves it again.
    const [afterRemove, setAfterRemove] = useState<{ count: number; fileId: string | null }>({ count: 0, fileId: null });
    const addId = useId();
    const legacyTitle = t`Project context`;
    const savedFiles = (data?.files ?? []).map((file) =>
        // The older single context arrives under the backend's English name; it shows in the person's language.
        toDraft(file.id === LEGACY_CONTEXT_ID && file.title === LEGACY_CONTEXT_TITLE ? { ...file, title: legacyTitle } : file),
    );
    const files = draft ?? savedFiles;
    const canEdit = data?.canEdit === true;
    const isDirty = draft !== null;
    // An older context longer than a rule file may be, left exactly as it was (first, same name, mode and text): it stays
    // first, as the backend keeps it, and while it is kept no move takes it or puts another file above it. Any change to
    // it makes it an ordinary file, held to the limits.
    const legacy = savedFiles[0];
    const keptLegacyId =
        legacy && legacy.id === data?.legacyContextId && legacy.content.length > MAX_RULE_FILE_LENGTH && sameFile(files[0], legacy) ? legacy.id : undefined;

    const isSaving = saved.isPending;

    // Whether the project's save was refused for these changes; cleared once a save of them starts or they are discarded.
    const [blocked, setBlocked] = useState(false);
    const [seenBlockedSave, setSeenBlockedSave] = useState(blockedSaveRequest);

    if (seenBlockedSave !== blockedSaveRequest) {
        setSeenBlockedSave(blockedSaveRequest);
        setBlocked(true);
    }

    const showBlocked = blocked && isDirty && !isSaving;
    // The request this section was mounted with is not its own: a section mounted again keeps focus where it is.
    const handledBlockedSave = useRef(blockedSaveRequest);

    // By id, as the rows do: the refused project save leaves focus on the button that saves these changes.
    useEffect(() => {
        if (blockedSaveRequest === handledBlockedSave.current) {
            return;
        }

        handledBlockedSave.current = blockedSaveRequest;
        document.querySelector<HTMLElement>(`#${CSS.escape(saveId)}`)?.focus();
    }, [blockedSaveRequest, saveId]);

    useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    useEffect(() => {
        onSavingChange?.(isSaving);
    }, [isSaving, onSavingChange]);

    /** How a file's mode reads where it cannot be changed. */
    const modeLabel = (file: RuleFileDraft): string => {
        if (file.mode === "always") {
            return t`Always`;
        }

        return file.mode === "auto" ? t`When needed` : patternsOf(file.patterns).join(", ");
    };

    const conflictMessage = t`These rule files were changed meanwhile. Discard your changes to see the saved ones, then edit again.`;

    const fileInput = useRef<HTMLInputElement>(null);
    const folderInput = useRef<HTMLInputElement>(null);
    // What the last import added, said beside its buttons.
    const [importNote, setImportNote] = useState("");
    // One import at a time: its buttons wait while the picked files are read.
    const [importing, setImporting] = useState(false);
    // The list, its revision and the draft as last rendered: an import applies onto them once its files are read, never
    // onto the ones it started with (a save, an edit or a read may have landed meanwhile).
    const latest = useRef({ draft, keptLegacyId, revision: data?.revision ?? "", savedFiles });
    // Bumped by Discard: an import still reading then adds nothing.
    const importGeneration = useRef(0);
    // Aborted by Discard, so an import waiting on someone else (a computer's approval) ends then, not when they answer.
    const importDiscard = useRef<AbortController | undefined>(undefined);
    // Bumped by each import that adds drafts: a save it lands during keeps them, and does not say the list is saved.
    const importsApplied = useRef(0);
    // Bumped by each import that leaves a note, drafts or not: a save it lands during keeps the note.
    const importNotes = useRef(0);

    // Before any later event's handler can run, so an import never applies onto a list older than the one shown.
    useLayoutEffect(() => {
        latest.current = { draft, keptLegacyId, revision: data?.revision ?? "", savedFiles };
    });

    const change = (next: RuleFileDraft[]) => {
        if (draft === null) {
            setBaseRevision(data?.revision ?? "");
        }

        setDraft(next);
        setStatus("");
        setImportNote("");
    };

    /** Adds what was read and says what was left out; gives back the paths of those added. */
    const applyImport = (read: RepoImportResult): string[] => {
        // Onto the list as it is now: edits typed, a save or a list read while the files were read stay, and only the
        // room left now is taken. A file a save would refuse for its length, or for the list's size with those before
        // it, is left out and said, as the save would measure it.
        const now = latest.current;
        const base = now.draft ?? now.savedFiles;
        const added: RuleFileDraft[] = [];
        const addedPaths: string[] = [];
        const skipped = [...read.skipped];
        const tooLarge: string[] = [];
        let bytes = ruleFilesStoredBytes(
            toSaved(
                base.filter((file) => file.id !== now.keptLegacyId),
                legacyTitle,
            ),
        );

        // A name longer than a save takes (a repository's file name) is cut to fit, and told apart from the others.
        const titles = new Set(base.map((file) => file.title));
        let shortened = 0;
        let renamed = 0;

        for (const { path, ...file } of read.imported) {
            // A name opening the id form, which a save refuses (a file named `id:setup.md`), is renamed and said.
            const unreserved = unreservedTitle(file.title);
            const title = fitTitle(unreserved, titles, MAX_RULE_TITLE_LENGTH);
            const draftFile = { ...file, id: crypto.randomUUID(), title };
            // What it adds to the stored list: its JSON, and a comma after the one before it.
            const cost = ruleFilesStoredBytes(toSaved([draftFile], legacyTitle)) - (bytes > 2 ? 1 : 2);

            if (base.length + added.length >= MAX_RULE_FILES) {
                skipped.push(path);
            } else if (file.content.length > MAX_RULE_FILE_LENGTH || bytes + cost > MAX_RULE_FILES_BYTES) {
                tooLarge.push(path);
            } else {
                added.push(draftFile);
                addedPaths.push(path);
                titles.add(title);
                shortened += title === unreserved ? 0 : 1;
                renamed += unreserved === file.title ? 0 : 1;
                bytes += cost;
            }
        }

        if (added.length > 0) {
            if (now.draft === null) {
                setBaseRevision(now.revision);
            }

            importsApplied.current += 1;
            setDraft([...base, ...added]);
            setStatus("");
        }

        const toSet = added.filter((file) => needsMode(file)).length;
        const noneFound = read.imported.length === 0 && read.unreadable.length === 0 && read.notRead === 0 ? [t`No Markdown files were found to import.`] : [];
        const addedNote =
            added.length > 0 ? [t`${plural(added.length, { one: "# rule file imported.", other: "# rule files imported." })} Review, then save.`] : noneFound;
        const setNote = t`${plural(toSet, { one: "# file says nothing about when it applies", other: "# files say nothing about when they apply" })}: set a description or another mode.`;
        const limit = formatNumber(MAX_RULE_FILES, i18n.locale);
        // The files left out by name, so the person knows which to shorten or add by hand: the first few, then how many more.
        const named = (paths: ReadonlyArray<string>): string => {
            const more = paths.length - NAMED_LEFT_OUT;
            const shown = paths.toSorted((left, right) => left.localeCompare(right)).slice(0, NAMED_LEFT_OUT);

            return new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(
                more > 0 ? [...shown, plural(more, { one: "# more", other: "# more" })] : shown,
            );
        };
        const skippedCount = skipped.length;
        const skippedNames = named(skipped);
        const left = t`${plural(skippedCount, { one: "# file was left out.", other: "# files were left out." })} A project holds at most ${limit} rule files. Left out: ${skippedNames}.`;
        const unreadableCount = read.unreadable.length;
        const unreadableNames = named(read.unreadable);
        const unreadable = t`${plural(unreadableCount, { one: "# file could not be read", other: "# files could not be read" })}: gone from the repository or too large. Not read: ${unreadableNames}.`;
        const { duplicates } = read;
        const duplicatesNote = t`${plural(duplicates, { one: "# file was left out as the same file as another picked", other: "# files were left out as the same file as another picked" })}: the same text would apply twice.`;
        const notRead = t`${plural(read.notRead, { one: "# file was not read this time", other: "# files were not read this time" })}: import again to add the rest.`;
        const length = formatNumber(MAX_RULE_FILE_LENGTH, i18n.locale);
        const size = formatNumber(MAX_RULE_FILES_BYTES / 1_000_000, i18n.locale);
        const tooLargeCount = tooLarge.length;
        const tooLargeNames = named(tooLarge);
        const tooLargeNote = t`${plural(tooLargeCount, { one: "# file was left out as too large", other: "# files were left out as too large" })}: a rule file holds at most ${length} characters, and all of a project's together at most ${size} MB. Too large: ${tooLargeNames}.`;

        const titleLimit = formatNumber(MAX_RULE_TITLE_LENGTH, i18n.locale);
        const shortenedNote = t`${plural(shortened, { one: "# name was", other: "# names were" })} shortened to ${titleLimit} characters.`;
        const renamedNote = t`${plural(renamed, { one: "# name opened with id:, which names a file by its id, so it now opens with id-", other: "# names opened with id:, which names a file by its id, so they now open with id-" })} instead.`;

        importNotes.current += 1;
        setImportNote(
            [
                ...addedNote,
                ...(shortened > 0 ? [shortenedNote] : []),
                ...(renamed > 0 ? [renamedNote] : []),
                ...(toSet > 0 ? [setNote] : []),
                ...(skipped.length > 0 ? [left] : []),
                ...(tooLarge.length > 0 ? [tooLargeNote] : []),
                ...(duplicates > 0 ? [duplicatesNote] : []),
                ...(read.unreadable.length > 0 ? [unreadable] : []),
                ...(read.notRead > 0 ? [notRead] : []),
            ].join(" "),
        );

        return addedPaths;
    };

    /**
     * Adds what `read` imports as unsaved drafts, up to the project's limit; the person saves them like any edit. One
     * import at a time: one asked for while another reads is dropped. `onApplied` hears the paths added, so a panel
     * keeps those the project had no room for picked. `discarded` is aborted by a Discard, which frees the editor at once.
     */
    const runImport = (
        read: (isCurrent: () => boolean, discarded: AbortSignal) => Promise<RepoImportResult | null>,
        onApplied?: (added: ReadonlyArray<string>) => void,
    ) => {
        if (importing) {
            return;
        }

        const generation = importGeneration.current;
        const discard = new AbortController();

        const isCurrent = () => generation === importGeneration.current;

        importDiscard.current = discard;
        setImporting(true);
        read(isCurrent, discard.signal)
            // An import a Discard overtook adds nothing.
            .then((result) => {
                if (!result || !isCurrent()) {
                    return undefined;
                }

                // Applied first: an optional call skips its arguments when there is no one to hear.
                const added = applyImport(result);

                onApplied?.(added);

                return undefined;
            })
            .catch(() => {
                // One a Discard overtook says nothing either.
                if (!isCurrent()) {
                    return;
                }

                importNotes.current += 1;
                setImportNote(t`The files could not be read.`);
            })
            // One a Discard overtook was freed by it: another may be running by now.
            .then(() => {
                if (isCurrent()) {
                    setImporting(false);
                }

                return undefined;
            })
            .catch(() => undefined);
    };

    /** Reads the picked files: up to the project's limit, not the room left now, as a draft removed meanwhile frees room. */
    const onImport = (event: ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        const picked = [...(input.files ?? [])];

        // Cleared, so picking the same file again imports it again.
        input.value = "";

        if (picked.length > 0) {
            runImport(async () => {
                return { ...(await importRuleFiles(picked, MAX_RULE_FILES)), duplicates: 0, notRead: 0, unreadable: [] };
            });
        }
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
            [RULE_FILE_REFUSALS.DESCRIPTION_INVALID]: () => {
                const limit = numberOf(MAX_RULE_DESCRIPTION_LENGTH);

                return t`The description of "${name}" must be at most ${limit} characters on one line.`;
            },
            [RULE_FILE_REFUSALS.DESCRIPTION_MISSING]: () => t`A file read when needed needs a line saying when to read it.`,
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
            [RULE_FILE_REFUSALS.TITLE_RESERVED]: () => t`A rule file's name may not start with "id:". Rename "${name}".`,
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

        // A name the file already has saved keeps saving, as the backend keeps it.
        if (isRuleTitleReserved(title, savedFiles.find((stored) => stored.id === file.id)?.title)) {
            return RULE_FILE_REFUSALS.TITLE_RESERVED;
        }

        // In the backend's order, so a file past two limits is refused for the same one either way.
        if (file.id !== keptLegacyId && file.content.length > MAX_RULE_FILE_LENGTH) {
            return RULE_FILE_REFUSALS.CONTENT_TOO_LONG;
        }

        if (file.mode === "auto" && !isRuleDescriptionValid(file.description)) {
            return file.description.trim() ? RULE_FILE_REFUSALS.DESCRIPTION_INVALID : RULE_FILE_REFUSALS.DESCRIPTION_MISSING;
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

        // A kept legacy context is one of the project's files too, though it is not sent: `files` counts it.
        if (files.length > MAX_RULE_FILES) {
            return problemOf(RULE_FILE_REFUSALS.TOO_MANY, undefined);
        }

        const ruleFiles = sentFiles();

        // Measured as the backend stores them, so the editor and the save agree to the byte.
        return ruleFilesStoredBytes(ruleFiles) > MAX_RULE_FILES_BYTES ? problemOf(RULE_FILE_REFUSALS.TOO_LARGE, undefined) : undefined;
    };

    /** Shows `refusal`: the error, its field marked invalid and focused when it names one. */
    const showProblem = (refusal: RuleFileProblem) => {
        setInvalid(refusal.field && refusal.fileId !== undefined ? { field: refusal.field, fileId: refusal.fileId } : undefined);
        setError(refusal.message);
        setFocusRequest((count) => count + 1);
    };

    /** Deletes the file at `index`, and moves focus to the file in its place, the one before it, or the Add button. */
    const remove = (index: number) => {
        const next = files[index + 1] ?? files[index - 1];

        change(files.filter((_, position) => position !== index));
        setAfterRemove((current) => {
            return { count: current.count + 1, fileId: next?.id ?? null };
        });
    };

    useEffect(() => {
        if (afterRemove.count > 0 && afterRemove.fileId === null) {
            document.querySelector<HTMLElement>(`#${CSS.escape(addId)}`)?.focus();
        }
    }, [addId, afterRemove]);

    const save = async () => {
        setBlocked(false);

        const refusal = problem();

        if (refusal) {
            showProblem(refusal);

            return;
        }

        setInvalid(undefined);

        const submitted = draft;
        const ruleFiles = sentFiles();
        const keep = keptLegacyId === undefined ? {} : { keepContext: true };
        const importsBefore = importsApplied.current;
        const notesBefore = importNotes.current;

        try {
            const written = await saved.mutateAsync({ ...args, ...keep, revision: baseRevision, ruleFiles });

            // The list as written shows at once, before any read lands: the cached one is the list from before the save.
            queryClient.setQueryData(listOptions.queryKey, (current: typeof data) => withSavedFiles(current, written, keptLegacyId));
            // Edits typed while the save ran stay, now based on the list just saved.
            setDraft((current) => (current === submitted ? null : current));
            setBaseRevision(written.revision);
            setError(undefined);

            // An import that landed while the save ran left unsaved drafts on top of the list just saved, or a note saying
            // why it added none: that note stays.
            if (importsApplied.current === importsBefore) {
                setStatus(t`Rule files saved.`);
            }

            if (importNotes.current === notesBefore) {
                setImportNote("");
            }

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
                    {t`Instructions added to this project's chats: always, only when the chat's attached files match a pattern such as **/*.sql, or read by the chat when it needs them.`}
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
                                <Badge variant="outline">{modeLabel(file)}</Badge>
                            </div>
                            {file.mode === "auto" && <p className="text-muted-foreground text-xs">{file.description}</p>}
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
                                    deleteFocusRequest={afterRemove.fileId === file.id ? afterRemove.count : 0}
                                    errorId={errorId}
                                    file={file}
                                    focusRequest={focusRequest}
                                    index={index}
                                    invalid={invalid?.fileId === file.id ? invalid.field : undefined}
                                    isFirst={index === 0 || (index === 1 && keptLegacyId !== undefined)}
                                    isLast={index === files.length - 1 || file.id === keptLegacyId}
                                    key={file.id}
                                    onChange={(next) => change(files.map((current) => (current.id === file.id ? next : current)))}
                                    onMove={(offset) => change(moved(files, index, offset))}
                                    onRemove={() => remove(index)}
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
                            id={addId}
                            onClick={() =>
                                change([...files, { content: "", description: "", id: crypto.randomUUID(), mode: "always", patterns: "", title: "" }])
                            }
                            size="sm"
                            type="button"
                            variant="outline"
                        >
                            <Plus aria-hidden="true" className="size-4" />
                            {t`Add rule file`}
                        </Button>
                        <Button
                            disabled={importing || files.length >= MAX_RULE_FILES}
                            onClick={() => fileInput.current?.click()}
                            size="sm"
                            title={t`An AGENTS.md, CLAUDE.md or GEMINI.md file, or other Markdown files`}
                            type="button"
                            variant="outline"
                        >
                            <FileUp aria-hidden="true" className="size-4" />
                            {t`Import files`}
                        </Button>
                        <Button
                            disabled={importing || files.length >= MAX_RULE_FILES}
                            onClick={() => folderInput.current?.click()}
                            size="sm"
                            type="button"
                            variant="outline"
                        >
                            <FolderUp aria-hidden="true" className="size-4" />
                            {t`Import rule folder`}
                        </Button>
                        <RepoRuleFileImport disabled={importing || files.length >= MAX_RULE_FILES} projectId={projectId} runImport={runImport} />
                        <input
                            accept=".md,.mdc,.markdown,text/markdown"
                            aria-hidden="true"
                            className="hidden"
                            data-testid="rule-file-import"
                            multiple
                            onChange={onImport}
                            ref={fileInput}
                            tabIndex={-1}
                            type="file"
                        />
                        {/* `webkitdirectory` keeps each file's path inside the folder (`webkitRelativePath`). */}
                        <input
                            aria-hidden="true"
                            className="hidden"
                            data-testid="rule-folder-import"
                            multiple
                            onChange={onImport}
                            ref={folderInput}
                            tabIndex={-1}
                            type="file"
                            {...{ directory: "", webkitdirectory: "" }}
                        />
                        <ComputerRuleFileImport disabled={importing || files.length >= MAX_RULE_FILES} runImport={runImport} />
                        {draft && (
                            <>
                                <Button
                                    // A refusal of the whole list names no field: it describes the button that was refused.
                                    aria-describedby={describedBy([showBlocked && blockedId, error && !invalid && errorId])}
                                    disabled={saved.isPending}
                                    id={saveId}
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
                                        // An import still reading is discarded with the rest.
                                        importGeneration.current += 1;
                                        importDiscard.current?.abort();
                                        importDiscard.current = undefined;
                                        setImporting(false);
                                        setDraft(null);
                                        setImportNote("");
                                        setBlocked(false);
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
            {/* Kept mounted, so a screen reader announces each note as it changes. */}
            <p className={importNote ? "text-muted-foreground text-xs" : "sr-only"} role="status">
                {importNote}
            </p>
            {showBlocked && (
                // Read as Save's description once focus lands there; announced itself only when there is no Save to focus.
                <p className="text-destructive text-sm" id={blockedId} role={canEdit ? undefined : "alert"}>
                    {t`Save or discard your rule file changes first.`}
                </p>
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
