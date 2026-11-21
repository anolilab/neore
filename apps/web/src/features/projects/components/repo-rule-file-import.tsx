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

import type { ImportedRuleFile } from "../lib/rule-file-import";
import { importRuleTexts } from "../lib/rule-file-import";

/** What a repository import read: the files as the upload import turns them into drafts, and those it could not read. */
export interface RepoImportResult {
    imported: ImportedRuleFile[];
    skipped: number;
    unreadable: number;
}

/** Why a symlink is not followed (`LinkRefusal` in `source-control/repo-rule-files.ts`): listed, never read. */
type LinkRefusal = "broken" | "budget" | "outside" | "too_deep" | "too_long";

/** `refused`: a symlink not followed, with why. */
type FoundFile = { path: string; refused?: LinkRefusal; size: number; tooLarge: boolean };

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

type Failure = "forbidden" | "host_error" | "needs_reconnect" | "not_connected" | "not_found" | "rate_limited" | "unsupported_host";

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
 * Rule files from one of the project's repositories (`listRepoRuleFiles`, `readRepoRuleFiles`): the person picks the
 * repository, sees which instruction files it holds, picks them, and `runImport` reads them and adds them as drafts (`null`: a failure the panel shows, nothing added).
 * Nothing is read from the repository before a click. Hidden when the project lists no repository.
 */
const RepoRuleFileImport: FC<{
    disabled: boolean;
    projectId: string;
    runImport: (read: () => Promise<RepoImportResult | null>) => void;
}> = ({ disabled, projectId, runImport }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const { data: repositories } = useQuery(crpc.projects.functions.listProjectRepos.queryOptions({ projectId: projectId as Id<"projects"> }));
    const listFiles = useAction(api.projects.rule_file_repo.listRepoRuleFiles);
    const readFiles = useAction(api.projects.rule_file_repo.readRepoRuleFiles);
    const [open, setOpen] = useState(false);
    const [repoId, setRepoId] = useState<string | undefined>(undefined);
    const [listed, setListed] = useState<Listing | undefined>(undefined);
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
    const [looking, setLooking] = useState(false);
    const [failure, setFailure] = useState<Failure | "unknown" | undefined>(undefined);
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

    /** Opens or closes the panel, dropping whatever it was asking for. */
    const toggle = (next: boolean) => {
        request.current += 1;
        setOpen(next);
        setListed(undefined);
        setFailure(undefined);
        setLooking(false);
        setFocusRequest((count) => count + 1);
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

    const failureText: Record<Failure | "unknown", string> = {
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
                    setFailure(outcome.status);

                    return undefined;
                }

                setListed({ commit: outcome.commit, files: outcome.files, omitted: outcome.omitted ?? 0, repoId: listedRepo, truncated: outcome.truncated });
                setPicked(new Set(outcome.files.filter((file) => isPickable(file) && !mayBeTooLong(file)).map((file) => file.path)));

                return undefined;
            })
            .catch(() => (asked === request.current ? setFailure("unknown") : undefined))
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
        // In the order the import takes them: the first a project can hold are read, the rest counted as left out.
        const all = [...picked].toSorted((left, right) => left.localeCompare(right));
        const paths = all.slice(0, MAX_RULE_FILES);

        request.current += 1;
        const asked = request.current;

        runImport(async () => {
            // A read that failed is said in the panel, as a refusal is.
            const outcome = await readFiles({ ...readArgs, paths }).catch(() => undefined);

            // Cancelled or closed meanwhile: nothing is added, nothing said.
            if (asked !== request.current) {
                return null;
            }

            if (outcome?.status !== "ok") {
                // Said in the panel, which stays open for another try; nothing is applied.
                setFailure(outcome?.status ?? "unknown");

                return null;
            }

            const texts = outcome.files.flatMap((file) => (file.status === "ok" ? [{ path: file.path, text: () => file.text }] : []));
            const read = await importRuleTexts(texts, MAX_RULE_FILES);

            toggle(false);

            return { ...read, skipped: read.skipped + all.length - paths.length, unreadable: outcome.files.length - texts.length };
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
                                        const next = new Set(picked);

                                        if (checked) {
                                            next.add(file.path);
                                        } else {
                                            next.delete(file.path);
                                        }

                                        setPicked(next);
                                    }}
                                />
                                <span className="font-mono text-xs">{file.path}</span>
                                {file.tooLarge && <span className="text-muted-foreground text-xs">{t`(too large)`}</span>}
                                {file.refused && <span className="text-muted-foreground text-xs">{refusalText[file.refused]}</span>}
                                {mayBeTooLong(file) && <span className="text-muted-foreground text-xs">{t`(may be too long)`}</span>}
                            </Label>
                        </li>
                    ))}
                </ul>
            )}
            {failure && (
                <p className="text-destructive text-sm" role="alert">
                    {failureText[failure]}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                {found && found.length > 0 ? (
                    <Button disabled={disabled || picked.size === 0} onClick={importPicked} size="sm" type="button">
                        {t`Import selected`}
                    </Button>
                ) : (
                    <Button disabled={looking} onClick={look} size="sm" type="button">
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
