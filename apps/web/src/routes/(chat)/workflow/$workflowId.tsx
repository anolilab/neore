import { Trans } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

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
import { isLunoraId } from "@/lib/lunora/ids";

const WorkflowPage = () => {
    const workflowId = Route.useParams({ select: ({ workflowId: selected }) => selected });

    // Load workflow data into store
    const { workflow, isLoading } = useWorkflow(workflowId);

    // Real-time sync (replaces useAutoSaveWorkflow — handles both auto-save and remote changes)
    useWorkflowSync(workflowId);

    // Manual save (for explicit Ctrl+S / button click)
    const { save } = useSaveWorkflow(workflowId);

    // Real-time presence (cursors, selection, node locks)
    const { otherUsers, updateCursor, updateSelectedNode, startEditingNode, stopEditingNode } = useWorkflowPresence(workflowId ?? null);

    // Execution with real-time status updates
    const { execute } = useWorkflowExecutionWithStatus(workflowId);

    if (isLoading) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="text-muted-foreground">
                    <Trans>Loading workflow...</Trans>
                </div>
            </div>
        );
    }

    if (!workflow) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="text-muted-foreground">
                    <Trans>Workflow not found</Trans>
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
                <header className="flex shrink-0 items-center justify-between border-b px-4 py-2">
                    <div>
                        <h1 className="text-lg font-semibold">{workflow.title}</h1>
                        {workflow.description && <p className="text-muted-foreground text-sm">{workflow.description}</p>}
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
