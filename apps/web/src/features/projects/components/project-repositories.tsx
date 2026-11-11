"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus, Trash2 } from "lucide-react";
import type { FC, KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useCRPC, useCRPCClient } from "@/lib/lunora/crpc";

import { repoLabels } from "../lib/repositories";

/** Repositories one project lists, at most; mirrors the backend's limit. */
const MAX_REPOSITORIES = 20;

/** What a refused entry carries (`addProjectRepo`): the field to correct, and why. */
const refusalOf = (error: unknown): { field?: unknown; reason?: unknown } => (error as { data?: { field?: unknown; reason?: unknown } } | null)?.data ?? {};

/** How a branch save ended: the row's new revision, or the refusal to show. */
interface BranchSave {
    error?: string;
    revision?: number;
    /** On a stale refusal, the revision the row holds now: the next save names it. */
    staleRevision?: number;
}

/**
 * A listed repository's default branch, saved on Enter or on leaving the field when changed; blank clears it. A refusal
 * shows under this field, linked to it, and the text stays to be corrected. Nothing else is disabled while it saves, so
 * focus moving on (Tab) lands on a live control. Saves run one after another, each naming the revision the one before
 * got back, so a later edit always lands last; a save from a stale view is refused by the server (`updateProjectRepo`).
 */
const RepoBranchInput: FC<{ name: string; onSave: (branch: string, revision: number) => Promise<BranchSave>; revision: number; saved: string }> = ({
    name,
    onSave,
    revision,
    saved,
}) => {
    const { t } = useLingui();
    const errorId = useId();
    const [draft, setDraft] = useState(saved);
    const [shown, setShown] = useState(saved);
    const [error, setError] = useState<string | undefined>(undefined);
    const latest = useRef<{ branch: string | undefined; revision: number }>({ branch: saved, revision });
    const queue = useRef<Promise<void>>(Promise.resolve());

    // A change saved elsewhere replaces the field, unless the person is mid-edit.
    if (saved !== shown) {
        setShown(saved);

        if (draft === shown) {
            setDraft(saved);
        }
    }

    // The live list reporting a newer revision (a save from another tab) is what the next save names.
    useEffect(() => {
        if (revision > latest.current.revision) {
            latest.current = { branch: saved, revision };
        }
    }, [revision, saved]);

    const save = () => {
        const value = draft;

        queue.current = queue.current.then(async () => {
            if (value.trim() === latest.current.branch) {
                setError(undefined);

                return undefined;
            }

            const result = await onSave(value, latest.current.revision);

            if (result.revision !== undefined) {
                latest.current = { branch: value.trim(), revision: result.revision };
            } else if (result.staleRevision !== undefined) {
                // The stored branch is unknown here: no later save is skipped as unchanged.
                latest.current = { branch: undefined, revision: result.staleRevision };
            }

            setError(result.error);

            return undefined;
        });
    };

    return (
        <div className="flex flex-col gap-1">
            <Input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={error !== undefined}
                aria-label={t`Default branch of ${name}`}
                autoComplete="off"
                className="h-8 w-32 font-mono text-xs"
                onBlur={save}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    // Saved once, on the blur this causes.
                    if (event.key !== "Enter") {
                        return;
                    }

                    event.preventDefault();
                    event.currentTarget.blur();
                }}
                placeholder={t`default`}
                value={draft}
            />
            {error && (
                <p className="text-destructive w-32 text-xs" id={errorId} role="alert">
                    {error}
                </p>
            )}
        </div>
    );
};

/**
 * The repositories a project's coding-agent runs pick from: URL, default branch, and which one a run picker
 * preselects. Each change is one call (`addProjectRepo`, `updateProjectRepo`, `removeProjectRepo`, `setDefaultProjectRepo`) and the list
 * re-renders from the live query, so nothing here merges or compares lists. Changes apply at once, like the knowledge
 * links beside it. Only the project's owner (a member, for an organization project nobody owns) changes them.
 */
const ProjectRepositories: FC<{ projectId: string }> = ({ projectId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const labelId = useId();
    const urlId = useId();
    const branchId = useId();
    const errorId = useId();
    const sectionRef = useRef<HTMLElement>(null);
    const urlRef = useRef<HTMLInputElement>(null);
    const [url, setUrl] = useState("");
    const [branch, setBranch] = useState("");
    const [error, setError] = useState<{ field?: unknown; message: string } | undefined>(undefined);
    const args = { projectId: projectId as Id<"projects"> };
    const { data: project, isError: projectFailed, refetch: retryProject } = useQuery(crpc.projects.functions.getProject.queryOptions(args));
    const { data: repositories, isError: loadFailed } = useQuery(crpc.projects.functions.listProjectRepos.queryOptions(args));
    const added = useMutation(crpc.projects.functions.addProjectRepo.mutationOptions());
    const removed = useMutation(crpc.projects.functions.removeProjectRepo.mutationOptions());
    const madeDefault = useMutation(crpc.projects.functions.setDefaultProjectRepo.mutationOptions());
    const updated = useMutation(crpc.projects.functions.updateProjectRepo.mutationOptions());
    const queryClient = useQueryClient();
    const crpcClient = useCRPCClient();
    // The list is live, but after each change, landed or refused, a one-shot read writes the current list into the same
    // cache entry, so the settings never wait on the subscription to report the change. The query's own options stay
    // as they are: `fetchQuery` would replace them, and with them the live marker.
    const refreshList = () => {
        void crpcClient
            .query(api.projects.functions.listProjectRepos, args)
            .then((list) => queryClient.setQueryData(crpc.projects.functions.listProjectRepos.queryKey(args), list))
            .catch(() => undefined);
    };
    const canEdit = !!project && (!project.userId || project.userId === sessionData?.user?.id);
    // Until the session has answered, an owner would read as someone else: say nothing rather than "owner only".
    const readOnly = !!project && !canEdit && sessionData !== undefined;
    // A branch save disables nothing: the control focus moves on to must stay live (`RepoBranchInput`).
    const busy = !repositories || added.isPending || removed.isPending || madeDefault.isPending;

    /** A refusal in the person's language; anything else as the server words it. */
    const messageFor = (changeError: unknown): string => {
        switch (refusalOf(changeError).reason) {
            case "duplicate": {
                return t`This repository is already listed.`;
            }
            case "invalidBranch": {
                return t`This is not a valid branch name.`;
            }
            case "invalidUrl": {
                return t`Use an https:// git URL or GitHub owner/repo`;
            }
            case "limit": {
                return t`A project can list at most ${MAX_REPOSITORIES} repositories.`;
            }
            case "stale": {
                return t`This branch was changed meanwhile. Check it and save again.`;
            }
            case "urlTooLong": {
                return t`This repository URL is too long.`;
            }
            default: {
                return getLocalizedError({ error: changeError, t });
            }
        }
    };

    /** Runs a row's branch change; a refusal comes back for that row to show, never on the Add form. */
    const saveBranch = async (repoId: Id<"projectRepositories">, defaultBranch: string, revision: number): Promise<BranchSave> => {
        try {
            const saved = await updated.mutateAsync({ defaultBranch, repoId, revision });

            refreshList();

            return { revision: saved };
        } catch (changeError) {
            const { revision: current } = refusalOf(changeError) as { revision?: unknown };

            refreshList();

            return { error: messageFor(changeError), ...(typeof current === "number" && { staleRevision: current }) };
        }
    };

    /** Runs one change; a refusal shows its reason, on the field it names. */
    const run = async (change: () => Promise<unknown>): Promise<boolean> => {
        try {
            await change();
            refreshList();
            setError(undefined);

            return true;
        } catch (changeError) {
            refreshList();
            setError({ field: refusalOf(changeError).field, message: messageFor(changeError) });

            return false;
        }
    };

    /** A row's button unmounts once its change lands: keep keyboard focus in the section. */
    const runAndRefocus = async (change: () => Promise<unknown>) => {
        await run(change);
        (urlRef.current ?? sectionRef.current)?.focus();
    };

    const add = async () => {
        if (!url.trim()) {
            return;
        }

        const sentUrl = url;
        const sentBranch = branch;

        const ok = await run(() => added.mutateAsync({ ...args, url: sentUrl, ...(sentBranch.trim() && { defaultBranch: sentBranch }) }));

        // Clear only what was sent: text typed while the save was in flight is a new draft and stays.
        if (ok) {
            setUrl((current) => (current === sentUrl ? "" : current));
            setBranch((current) => (current === sentBranch ? "" : current));
        }
    };

    // Inside the project form: Enter in either field adds the repository, it never submits the form.
    const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "Enter") {
            return;
        }

        event.preventDefault();

        if (!busy) {
            void add();
        }
    };

    const loading = !repositories && !loadFailed;
    const names = repoLabels((repositories ?? []).map((repo) => repo.url));
    const describedBy = (field: string) => (error?.field === field ? errorId : undefined);

    return (
        <section
            aria-busy={loading}
            aria-labelledby={labelId}
            className="bg-muted/30 space-y-3 rounded-lg border p-4 outline-none"
            ref={sectionRef}
            tabIndex={-1}
        >
            <div className="space-y-1">
                <Label className="text-sm font-medium" id={labelId}>{t`Repositories`}</Label>
                <p className="text-muted-foreground text-xs">{t`Coding-agent runs in this project offer these repositories, with the default preselected.`}</p>
            </div>

            {projectFailed && !project && (
                <p className="text-destructive flex items-center gap-2 text-xs" role="alert">
                    {t`Could not load this project, so its repositories cannot be changed.`}
                    <Button
                        onClick={() => {
                            void retryProject();
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                    >
                        {t`Try again`}
                    </Button>
                </p>
            )}

            {/* Always mounted, so its text changing is announced. */}
            <p className="text-muted-foreground text-xs empty:hidden" role="status">
                {loading ? t`Loading repositories…` : ""}
            </p>

            {loadFailed && (
                <p className="text-destructive text-xs" role="alert">
                    {t`Could not load this project's repositories.`}
                </p>
            )}

            {repositories && repositories.length > 0 && (
                <ul className="space-y-1.5">
                    {repositories.map((repo, index) => {
                        // Two entries with one label (`api` and `api.git`) are named by their full URL.
                        const name = names[index] ?? repo.url;
                        const repoId = repo.id as Id<"projectRepositories">;

                        return (
                            <li className="flex items-center gap-2 text-sm" key={repo.id}>
                                <span className="min-w-0 flex-1 truncate font-mono" title={repo.url}>
                                    {name}
                                </span>
                                {canEdit ? (
                                    <RepoBranchInput
                                        name={name}
                                        onSave={async (defaultBranch, revision) => await saveBranch(repoId, defaultBranch, revision)}
                                        revision={repo.revision}
                                        saved={repo.defaultBranch ?? ""}
                                    />
                                ) : (
                                    repo.defaultBranch && (
                                        <span className="text-muted-foreground flex items-center gap-1 text-xs">
                                            <GitBranch aria-hidden="true" className="size-3" />
                                            <span className="sr-only">{t`Default branch:`}</span>
                                            {repo.defaultBranch}
                                        </span>
                                    )
                                )}
                                {repo.isDefault && <Badge variant="secondary">{t`Default`}</Badge>}
                                {canEdit && !repo.isDefault && (
                                    <Button
                                        aria-label={t`Make ${name} the default repository`}
                                        disabled={busy}
                                        onClick={() => {
                                            void runAndRefocus(() => madeDefault.mutateAsync({ repoId }));
                                        }}
                                        size="sm"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {t`Make default`}
                                    </Button>
                                )}
                                {canEdit && (
                                    <Button
                                        aria-label={t`Remove ${name}`}
                                        disabled={busy}
                                        onClick={() => {
                                            void runAndRefocus(() => removed.mutateAsync({ repoId }));
                                        }}
                                        size="icon"
                                        type="button"
                                        variant="ghost"
                                    >
                                        <Trash2 aria-hidden="true" className="size-4" />
                                    </Button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {readOnly && <p className="text-muted-foreground text-xs">{t`Only the project's owner can change its repositories.`}</p>}

            {canEdit && (repositories?.length ?? 0) < MAX_REPOSITORIES && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
                    <div className="space-y-1">
                        <Label className="text-xs" htmlFor={urlId}>
                            {t`Repository`}
                            <span aria-hidden="true" className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input
                            aria-describedby={describedBy("url")}
                            aria-invalid={error?.field === "url"}
                            aria-required="true"
                            autoComplete="off"
                            className="font-mono"
                            id={urlId}
                            onChange={(event) => setUrl(event.target.value)}
                            onKeyDown={onEnter}
                            placeholder="owner/repo"
                            ref={urlRef}
                            value={url}
                        />
                    </div>
                    <div className="space-y-1">
                        <Label className="text-xs" htmlFor={branchId}>{t`Default branch`}</Label>
                        <Input
                            aria-describedby={describedBy("defaultBranch")}
                            aria-invalid={error?.field === "defaultBranch"}
                            autoComplete="off"
                            className="font-mono"
                            id={branchId}
                            onChange={(event) => setBranch(event.target.value)}
                            onKeyDown={onEnter}
                            placeholder={t`optional`}
                            value={branch}
                        />
                    </div>
                    <Button
                        disabled={busy || !url.trim()}
                        onClick={() => {
                            void add();
                        }}
                        type="button"
                        variant="outline"
                    >
                        <Plus aria-hidden="true" className="mr-1.5 size-3.5" />
                        {t`Add`}
                    </Button>
                </div>
            )}

            {error && (
                <p className="text-destructive text-xs" id={errorId} role="alert">
                    {error.message}
                </p>
            )}
        </section>
    );
};

export default ProjectRepositories;
