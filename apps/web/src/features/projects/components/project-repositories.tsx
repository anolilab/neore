"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { useMutation, useQuery } from "@tanstack/react-query";
import { GitBranch, Plus, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useCRPC } from "@/lib/lunora/crpc";

import type { ProjectRepo } from "../lib/repositories";
import { repoLabel, withDefault } from "../lib/repositories";

/** An entry as `setProjectRepositories` takes it: a new one has no `id` yet. */
type RepoInput = Omit<ProjectRepo, "id"> & { id?: string };

/** Repositories one project lists, at most; mirrors the backend's limit. */
const MAX_REPOSITORIES = 20;

/**
 * The repositories a project's coding-agent runs pick from: URL, default
 * branch, and which one a run picker preselects. Changes apply at once, like
 * the knowledge links beside it — they are not part of the project form.
 */
const ProjectRepositories: FC<{ projectId: string }> = ({ projectId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const labelId = useId();
    const urlId = useId();
    const branchId = useId();
    const [url, setUrl] = useState("");
    const [branch, setBranch] = useState("");
    const { data: project } = useQuery(crpc.projects.functions.getProject.queryOptions({ projectId: projectId as Id<"projects"> }));
    const { isPending, mutateAsync: save } = useMutation(crpc.projects.functions.setProjectRepositories.mutationOptions());
    const repositories: ProjectRepo[] = project?.repositories ?? [];

    const write = async (next: RepoInput[]): Promise<boolean> => {
        try {
            await save({ projectId: projectId as Id<"projects">, repositories: next });

            return true;
        } catch (error) {
            toast.error(getLocalizedError({ error, t }));

            return false;
        }
    };

    const add = async () => {
        const trimmed = url.trim();

        if (!trimmed) {
            return;
        }

        // The server gives a new entry its id.
        const added = await write([...repositories, { url: trimmed, ...(branch.trim() && { defaultBranch: branch.trim() }) }]);

        if (added) {
            setUrl("");
            setBranch("");
        }
    };

    return (
        <section aria-labelledby={labelId} className="bg-muted/30 space-y-3 rounded-lg border p-4">
            <div className="space-y-1">
                <Label className="text-sm font-medium" id={labelId}>{t`Repositories`}</Label>
                <p className="text-muted-foreground text-xs">{t`Coding-agent runs in this project offer these repositories, with the default preselected.`}</p>
            </div>

            {repositories.length > 0 && (
                <ul className="space-y-1.5">
                    {repositories.map((repo) => {
                        const name = repoLabel(repo.url);

                        return (
                            <li className="flex items-center gap-2 text-sm" key={repo.id}>
                                <span className="min-w-0 flex-1 truncate font-mono" title={repo.url}>
                                    {name}
                                </span>
                                {repo.defaultBranch && (
                                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                                        <GitBranch aria-hidden="true" className="size-3" />
                                        <span className="sr-only">{t`Default branch:`}</span>
                                        {repo.defaultBranch}
                                    </span>
                                )}
                                {repo.isDefault ? (
                                    <Badge variant="secondary">{t`Default`}</Badge>
                                ) : (
                                    <Button
                                        aria-label={t`Make ${name} the default repository`}
                                        disabled={isPending}
                                        onClick={() => {
                                            void write(withDefault(repositories, repo.id));
                                        }}
                                        size="sm"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {t`Make default`}
                                    </Button>
                                )}
                                <Button
                                    aria-label={t`Remove ${name}`}
                                    disabled={isPending}
                                    onClick={() => {
                                        void write(repositories.filter((other) => other.id !== repo.id));
                                    }}
                                    size="icon"
                                    type="button"
                                    variant="ghost"
                                >
                                    <Trash2 aria-hidden="true" className="size-4" />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {repositories.length < MAX_REPOSITORIES && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
                    <div className="space-y-1">
                        <Label className="text-xs" htmlFor={urlId}>{t`Repository`}</Label>
                        <Input
                            autoComplete="off"
                            className="font-mono"
                            id={urlId}
                            onChange={(event) => setUrl(event.target.value)}
                            onKeyDown={(event) => {
                                // Inside the project form: Enter adds the repository, it does not submit the form.
                                if (event.key !== "Enter") {
                                    return;
                                }

                                event.preventDefault();
                                void add();
                            }}
                            placeholder="owner/repo"
                            value={url}
                        />
                    </div>
                    <div className="space-y-1">
                        <Label className="text-xs" htmlFor={branchId}>{t`Default branch`}</Label>
                        <Input
                            autoComplete="off"
                            className="font-mono"
                            id={branchId}
                            onChange={(event) => setBranch(event.target.value)}
                            placeholder={t`optional`}
                            value={branch}
                        />
                    </div>
                    <Button
                        disabled={isPending || !url.trim()}
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
        </section>
    );
};

export default ProjectRepositories;
