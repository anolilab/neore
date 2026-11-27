import { Trans } from "@lingui/react/macro";
import { isLunoraId } from "@neore/client-runtime";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2, Workflow as WorkflowIcon } from "lucide-react";
import { useEffect } from "react";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import {
    CollaboratorFacepile,
    PublishDialog,
    useSaveWorkflow,
    useWorkflow,
    useWorkflowExecutionWithStatus,
    useWorkflowPresence,
    useWorkflowSync,
    WorkflowCanvas,
} from "@/features/workflow";
import { useResolveWorkflowImages } from "@/features/workflow/hooks/use-resolve-workflow-images";
import { startHistoryRecording } from "@/features/workflow/stores/history-store";

const WorkflowPage = () => {
    const workflowId = Route.useParams({ select: ({ workflowId: selected }) => selected });

    useEffect(startHistoryRecording, []);

    // Load workflow data into store
    const { workflow, isLoading } = useWorkflow(workflowId);

    // Real-time sync (replaces useAutoSaveWorkflow — handles both auto-save and remote changes)
    useWorkflowSync(workflowId);

    // Display URLs for images kept by reference (they expire, so they are fetched on load)
    useResolveWorkflowImages();

    // Manual save (for explicit Ctrl+S / button click)
    const { save } = useSaveWorkflow(workflowId);

    // Real-time presence (cursors, selection, node locks)
    const { otherUsers, updateCursor, updateSelectedNode, startEditingNode, stopEditingNode } = useWorkflowPresence(workflowId ?? null);

    // Execution with real-time status updates
    const { execute } = useWorkflowExecutionWithStatus(workflowId);

    if (isLoading) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                    <Trans>Loading workflow...</Trans>
                </div>
            </div>
        );
    }

    if (!workflow) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <div className="surface-raised flex flex-col items-center rounded-xl px-8 py-10 text-center">
                    <div aria-hidden="true" className="surface-well text-muted-foreground mb-3 flex size-12 items-center justify-center rounded-xl">
                        <WorkflowIcon className="size-6" />
                    </div>
                    <h1 className="text-[15px] font-semibold">
                        <Trans>Workflow not found</Trans>
                    </h1>
                </div>
            </div>
        );
    }

    const route = "/(chat)/workflow/$workflowId";

    const handleSave = () => {
        save();
    };

    const handleRun = () => {
        execute();
    };

    return (
        <RouteErrorBoundary routeName={route}>
            <>
                {/* Header */}
                <header className="border-border/50 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
                    <div className="min-w-0">
                        <h1 className="truncate text-[15px] font-semibold">{workflow.title}</h1>
                        {workflow.description && <p className="text-muted-foreground truncate text-xs">{workflow.description}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                        {/* Collaborator facepile */}
                        <CollaboratorFacepile users={otherUsers} />
                        {/* Publish to gallery */}
                        <PublishDialog
                            currentCategory={workflow.galleryCategory}
                            currentDescription={workflow.description}
                            currentTags={workflow.galleryTags}
                            isPublished={workflow.isPublic ?? false}
                            projectId={workflowId}
                        />
                    </div>
                </header>

                {/* Canvas */}
                <div className="min-h-0 flex-1">
                    <WorkflowCanvas
                        collaborators={otherUsers}
                        onCursorMove={updateCursor}
                        onNodeSelect={updateSelectedNode}
                        onRun={handleRun}
                        onSave={handleSave}
                        onStartEditingNode={startEditingNode}
                        onStopEditingNode={stopEditingNode}
                    />
                </div>
            </>
        </RouteErrorBoundary>
    );
};

export const Route = createFileRoute("/(chat)/workflow/$workflowId")({
    component: WorkflowPage,
    staleTime: 5 * 60 * 1000,
    preloadStaleTime: 30_000,
    gcTime: 10 * 60 * 1000,
    ssr: false,
    beforeLoad: ({ params }) => {
        const isValidLunoraId = isLunoraId(params.workflowId);

        if (!isValidLunoraId) {
            throw redirect({
                to: "/chat",
                search: {
                    redirectReason: "invalid-workflow-id",
                },
                replace: true,
            });
        }
    },
});
