/**
 * Execution History Panel
 *
 * Slide-out panel displaying past workflow execution runs with per-node
 * details. Uses the existing cRPC hooks to fetch data.
 *
 * U6: Uses right-4 positioning with flex layout instead of hardcoded offset.
 * U7: Proper typed interfaces instead of Record&lt;string, any>.
 * U8: ARIA attributes for expand/collapse and status regions.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, History, Loader2, X, XCircle } from "lucide-react";
import { useState } from "react";

import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

import { useWorkflowStore } from "../../stores/workflow-store";

interface ExecutionHistoryPanelProps {
    onClose: () => void;
}

/** Execution record shape from the cRPC query */
interface ExecutionRecord {
    _creationTime?: number;
    _id: Id<"workflowExecutions">;
    completedAt?: number | null;
    error?: string | null;
    startedAt?: number | null;
    status: string;
}

/** Node execution record shape */
interface NodeExecutionRecord {
    _id: string;
    completedAt?: number | null;
    error?: string | null;
    nodeId: string;
    nodeType?: string;
    startedAt?: number | null;
    status: string;
}

interface StatusConfigEntry {
    color: string;
    icon: React.ReactNode;
    label: MessageDescriptor;
}

const pendingStatusConfig: StatusConfigEntry = { color: "text-yellow-500", icon: <Clock aria-hidden="true" className="size-3.5" />, label: msg`Pending` };

const statusConfig: Record<string, StatusConfigEntry> = {
    cancelled: { color: "text-yellow-500", icon: <XCircle aria-hidden="true" className="size-3.5" />, label: msg`Cancelled` },
    completed: { color: "text-green-500", icon: <CheckCircle2 aria-hidden="true" className="size-3.5" />, label: msg`Completed` },
    failed: { color: "text-red-500", icon: <AlertCircle aria-hidden="true" className="size-3.5" />, label: msg`Failed` },
    pending: pendingStatusConfig,
    running: { color: "text-blue-500", icon: <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />, label: msg`Running` },
};

/** `status` is a free-form string from the backend; unknown values render as "Pending". */
const getStatusConfig = (status: string): StatusConfigEntry => statusConfig[status] ?? pendingStatusConfig;

const STATUS_BADGE_VARIANTS: Record<string, "default" | "destructive"> = {
    completed: "default",
    failed: "destructive",
};

const formatExecutionTime = (timestamp: number | undefined | null, locale: string) => {
    if (!timestamp) return "\u{2014}";

    return formatDateTime(timestamp, locale, {
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        second: "2-digit",
    });
};

const formatDuration = (start: number | undefined | null, end: number | undefined | null) => {
    if (!start || !end) return "\u{2014}";

    const durationMs = end - start;

    if (durationMs < 1000) return `${durationMs}ms`;

    if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;

    return `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1000)}s`;
};

/** Single execution row with expandable node details. */
const ExecutionRow = ({ execution }: { execution: ExecutionRecord }) => {
    const { i18n } = useLingui();
    const [expanded, setExpanded] = useState(false);
    const crpc = useCRPC();
    const { isAuthenticated } = useLunoraAuth();

    const { data: nodeExecutions } = useQuery(
        crpc.workflow.functions.listNodeExecutions.queryOptions(expanded && isAuthenticated && execution._id ? { executionId: execution._id } : skipToken),
    );

    const config = getStatusConfig(execution.status);

    return (
        <div className="border-b last:border-b-0">
            <button
                aria-expanded={expanded}
                className="hover:bg-muted/50 flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors"
                onClick={() => setExpanded((v) => !v)}
                type="button"
            >
                {expanded ? (
                    <ChevronDown aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
                ) : (
                    <ChevronRight aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
                )}
                <span className={`shrink-0 ${config.color}`}>{config.icon}</span>
                <span className="min-w-0 flex-1 truncate text-xs">{formatExecutionTime(execution.startedAt ?? execution._creationTime, i18n.locale)}</span>
                <Badge className="text-[10px]" variant={STATUS_BADGE_VARIANTS[execution.status] ?? "secondary"}>
                    {i18n._(config.label)}
                </Badge>
                <span className="text-muted-foreground shrink-0 text-[10px]">{formatDuration(execution.startedAt, execution.completedAt)}</span>
            </button>

            {expanded && (
                <div className="bg-muted/30 border-t px-3 py-2">
                    {execution.error && (
                        <div className="text-destructive mb-2 rounded bg-red-500/10 p-2 text-[11px]" role="alert">
                            {execution.error}
                        </div>
                    )}
                    {Array.isArray(nodeExecutions) && nodeExecutions.length > 0 && (
                        <div className="space-y-1">
                            <p className="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-wide uppercase">
                                <Trans>Node Results</Trans>
                            </p>
                            {(nodeExecutions as NodeExecutionRecord[]).map((ne) => {
                                const nodeConfig = getStatusConfig(ne.status);

                                return (
                                    <div className="flex items-center gap-2 rounded px-2 py-1 text-[11px]" key={ne._id}>
                                        <span className={nodeConfig.color}>{nodeConfig.icon}</span>
                                        <span className="min-w-0 flex-1 truncate font-medium">{ne.nodeId}</span>
                                        <span className="text-muted-foreground">{ne.nodeType}</span>
                                        <span className="text-muted-foreground">{formatDuration(ne.startedAt, ne.completedAt)}</span>
                                        {ne.error && (
                                            <Tooltip>
                                                <TooltipTrigger render={<AlertCircle aria-hidden="true" className="size-3 shrink-0 text-red-500" />} />
                                                <TooltipContent>
                                                    <p className="max-w-[200px] text-xs">{ne.error}</p>
                                                </TooltipContent>
                                            </Tooltip>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {!nodeExecutions && expanded && (
                        <div className="text-muted-foreground flex items-center gap-1.5 py-2 text-[11px]" role="status">
                            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                            <Trans>Loading node details...</Trans>
                        </div>
                    )}
                    {!(Array.isArray(nodeExecutions) && nodeExecutions.length > 0) && !(!nodeExecutions && expanded) && (
                        <p className="text-muted-foreground py-1 text-[11px]">
                            <Trans>No node execution data available.</Trans>
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

const ExecutionHistoryPanel = ({ onClose }: ExecutionHistoryPanelProps) => {
    const projectId = useWorkflowStore((state) => state.projectId);
    const crpc = useCRPC();
    const { t } = useLingui();
    const { isAuthenticated, isLoading: authLoading } = useLunoraAuth();

    const shouldQuery = isAuthenticated && !authLoading && !!projectId;

    const { data, isLoading } = useQuery(
        crpc.workflow.functions.listExecutions.queryOptions(
            // `projectId` is held as a plain string in the workflow store but is only
            // ever set from a project id returned by the backend.
            shouldQuery && projectId ? { paginationOpts: { cursor: null, numItems: 50 }, projectId: projectId as Id<"projects"> } : skipToken,
        ),
    );

    const executions = (data?.page ?? []) as ExecutionRecord[];

    return (
        <div
            aria-label={t`Execution history`}
            className="bg-background/95 absolute top-4 right-4 z-10 flex h-[calc(100%-32px)] w-[320px] translate-x-[calc(-100%-8px)] flex-col rounded-lg border shadow-lg backdrop-blur-sm"
            role="region"
        >
            {/* Header */}
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
                <History aria-hidden="true" className="text-muted-foreground size-4" />
                <h3 className="flex-1 text-sm font-medium">
                    <Trans>Run History</Trans>
                </h3>
                <span className="text-muted-foreground text-xs">
                    <Plural one="# run" other="# runs" value={executions.length} />
                </span>
                <Button aria-label={t`Close execution history`} className="size-6" onClick={onClose} size="icon" variant="ghost">
                    <X className="size-3.5" />
                </Button>
            </div>

            {/* Content */}
            <ScrollArea className="flex-1">
                {isLoading && (
                    <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm" role="status">
                        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                        <Trans>Loading...</Trans>
                    </div>
                )}
                {!isLoading && executions.length === 0 && (
                    <div className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-center text-sm">
                        <History aria-hidden="true" className="size-8 opacity-40" />
                        <p>
                            <Trans>No executions yet</Trans>
                        </p>
                        <p className="text-xs">
                            <Trans>Run your workflow to see execution history here.</Trans>
                        </p>
                    </div>
                )}
                {!isLoading && executions.length > 0 && (
                    <div>
                        {executions.map((exec) => (
                            <ExecutionRow execution={exec} key={exec._id} />
                        ))}
                    </div>
                )}
            </ScrollArea>
        </div>
    );
};

export default ExecutionHistoryPanel;
