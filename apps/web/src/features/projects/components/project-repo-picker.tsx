"use client";

import { useLingui } from "@lingui/react/macro";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import type { FC } from "react";
import { useId, useState } from "react";

import { useProjects } from "../hooks/use-projects";
import type { ProjectRepo } from "../lib/repositories";
import { defaultRepoOf, repoLabel } from "../lib/repositories";

/** The Select value for "no project": type any repository instead. */
const NO_PROJECT = "__none__";

interface ProjectRepoPickerProps {
    /** Called with the repository picked, or the project's default when a project is picked. */
    onPick: (repo: ProjectRepo) => void;
    /** The run's repository as it stands, so an edited run shows the project it came from. */
    repoUrl: string;
}

/**
 * The coding-agent run picker's project half: pick a project and its
 * repositories are offered, its default preselected with its default branch.
 * Renders nothing when no project lists a repository.
 */
const ProjectRepoPicker: FC<ProjectRepoPickerProps> = ({ onPick, repoUrl }) => {
    const { t } = useLingui();
    const projectLabelId = useId();
    const repoLabelId = useId();
    const projects = useProjects().filter((project) => (project.repositories?.length ?? 0) > 0);
    const [projectId, setProjectId] = useState<string | undefined>(undefined);

    if (projects.length === 0) {
        return null;
    }

    const current = repoUrl.trim() ? repoLabel(repoUrl.trim()) : undefined;
    // An edited run whose repository a project lists shows that project until another is picked.
    const shownProjectId =
        projectId ?? projects.find((project) => project.repositories?.some((repo) => repoLabel(repo.url) === current))?._id;
    const shown = projects.find((project) => project._id === shownProjectId);
    const repositories = shown?.repositories ?? [];
    const pickedRepo = repositories.find((repo) => repoLabel(repo.url) === current);

    // The trigger reads its label from `items`; without them it shows the raw value.
    const projectItems = [
        { label: t`No project`, value: NO_PROJECT },
        ...projects.map((project) => {
            return { label: project.title, value: project._id as string };
        }),
    ];
    const repoItems = repositories.map((repo) => {
        return { label: repoLabel(repo.url), value: repo.id };
    });

    return (
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
            <div className="space-y-2">
                <Label id={projectLabelId}>{t`Project`}</Label>
                <Select
                    items={projectItems}
                    onValueChange={(value) => {
                        if (typeof value !== "string") {
                            return;
                        }

                        if (value === NO_PROJECT) {
                            setProjectId(NO_PROJECT);

                            return;
                        }

                        setProjectId(value);

                        const preselected = defaultRepoOf(projects.find((project) => project._id === value)?.repositories);

                        if (preselected) {
                            onPick(preselected);
                        }
                    }}
                    value={shown ? shown._id : NO_PROJECT}
                >
                    <SelectTrigger aria-labelledby={projectLabelId}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={NO_PROJECT}>{t`No project`}</SelectItem>
                        {projectItems.slice(1).map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                                {item.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            {shown && (
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
                        <SelectTrigger aria-labelledby={repoLabelId}>
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
                </div>
            )}
        </div>
    );
};

export default ProjectRepoPicker;
