/**
 * ComposerProjectHint - a quiet chip under the composer while the first message of a new thread is typed. It names the
 * project whose title, or whose recent thread titles, match the draft. A click picks that project; the first send files
 * the new thread there. Matching is local (`matchProjectHint`): no model call.
 */
import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { CheckIcon, FolderIcon } from "lucide-react";
import type { FC } from "react";
import { useMemo } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useThreads } from "@/features/chat/core/hooks/use-threads";
import { selectComposerText, useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { selectSetPendingSettings, useModelStore } from "@/features/chat/core/stores/model-store";
import { useProjects } from "@/features/projects/hooks/use-projects";

import { matchProjectHint } from "./project-hint-match";

("use client");

const ProjectHintChip: FC = () => {
    const { t } = useLingui();
    const draft = useChatUIStore(selectComposerText);
    const pendingProjectId = useModelStore((state) => state.pendingSettings?.projectId);
    const setPendingSettings = useModelStore(selectSetPendingSettings);
    const projects = useProjects();
    const threads = useThreads();

    const selectedProject = useMemo(() => projects.find((project) => project._id === pendingProjectId), [projects, pendingProjectId]);
    const matchedProject = useMemo(() => matchProjectHint(draft, projects, threads), [draft, projects, threads]);
    const project = selectedProject ?? matchedProject;

    if (!project) {
        return null;
    }

    const isSelected = selectedProject !== undefined;

    const togglePick = () => {
        setPendingSettings((previous) => {
            return { ...previous, projectId: isSelected ? undefined : project._id };
        });
    };

    return (
        <div className="flex px-2 pb-2">
            <button
                aria-pressed={isSelected}
                className={cn(
                    "flex max-w-xs cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-left text-xs transition-colors outline-none",
                    "border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1",
                    isSelected && "border-primary/50 text-foreground",
                )}
                onClick={togglePick}
                type="button"
            >
                {isSelected ? (
                    <CheckIcon aria-hidden="true" className="size-3 shrink-0" />
                ) : (
                    <FolderIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
                )}
                <span className="truncate">{isSelected ? t`Will file in ${project.title}` : t`File in ${project.title}`}</span>
            </button>
        </div>
    );
};

/** Mounted only for a new thread, so the project and thread lists are not subscribed to on an existing one. */
const ComposerProjectHint: FC = () => {
    const { isNewThread } = useChatThread();

    if (!isNewThread) {
        return null;
    }

    return <ProjectHintChip />;
};

export default ComposerProjectHint;
