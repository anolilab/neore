"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { MAX_RULE_FILE_LENGTH, MAX_RULE_FILES } from "@neore/backend/rule-file-limits";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { useAction, useCRPC } from "@/lib/lunora/crpc";

import type { ImportedRuleTexts } from "../lib/rule-file-import";
import { importRuleTexts, isWholeInstructionFile } from "../lib/rule-file-import";

/**
 * What a repository import read: the files as the upload import turns them into drafts (`skipped`: the paths past the
 * room), the paths it could not read (gone or too large), the links it refused to follow (`refused`: one that, followed
 * again, no longer leads to a file the listing offered), how many it had no requests left for (`notRead`), which another
 * import reads, and picks left out as the same file as another picked (`duplicates`: a link such as
 * `CLAUDE.md → AGENTS.md`, whose text would apply twice).
 */
export interface RepoImportResult extends ImportedRuleTexts {
    duplicates: number;
    notRead: number;
    refused: string[];
    unreadable: string[];
}

/** Why a symlink is not followed (`LinkRefusal` in `source-control/repo-rule-files.ts`): listed, never read. */
type LinkRefusal = "broken" | "budget" | "outside" | "too_deep" | "too_long";

/**
 * `linkOf`: for a symlink followed, the path it leads to; `refused`: one not followed, with why; `sha`: the blob the read
 * takes for it, which it sends back.
 */
type FoundFile = { linkOf?: string; path: string; refused?: LinkRefusal; sha?: string; size: number; tooLarge: boolean };

/** Whether a found file can be picked at all. */
const isPickable = (file: FoundFile): boolean => !file.tooLarge && file.refused === undefined;

/** One listing: the repository and commit it read, so the import reads those files there and nowhere else. */
interface Listing {
    commit: string | undefined;
    files: FoundFile[];
    /** Files of the rules folder past what one listing holds, not shown. */
    omitted: number;
    repoId: string;
    truncated: boolean;
}

type Failure = "budget_spent" | "forbidden" | "host_error" | "needs_reconnect" | "not_connected" | "not_found" | "rate_limited" | "unsupported_host";

const HOST_PREFIX = /^https:\/\/[^/]+\//u;
const GIT_SUFFIX = /\.git$/u;

/** A repository URL as the person reads it: its path on the host. */
const repoName = (url: string): string => url.replace(HOST_PREFIX, "").replace(GIT_SUFFIX, "");

/**
 * Whether a found file may hold more characters than a rule file may: its bytes say so only past that many (a character
 * is one byte or more), so it is offered but not ticked, and the read refuses it if it does.
 */
const mayBeTooLong = (file: FoundFile): boolean => isPickable(file) && file.size > MAX_RULE_FILE_LENGTH;

/**
 * What makes two picks one draft: the same file read the same way. Only a link is another path's file (`linkOf`): two
 * files with equal bytes are two rule files, with their own names. A root instruction file is imported whole, a rules
 * folder's file by its front matter, so a link from one to the other makes two different drafts.
 */
const draftKey = (file: FoundFile): string => `${isWholeInstructionFile(file.path) ? "whole" : "rule"}:${file.linkOf ?? file.path}`;

/**
 * One of `paths` (sorted by path) per draft, in their order: the file a link leads to when it is among them, else the
 * first. A path not in `byPath` is kept.
 */
const onePerDraft = (paths: ReadonlyArray<string>, byPath: ReadonlyMap<string, FoundFile>): string[] => {
    const kept = new Map<string, string>();

    for (const path of paths) {
        const file = byPath.get(path);

        if (file === undefined) {
            continue;
        }

        const key = draftKey(file);
        const earlier = kept.get(key);

        if (earlier === undefined || (file.linkOf === undefined && byPath.get(earlier)?.linkOf !== undefined)) {
            kept.set(key, path);
        }
    }

    const keep = new Set(kept.values());

    return paths.filter((path) => !byPath.has(path) || keep.has(path));
};

/** For each pickable file whose draft another makes (a link to it, or another link to its target), that file's path. */
const sameFileAs = (files: ReadonlyArray<FoundFile>): Map<string, string> => {
    const pickable = files.filter((file) => isPickable(file)).toSorted((left, right) => left.path.localeCompare(right.path));
    const byPath = new Map(pickable.map((file) => [file.path, file]));
    const keep = new Set(onePerDraft([...byPath.keys()], byPath));
    const kept = new Map(pickable.filter((file) => keep.has(file.path)).map((file) => [draftKey(file), file.path]));
    const same = new Map<string, string>();

    for (const file of pickable) {
        const keeper = kept.get(draftKey(file));

        if (keeper !== undefined && keeper !== file.path) {
            same.set(file.path, keeper);
        }
    }

    return same;
};

/**
 * Rule files from one of the project's repositories (`listRepoRuleFiles`, `readRepoRuleFiles`): the person picks the
 * repository, sees which instruction files it holds, picks them, and `runImport` reads them and adds them as drafts (`null`: a failure the panel shows, nothing added).
 * `isCurrent` says whether the import is still wanted (a Discard drops it): one that is not changes nothing here either.
 * Nothing is read from the repository before a click. Hidden when the project lists no repository.
 */
const RepoRuleFileImport: FC<{
    disabled: boolean;
    projectId: string;
    runImport: (read: (isCurrent: () => boolean) => Promise<RepoImportResult | null>) => void;
}> = ({ disabled, projectId, runImport }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const {
        data: repositories,
        isError: reposFailed,
        isFetching: reposLoading,
        refetch: refetchRepos,
    } = useQuery(crpc.projects.functions.listProjectRepos.queryOptions({ projectId: projectId as Id<"projects"> }));
    const listFiles = useAction(api.projects.rule_file_repo.listRepoRuleFiles);
    const readFiles = useAction(api.projects.rule_file_repo.readRepoRuleFiles);
    const [open, setOpen] = useState(false);
    const [repoId, setRepoId] = useState<string | undefined>(undefined);
    const [listed, setListed] = useState<Listing | undefined>(undefined);
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
    // The person's latest picks and a count of their changes, read when a read answers: changes made while it read stay.
    const latestPicks = useRef<ReadonlySet<string>>(picked);
    const pickChanges = useRef(0);
    const [looking, setLooking] = useState(false);
    // With the repository it is about: one a refresh replaced meanwhile shows none.
    const [failure, setFailure] = useState<{ reason: Failure | "unknown"; repoId: string } | undefined>(undefined);
    // Counts the panel's requests: an answer to one a switch, a Cancel or a newer request overtook is dropped.
    const request = useRef(0);
    const triggerId = useId();
    // Opening moves focus to the panel's heading, closing back to the button that opens it.
    const [focusRequest, setFocusRequest] = useState(0);

    useEffect(() => {
        if (focusRequest > 0) {
            document.querySelector<HTMLElement>(`#${CSS.escape(open ? headingId : triggerId)}`)?.focus();
        }
    }, [focusRequest, headingId, open, triggerId]);

    if (!repositories && reposFailed) {
        return (
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-destructive text-sm" role="alert">
                    {t`The project's repositories could not be loaded, so importing from one is not available.`}
                </p>
                <Button
                    disabled={reposLoading}
                    focusableWhenDisabled
                    onClick={() => refetchRepos().catch(() => undefined)}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    {t`Try again`}
                </Button>
            </div>
        );
    }

    /** Opens or closes the panel, dropping whatever it was asking for. */
    const toggle = (next: boolean) => {
        request.current += 1;
        setOpen(next);
        setListed(undefined);
        setFailure(undefined);
        setLooking(false);
        setFocusRequest((count) => count + 1);
    };

    /** Sets the picks, as the panel's own (`byPerson` false) or as the person's change. */
    const choose = (next: ReadonlySet<string>, byPerson: boolean) => {
        latestPicks.current = next;
        pickChanges.current += byPerson ? 1 : 0;
        setPicked(next);
    };

    const first = repositories?.[0];

    if (!repositories || !first) {
        return null;
    }

    if (!open) {
        return (
            <Button disabled={disabled} focusableWhenDisabled id={triggerId} onClick={() => toggle(true)} size="sm" type="button" variant="outline">
                <GitBranch aria-hidden="true" className="size-4" />
                {t`Import from repository`}
            </Button>
        );
    }

    const chosen = repositories.find((repo) => repo.id === repoId) ?? repositories.find((repo) => repo.isDefault) ?? first;
    // A listing of another repository than the one shown (a refresh removed it, or made another the default) is none.
    const listing = listed?.repoId === chosen.id ? listed : undefined;
    const found = listing?.files;
    const duplicateOf = sameFileAs(found ?? []);
    const shownFailure = failure?.repoId === chosen.id ? failure.reason : undefined;

    const failureText: Record<Failure | "unknown", string> = {
        // Redirects (a renamed repository) spent its requests: a retry meets the same ones, so it does not say to try again.
        budget_spent: t`The repository's listing took too long to read. Give the project the repository's current address, or add the file directly with Import files.`,
        forbidden: t`Your GitHub account cannot read this repository.`,
        host_error: t`GitHub did not answer. Try again in a moment.`,
        needs_reconnect: t`Your GitHub sign-in has expired. Connect GitHub again in Settings → Connectors.`,
        not_connected: t`Connect GitHub in Settings → Connectors to import from a repository.`,
        not_found: t`The repository or its branch was not found.`,
        rate_limited: t`GitHub is limiting requests. Try again in a few minutes.`,
        unknown: t`The repository could not be read.`,
        unsupported_host: t`Only GitHub repositories can be imported from.`,
    };

    const refusalText: Record<LinkRefusal, string> = {
        broken: t`(broken link: what it links to could not be found)`,
        budget: t`(link not followed: this repository holds more links than one search follows)`,
        outside: t`(links to a file outside the ones listed here)`,
        too_deep: t`(links through too many other links)`,
        too_long: t`(link not followed: what it links to has too long a name)`,
    };

    const sameText = (path: string): string => t`(same file as ${path})`;

    const look = () => {
        request.current += 1;
        const asked = request.current;
        const listedRepo = chosen.id;

        setLooking(true);
        setFailure(undefined);
        setListed(undefined);
        listFiles({ projectId: projectId as Id<"projects">, repoId: listedRepo as Id<"projectRepositories"> })
            .then((outcome) => {
                if (asked !== request.current) {
                    return undefined;
                }

                if (outcome.status !== "ok") {
                    setFailure({ reason: outcome.status, repoId: listedRepo });

                    return undefined;
                }

                setListed({ commit: outcome.commit, files: outcome.files, omitted: outcome.omitted ?? 0, repoId: listedRepo, truncated: outcome.truncated });
                // A link to another listed file is not ticked: its text would apply twice.
                const same = sameFileAs(outcome.files);

                choose(
                    new Set(outcome.files.filter((file) => isPickable(file) && !mayBeTooLong(file) && !same.has(file.path)).map((file) => file.path)),
                    false,
                );

                return undefined;
            })
            .catch(() => (asked === request.current ? setFailure({ reason: "unknown", repoId: listedRepo }) : undefined))
            .then(() => (asked === request.current ? setLooking(false) : undefined))
            .catch(() => undefined);
    };

    const importPicked = () => {
        const commit = listing?.commit;

        if (!listing || !commit) {
            return;
        }

        // The repository and commit listed: a branch moved since, or another repository chosen, never changes what is read.
        const readArgs = { commit, projectId: projectId as Id<"projects">, repoId: listing.repoId as Id<"projectRepositories"> };
        // Each with the blob its listing found, so the read follows a link again only to a file past the listing's cap.
        const byPath = new Map(listing.files.map((file) => [file.path, file]));
        // In the order the import takes them, one pick of each draft (a link is its target's text, read the same way):
        // the first a project can hold are read, the rest left out.
        const all = onePerDraft(
            [...picked].toSorted((left, right) => left.localeCompare(right)),
            byPath,
        );
        const duplicates = picked.size - all.length;
        const paths = all.slice(0, MAX_RULE_FILES);
        const files = paths.map((path) => {
            const sha = byPath.get(path)?.sha;

            return sha === undefined ? { path } : { path, sha };
        });

        request.current += 1;
        const asked = request.current;
        const changesAtRead = pickChanges.current;

        // A new try: an earlier one's failure is no longer what happened.
        setFailure(undefined);
        runImport(async (isCurrent) => {
            // A read that failed is said in the panel, as a refusal is.
            const outcome = await readFiles({ ...readArgs, files }).catch(() => undefined);

            // Cancelled, closed or discarded meanwhile: nothing is added, nothing said, the panel left as it is.
            if (asked !== request.current || !isCurrent()) {
                return null;
            }

            if (outcome?.status !== "ok") {
                // Said in the panel, which stays open for another try; nothing is applied.
                setFailure({ reason: outcome?.status ?? "unknown", repoId: readArgs.repoId });

                return null;
            }

            const texts = outcome.files.flatMap((file) => (file.status === "ok" ? [{ path: file.path, text: () => file.text }] : []));
            const notRead = outcome.files.flatMap((file) => (file.status === "not_read" ? [file.path] : []));
            const read = await importRuleTexts(texts, MAX_RULE_FILES);

            // What this read answered, and any pick of a draft it answered: importing again adds nothing twice.
            const keyOf = (path: string): string | undefined => {
                const file = byPath.get(path);

                return file === undefined ? undefined : draftKey(file);
            };
            const answered = new Set(outcome.files.flatMap((file) => (file.status === "not_read" ? [] : [file.path])));
            const answeredKeys = new Set([...answered].flatMap((path) => keyOf(path) ?? []));
            const left = [...latestPicks.current].filter((path) => {
                const key = keyOf(path);

                return !answered.has(path) && (key === undefined || !answeredKeys.has(key));
            });

            // Picks changed while it read stay as the person left them, less those, even none; else only those not read
            // stay ticked, so importing again adds the rest and nothing twice.
            const stillPicked = pickChanges.current === changesAtRead ? notRead : left;

            if (stillPicked.length > 0 || notRead.length > 0) {
                choose(new Set(stillPicked), false);
            } else {
                toggle(false);
            }

            return {
                ...read,
                duplicates,
                // Those still ticked: the note says to import them again.
                notRead: notRead.filter((path) => stillPicked.includes(path)).length,
                skipped: [...read.skipped, ...all.slice(MAX_RULE_FILES)],
                refused: outcome.files.flatMap((file) => (file.status === "refused" ? [file.path] : [])),
                unreadable: outcome.files.flatMap((file) => (file.status === "missing" || file.status === "too_large" ? [file.path] : [])),
            };
        });
    };

    return (
        <section aria-labelledby={headingId} className="w-full space-y-3 rounded-md border p-3" data-testid="repo-rule-file-import">
            <h4 className="text-sm font-medium" id={headingId} tabIndex={-1}>
                {t`Import from repository`}
            </h4>
            {repositories.length > 1 && (
                <RadioGroup
                    aria-label={t`Repository`}
                    disabled={looking}
                    onValueChange={(value) => {
                        request.current += 1;
                        setRepoId(String(value));
                        setListed(undefined);
                        setFailure(undefined);
                    }}
                    value={chosen.id}
                >
                    {repositories.map((repo) => (
                        <Label className="flex items-center gap-2 text-sm font-normal" key={repo.id}>
                            <RadioGroupItem value={repo.id} />
                            {repoName(repo.url)}
                        </Label>
                    ))}
                </RadioGroup>
            )}
            <p className="text-muted-foreground text-xs">
                {repositories.length > 1
                    ? t`Looks for AGENTS.md, CLAUDE.md and GEMINI.md at the repository's root, and for a rules folder.`
                    : t`Looks for AGENTS.md, CLAUDE.md and GEMINI.md at the root of ${repoName(chosen.url)}, and for a rules folder.`}
            </p>
            {/* Kept mounted, so a screen reader announces what the search found. */}
            <p className={found?.length === 0 ? "text-sm" : "sr-only"} role="status">
                {looking && t`Looking for instruction files...`}
                {found?.length === 0 && t`No instruction files were found in this repository.`}
                {found && found.length > 0 && t`Found ${plural(found.length, { one: "# file", other: "# files" })}.`}
            </p>
            {listing?.truncated && (
                <p className="text-muted-foreground text-sm">{t`This repository is too large for GitHub to list in full, so some instruction files may be missing here.`}</p>
            )}
            {listing && listing.omitted > 0 && (
                <p className="text-muted-foreground text-sm">
                    {t`The rules folder holds ${plural(listing.omitted, { one: "# more file", other: "# more files" })} than this list shows.`}
                </p>
            )}
            {found && found.length > 0 && (
                <ul aria-label={t`Files found`} className="space-y-2">
                    {found.map((file) => (
                        <li key={file.path}>
                            <Label className="flex items-center gap-2 text-sm font-normal">
                                <Checkbox
                                    checked={picked.has(file.path)}
                                    disabled={!isPickable(file)}
                                    onCheckedChange={(checked) => {
                                        const next = new Set(latestPicks.current);

                                        if (checked) {
                                            next.add(file.path);
                                        } else {
                                            next.delete(file.path);
                                        }

                                        choose(next, true);
                                    }}
                                />
                                <span className="font-mono text-xs">{file.path}</span>
                                {file.tooLarge && <span className="text-muted-foreground text-xs">{t`(too large)`}</span>}
                                {file.refused && <span className="text-muted-foreground text-xs">{refusalText[file.refused]}</span>}
                                {mayBeTooLong(file) && <span className="text-muted-foreground text-xs">{t`(may be too long)`}</span>}
                                {duplicateOf.has(file.path) && (
                                    <span className="text-muted-foreground text-xs">{sameText(duplicateOf.get(file.path) ?? "")}</span>
                                )}
                            </Label>
                        </li>
                    ))}
                </ul>
            )}
            {shownFailure && (
                <p className="text-destructive text-sm" role="alert">
                    {failureText[shownFailure]}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                {found && found.length > 0 ? (
                    <Button disabled={disabled || picked.size === 0} focusableWhenDisabled onClick={importPicked} size="sm" type="button">
                        {t`Import selected`}
                    </Button>
                ) : (
                    <Button disabled={looking} focusableWhenDisabled onClick={look} size="sm" type="button">
                        {looking ? t`Looking...` : t`Find files`}
                    </Button>
                )}
                <Button onClick={() => toggle(false)} size="sm" type="button" variant="ghost">
                    {t`Cancel`}
                </Button>
            </div>
        </section>
    );
};

export default RepoRuleFileImport;
