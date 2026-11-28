import { Plural, useLingui } from "@lingui/react/macro";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { Globe, Plus, Workflow } from "lucide-react";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import { useCreateWorkflow, useWorkflows } from "@/features/workflow";

const WorkflowListPage = () => {
    const route = "/(chat)/workflow/";
    const { t } = useLingui();
    const navigate = useNavigate();

    const workflows = useWorkflows();
    const createWorkflow = useCreateWorkflow();

    const handleCreateWorkflow = async () => {
        const workflowId = await createWorkflow.mutateAsync({
            title: t`Untitled Workflow`,
            description: "",
            // `workflowContent` is `v.from(zWorkflowContent.optional())` server-side, which
            // codegen renders as a required key of type `unknown`. A new workflow starts empty.
            workflowContent: undefined,
        });

        navigate({
            to: "/workflow/$workflowId",
            params: { workflowId },
        });
    };

    return (
        <RouteErrorBoundary routeName={route}>
            <ScrollArea className="h-full">
                <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                            <h1 className="text-xl font-semibold tracking-tight">{t`Workflows`}</h1>
                            <p className="text-muted-foreground text-sm">{t`Build and automate AI workflows visually`}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <Link to="/workflow/gallery">
                                <Button variant="outline">
                                    <Globe className="mr-2 size-4" />
                                    {t`Community Gallery`}
                                </Button>
                            </Link>
                            <Button disabled={createWorkflow.isPending} onClick={handleCreateWorkflow}>
                                <Plus className="mr-2 size-4" />
                                {createWorkflow.isPending ? t`Creating...` : t`New Workflow`}
                            </Button>
                        </div>
                    </div>

                    {workflows.length === 0 ? (
                        <div className="surface-raised flex flex-col items-center justify-center rounded-xl px-6 py-16 text-center">
                            <div aria-hidden="true" className="surface-well text-muted-foreground mb-4 flex size-12 items-center justify-center rounded-xl">
                                <Workflow className="size-6" />
                            </div>
                            <h2 className="mb-1 text-[15px] font-semibold">{t`No workflows yet`}</h2>
                            <p className="text-muted-foreground mb-4 max-w-sm text-sm text-pretty">{t`Create your first workflow to automate AI tasks visually.`}</p>
                            <Button disabled={createWorkflow.isPending} onClick={handleCreateWorkflow}>
                                <Plus className="mr-2 size-4" />
                                {t`Create Workflow`}
                            </Button>
                        </div>
                    ) : (
                        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                            {workflows.map((workflow: any) => (
                                <Link key={workflow._id} params={{ workflowId: workflow._id }} to="/workflow/$workflowId">
                                    <Card className="hover:bg-muted/40 cursor-pointer transition-colors">
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <div
                                                    className="flex size-8 items-center justify-center rounded-lg"
                                                    style={{
                                                        backgroundColor: workflow.color ? `${workflow.color}20` : "var(--muted)",
                                                        color: workflow.color ?? "var(--muted-foreground)",
                                                    }}
                                                >
                                                    <Workflow className="size-4" />
                                                </div>
                                                <span className="truncate">{workflow.title}</span>
                                            </CardTitle>
                                            {workflow.description && <CardDescription className="line-clamp-2">{workflow.description}</CardDescription>}
                                        </CardHeader>
                                        <CardContent>
                                            <div className="text-muted-foreground text-xs">
                                                <Plural one="# node" other="# nodes" value={workflow.workflowContent?.nodes?.length ?? 0} />
                                            </div>
                                        </CardContent>
                                    </Card>
                                </Link>
                            ))}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </RouteErrorBoundary>
    );
};

export const Route = createFileRoute("/(chat)/workflow/")({
    component: WorkflowListPage,
    ssr: false,
});
