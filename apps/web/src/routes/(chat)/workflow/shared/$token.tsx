import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import type { Node } from "@xyflow/react";
import { Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { ArrowLeft, Eye, GitFork, Workflow } from "lucide-react";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import { edgeTypes } from "@/features/workflow/components/edges";
import { getGalleryCategoryLabel } from "@/features/workflow/components/gallery/gallery-card";
import { nodeTypes } from "@/features/workflow/components/nodes";
import { useForkWorkflow, usePublicWorkflow } from "@/features/workflow/hooks/use-gallery";
import { useLunoraAuth } from "@/lib/lunora/crpc";

const SharedWorkflowPage = () => {
    const route = "/(chat)/workflow/shared/$token";
    const { token } = useParams({ from: "/(chat)/workflow/shared/$token" });
    const navigate = useNavigate();
    const { i18n, t } = useLingui();

    const { workflow, isLoading } = usePublicWorkflow(token);
    const { isAuthenticated, isLoading: authLoading } = useLunoraAuth();
    const forkWorkflow = useForkWorkflow();

    if (isLoading) {
        return (
            <RouteErrorBoundary routeName={route}>
                <div className="flex h-full items-center justify-center">
                    <div className="text-muted-foreground animate-pulse">
                        <Trans>Loading workflow...</Trans>
                    </div>
                </div>
            </RouteErrorBoundary>
        );
    }

    if (!workflow) {
        return (
            <RouteErrorBoundary routeName={route}>
                <div className="flex h-full flex-col items-center justify-center gap-4">
                    <Workflow className="text-muted-foreground size-12" />
                    <h2 className="text-lg font-medium">
                        <Trans>Workflow not found</Trans>
                    </h2>
                    <p className="text-muted-foreground">
                        <Trans>This workflow may have been unpublished or deleted.</Trans>
                    </p>
                    <Button onClick={() => navigate({ to: "/workflow/gallery" })} variant="outline">
                        <ArrowLeft className="mr-2 size-4" />
                        <Trans>Back to Gallery</Trans>
                    </Button>
                </div>
            </RouteErrorBoundary>
        );
    }

    const handleFork = async () => {
        if (!workflow) {
            return;
        }

        const result = await forkWorkflow.mutateAsync({
            sourceProjectId: workflow._id,
        });

        navigate({
            to: "/workflow/$workflowId",
            params: { workflowId: result.projectId },
        });
    };

    const content = workflow.workflowContent;
    const categoryLabel = getGalleryCategoryLabel(workflow.galleryCategory);

    // `workflowContent` is a persisted JSON blob, so each node's `data` comes back as
    // `unknown`. React Flow only needs it to be an object bag — the individual node
    // components own the narrowing of their own `data`, and this canvas is read-only.
    const nodes: Node[] = (content?.nodes ?? []).map((node) => {
        return { ...node, data: (node.data ?? {}) as Record<string, unknown> };
    });

    return (
        <RouteErrorBoundary routeName={route}>
            <>
                {/* Header Bar */}
                <div className="bg-background flex items-center justify-between border-b px-4 py-3">
                    <div className="flex items-center gap-3">
                        <Button aria-label={t`Back to Gallery`} onClick={() => navigate({ to: "/workflow/gallery" })} size="icon" variant="ghost">
                            <ArrowLeft className="size-4" />
                        </Button>
                        <div
                            className="flex size-8 items-center justify-center rounded"
                            style={{
                                backgroundColor: workflow.color ? `${workflow.color}20` : "var(--muted)",
                                color: workflow.color ?? "var(--muted-foreground)",
                            }}
                        >
                            <Workflow className="size-4" />
                        </div>
                        <div>
                            <h1 className="text-sm font-semibold">{workflow.title}</h1>
                            {workflow.description && <p className="text-muted-foreground line-clamp-1 text-xs">{workflow.description}</p>}
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="text-muted-foreground flex items-center gap-2 text-xs">
                            {workflow.galleryCategory && (
                                <Badge className="text-[10px]" variant="secondary">
                                    {categoryLabel ? i18n._(categoryLabel) : workflow.galleryCategory}
                                </Badge>
                            )}
                            <span className="flex items-center gap-1">
                                <Eye className="size-3" />
                                {workflow.galleryViewCount}
                            </span>
                            <span className="flex items-center gap-1">
                                <GitFork className="size-3" />
                                {workflow.galleryForkCount}
                            </span>
                        </div>
                        {isAuthenticated ? (
                            <Button disabled={forkWorkflow.isPending} onClick={handleFork} size="sm">
                                <GitFork className="mr-1.5 size-4" />
                                {forkWorkflow.isPending ? <Trans>Forking...</Trans> : <Trans>Fork Workflow</Trans>}
                            </Button>
                        ) : (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <Button disabled={authLoading} onClick={() => navigate({ to: "/sign-in" })} size="sm" variant="outline">
                                            <GitFork className="mr-1.5 size-4" />
                                            <Trans>Fork Workflow</Trans>
                                        </Button>
                                    }
                                />
                                <TooltipContent>
                                    <Trans>Sign in to fork this workflow</Trans>
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                </div>

                {/* Read-only Canvas */}
                <div className="relative flex-1">
                    <ReactFlowProvider>
                        <ReactFlow
                            defaultViewport={content?.viewport ?? { x: 0, y: 0, zoom: 0.8 }}
                            edges={content?.edges ?? []}
                            edgeTypes={edgeTypes}
                            elementsSelectable={false}
                            fitView
                            nodes={nodes}
                            nodesConnectable={false}
                            nodesDraggable={false}
                            nodeTypes={nodeTypes}
                            panOnDrag
                            zoomOnScroll
                        >
                            <Background gap={16} size={1} variant={BackgroundVariant.Dots} />
                            <MiniMap className="!bg-background/80 !border-border" maskColor="rgba(0,0,0,0.1)" />
                        </ReactFlow>
                    </ReactFlowProvider>

                    {/* Read-only Overlay Badge */}
                    <div className="bg-background/90 text-muted-foreground absolute bottom-4 left-4 rounded-md border px-3 py-1.5 text-xs">
                        <Trans>Read-only preview - Fork to edit</Trans>
                    </div>
                </div>
            </>
        </RouteErrorBoundary>
    );
};

export const Route = createFileRoute("/(chat)/workflow/shared/$token")({
    component: SharedWorkflowPage,
    ssr: false,
});
