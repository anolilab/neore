"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FC } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { repoLabels, storedRepoUrl } from "../lib/repositories";

/** The Select value for "no project": type any repository instead. */
const NO_PROJECT = "__none__";

/** The paging state of the project list the picker reads. */
interface PickerPaging {
    failed: boolean;
    hasMore: boolean;
    isLoadingMore: boolean;
    loadMore: () => void;
    retry: () => void;
}

interface ProjectRepoPickerProps {
    /** The run's branch as it stands: once edited, a slower default never replaces it. */
    branch: string;
    /** Called with the repository picked, or the project's default when a project is picked. */
    onPick: (repo: { defaultBranch?: string; url: string }) => void;
    /** Loads further pages of projects; without it only the projects given are offered. */
    paging?: PickerPaging;
    /** The projects loaded so far. */
    projects: ReadonlyArray<{ _id: string; title: string }>;
    /** The run's repository as it stands, shown as picked when the chosen project lists it. */
    repoUrl: string;
}

/**
 * The coding-agent run picker's project half: pick a project and its repositories (`listProjectRepos`, read for that
 * project only) are offered, its default preselected with its default branch. The repository and branch fields stay
 * editable beside it, so any other repository can still be typed in.
 */
const ProjectRepoPicker: FC<ProjectRepoPickerProps> = ({ branch, onPick, paging, projects, repoUrl }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const projectLabelId = useId();
    const repoLabelId = useId();
    // `undefined` until the person picks: a reopened run shows the project that lists its repository (`findRepoProject`).
    const [pickedProjectId, setProjectId] = useState<string | undefined>(undefined);
    const [openedUrl] = useState(() => repoUrl.trim());
    const { data: openedProject } = useQuery(
        crpc.projects.functions.findRepoProject.queryOptions(pickedProjectId === undefined && openedUrl ? { url: openedUrl } : skipToken, { live: false }),
    );
    const projectId = pickedProjectId ?? openedProject?.projectId ?? NO_PROJECT;
    // Moves on every pick and every change to the run's repository or branch: a slower answer never preselects over a
    // later pick, or over a repository or branch typed in while it was loading.
    const pickGeneration = useRef(0);

    useEffect(() => {
        pickGeneration.current += 1;
    }, [repoUrl, branch]);
    const listFor = (id: string) => crpc.projects.functions.listProjectRepos.queryOptions({ projectId: id as Id<"projects"> });
    const {
        data: repositories = [],
        isError,
        isPending: reposLoading,
    } = useQuery(crpc.projects.functions.listProjectRepos.queryOptions(projectId === NO_PROJECT ? skipToken : { projectId: projectId as Id<"projects"> }));
    const canLoadMore = paging !== undefined && (paging.hasMore || paging.isLoadingMore);

    if (projects.length === 0 && !canLoadMore && paging?.failed !== true) {
        return null;
    }

    // The trigger reads its label from `items`; without them it shows the raw value.
    const projectItems = [
        { label: t`No project`, value: NO_PROJECT },
        ...projects.map((project) => {
            return { label: project.title, value: project._id };
        }),
        // The reopened run's project may be on a page not loaded yet.
        ...(openedProject && projects.every((project) => project._id !== openedProject.projectId)
            ? [{ label: openedProject.title, value: openedProject.projectId }]
            : []),
    ];
    // Two entries with one label are told apart by their full URL.
    const labels = repoLabels(repositories.map((repo) => repo.url));
    const repoItems = repositories.map((repo, index) => {
        return { label: labels[index] ?? repo.url, value: repo.id };
    });
    // Typed as `owner/repo` or without `.git`, a listed repository still shows as picked.
    const typedUrl = storedRepoUrl(repoUrl);
    const pickedRepo = typedUrl === undefined ? undefined : repositories.find((repo) => repo.url === typedUrl);

    const pickProject = async (value: string) => {
        pickGeneration.current += 1;

        const generation = pickGeneration.current;

        setProjectId(value);

        if (value === NO_PROJECT) {
            return;
        }

        const list = await queryClient.fetchQuery(listFor(value)).catch(() => []);
        const preselected = list.find((repo) => repo.isDefault);

        if (preselected && pickGeneration.current === generation) {
            onPick(preselected);
        }
    };

    return (
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
            <div className="space-y-2">
                <Label id={projectLabelId}>{t`Project`}</Label>
                <Select
                    items={projectItems}
                    onValueChange={(value) => {
                        if (typeof value === "string") {
                            void pickProject(value);
                        }
                    }}
                    value={projectId}
                >
                    <SelectTrigger aria-labelledby={projectLabelId}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {projectItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                                {item.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {canLoadMore && (
                    <Button
                        aria-busy={paging.isLoadingMore}
                        aria-disabled={paging.isLoadingMore}
                        onClick={paging.loadMore}
                        size="sm"
                        type="button"
                        variant="ghost"
                    >
                        {paging.isLoadingMore ? t`Loading more projects…` : t`Show more projects`}
                    </Button>
                )}
                {paging?.failed === true && (
                    <p className="text-destructive flex items-center gap-2 text-xs" role="alert">
                        {t`Could not load more projects.`}
                        <Button onClick={paging.retry} size="sm" type="button" variant="ghost">
                            {t`Try again`}
                        </Button>
                    </p>
                )}
            </div>
            {projectId !== NO_PROJECT && (
                <div className="space-y-2">
                    <Label id={repoLabelId}>{t`Project repository`}</Label>
                    <Select
                        items={repoItems}
                        onValueChange={(value) => {
                            const picked = repositories.find((repo) => repo.id === value);

                            if (picked) {
                                onPick(picked);
                            }
                        }}
                        value={pickedRepo?.id ?? ""}
                    >
                        <SelectTrigger aria-busy={reposLoading} aria-labelledby={repoLabelId}>
                            <SelectValue placeholder={t`Pick a repository`} />
                        </SelectTrigger>
                        <SelectContent>
                            {repoItems.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                    <span className="font-mono">{item.label}</span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {isError && (
                        <p className="text-destructive text-xs" role="alert">
                            {t`Could not load this project's repositories.`}
                        </p>
                    )}
                </div>
            )}
            {/* Outside the repository field and always mounted, so the text appearing is announced. */}
            <p className="text-muted-foreground text-xs empty:hidden sm:col-span-2" role="status">
                {projectId !== NO_PROJECT && reposLoading ? t`Loading repositories…` : ""}
            </p>
        </div>
    );
};

export default ProjectRepoPicker;
