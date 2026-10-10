"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import type { IconName } from "@neore/ui/components/icon-picker";
import { Icon } from "@neore/ui/components/icon-picker";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { X } from "lucide-react";
import type { FC } from "react";

import { useMoveThreadToProject, useProjects } from "../hooks/use-projects";

interface MoveToProjectDialogProps {
    currentProjectId?: string;
    onClose: () => void;
    open: boolean;
    threadId: string;
}

const MoveToProjectDialog: FC<MoveToProjectDialogProps> = ({ currentProjectId, onClose, open, threadId }) => {
    const { t } = useLingui();
    const projects = useProjects();
    const moveThreadToProject = useMoveThreadToProject();

    const handleMoveToProject = async (projectId: Id<"projects"> | undefined) => {
        try {
            await moveThreadToProject.mutateAsync({
                projectId,
                // `threadId` arrives as a plain `string` from the thread-list tree, which
                // only ever holds ids the backend handed out for `threads` rows.
                threadId: threadId as Id<"threads">,
            });

            onClose();
        } catch {
            // Error handled silently
        }
    };

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t`Move to Project`}</DialogTitle>
                    <DialogDescription>{t`Select a project to move this chat to, or remove it from its current project.`}</DialogDescription>
                </DialogHeader>
                <DialogPanel>
                    <div className="space-y-2">
                        {currentProjectId && (
                            <button
                                className="hover:bg-accent flex w-full items-center gap-2 rounded-md border p-3 text-left transition-colors"
                                onClick={() => handleMoveToProject(undefined)}
                                type="button"
                            >
                                <X className="size-4 shrink-0" />
                                <span className="text-sm">{t`Remove from project`}</span>
                            </button>
                        )}

                        {projects && projects.length > 0 ? (
                            projects.map((project) => {
                                const isCurrentProject = project._id === currentProjectId;

                                return (
                                    <button
                                        className="hover:bg-accent flex w-full items-center gap-2 rounded-md border p-3 text-left transition-colors disabled:opacity-50"
                                        disabled={isCurrentProject}
                                        key={project._id}
                                        // `listProjects` types `_id` as a bare `v.string()` (see
                                        // `backend/lunora/agent/validators.ts#vProjectDocFields`), but the
                                        // rows really are `projects` documents.
                                        onClick={() => handleMoveToProject(project._id as Id<"projects">)}
                                        type="button"
                                    >
                                        <Icon
                                            className="shrink-0"
                                            name={project.icon as IconName}
                                            size={16}
                                            style={project.color ? { color: project.color } : undefined}
                                        />
                                        <span className="flex-1 text-sm">{project.title}</span>
                                        {isCurrentProject && <span className="text-muted-foreground text-xs">{t`Current`}</span>}
                                    </button>
                                );
                            })
                        ) : (
                            <p className="text-muted-foreground py-4 text-center text-sm">{t`No projects available. Create a project first.`}</p>
                        )}
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="outline">
                        {t`Cancel`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default MoveToProjectDialog;
