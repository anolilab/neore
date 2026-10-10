"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Switch } from "@neore/ui/components/switch";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Clock, Play, RefreshCw, Search, Trash2 } from "lucide-react";
import { useState } from "react";

import { showError } from "@/lib/toast";

import { useCleanupConfig, useCleanupLogs, useExecuteCleanup, usePreviewCleanup, useUpdateCleanupConfig } from "../hooks/use-admin";

// =============================================================================
// Config Panel
// =============================================================================

const CleanupConfigPanel = () => {
    const { t } = useLingui();
    const { data: config, isPending } = useCleanupConfig();
    const updateConfig = useUpdateCleanupConfig();
    const queryClient = useQueryClient();

    const [thresholdDays, setThresholdDays] = useState<string>("");
    const [batchSize, setBatchSize] = useState<string>("");
    const [editing, setEditing] = useState(false);

    const handleEdit = () => {
        setThresholdDays(String(config?.thresholdDays ?? 30));
        setBatchSize(String(config?.batchSize ?? 100));
        setEditing(true);
    };

    const handleSave = async () => {
        const days = Number.parseInt(thresholdDays, 10);
        const batch = Number.parseInt(batchSize, 10);

        if (Number.isNaN(days) || days < 1 || days > 365) {
            showError(new Error(t`Threshold must be between 1 and 365 days`));

            return;
        }

        if (Number.isNaN(batch) || batch < 1 || batch > 1000) {
            showError(new Error(t`Batch size must be between 1 and 1000`));

            return;
        }

        try {
            await updateConfig.mutateAsync({ batchSize: batch, thresholdDays: days });
            await queryClient.invalidateQueries();
            setEditing(false);
        } catch (error: any) {
            showError(error?.message || t`Failed to save configuration`);
        }
    };

    const handleToggleEnabled = async (enabled: boolean) => {
        try {
            await updateConfig.mutateAsync({ isEnabled: enabled });
            await queryClient.invalidateQueries();
        } catch (error: any) {
            showError(error?.message || t`Failed to update configuration`);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t`Cleanup Configuration`}</CardTitle>
                <CardDescription>{t`Configure thresholds and batch limits for anonymous user cleanup`}</CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
                {isPending ? (
                    <div className="space-y-3">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-32" />
                    </div>
                ) : (
                    <>
                        {editing ? (
                            <div className="space-y-4">
                                <div className="space-y-1.5">
                                    <Label htmlFor="threshold-days">{t`Inactivity threshold (days)`}</Label>
                                    <Input
                                        id="threshold-days"
                                        max={365}
                                        min={1}
                                        onChange={(e) => setThresholdDays(e.target.value)}
                                        type="number"
                                        value={thresholdDays}
                                    />
                                    <p className="text-muted-foreground text-xs">
                                        {t`Anonymous users inactive for this many days become eligible for deletion.`}
                                    </p>
                                </div>

                                <div className="space-y-1.5">
                                    <Label htmlFor="batch-size">{t`Batch size`}</Label>
                                    <Input id="batch-size" max={1000} min={1} onChange={(e) => setBatchSize(e.target.value)} type="number" value={batchSize} />
                                    <p className="text-muted-foreground text-xs">{t`Maximum number of users to delete per cleanup run.`}</p>
                                </div>

                                <div className="flex gap-2">
                                    <Button disabled={updateConfig.isPending} onClick={handleSave} size="sm">
                                        {t`Save`}
                                    </Button>
                                    <Button disabled={updateConfig.isPending} onClick={() => setEditing(false)} size="sm" variant="outline">
                                        {t`Cancel`}
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="rounded-lg border p-3">
                                        <p className="text-muted-foreground text-xs">{t`Inactivity threshold`}</p>
                                        <p className="text-2xl font-bold">{config?.thresholdDays ?? 30}</p>
                                        <p className="text-muted-foreground text-xs">{t`days`}</p>
                                    </div>
                                    <div className="rounded-lg border p-3">
                                        <p className="text-muted-foreground text-xs">{t`Batch size`}</p>
                                        <p className="text-2xl font-bold">{config?.batchSize ?? 100}</p>
                                        <p className="text-muted-foreground text-xs">{t`users / run`}</p>
                                    </div>
                                </div>

                                <Button onClick={handleEdit} size="sm" variant="outline">
                                    {t`Edit`}
                                </Button>
                            </div>
                        )}

                        <div className="flex items-center justify-between border-t pt-4">
                            <div>
                                <p className="text-sm font-medium">{t`Scheduled cleanup`}</p>
                                <p className="text-muted-foreground text-xs">{t`Automatically run cleanup based on configuration`}</p>
                            </div>
                            <Switch checked={config?.isEnabled ?? false} disabled={updateConfig.isPending} onCheckedChange={handleToggleEnabled} />
                        </div>
                    </>
                )}
            </CardContent>
        </Card>
    );
};

// =============================================================================
// Preview + Execute Panel
// =============================================================================

const CleanupExecutePanel = () => {
    const { t } = useLingui();
    const { data: preview, isPending: previewPending, refetch } = usePreviewCleanup();
    const executeCleanup = useExecuteCleanup();
    const queryClient = useQueryClient();

    const [dryRun, setDryRun] = useState(true);
    const [showConfirm, setShowConfirm] = useState(false);
    const [lastResult, setLastResult] = useState<{ deletedCount: number; durationMs: number; eligibleCount: number } | null>(null);

    const handleExecute = async () => {
        setShowConfirm(false);

        try {
            const result = await executeCleanup.mutateAsync({ dryRun });

            setLastResult(result);
            await queryClient.invalidateQueries();
            await refetch();
        } catch (error: any) {
            showError(error?.message || t`Cleanup failed`);
        }
    };

    const idleExecuteLabel = dryRun ? (
        <>
            <Play className="mr-2 size-4" />
            {t`Run dry run`}
        </>
    ) : (
        <>
            <Trash2 className="mr-2 size-4" />
            {t`Execute cleanup`}
        </>
    );

    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle>{t`Preview & Execute`}</CardTitle>
                    <CardDescription>{t`Preview how many users will be removed, then execute cleanup.`}</CardDescription>
                </CardHeader>

                <CardContent className="space-y-6">
                    {/* Eligible count */}
                    <div className="flex items-center gap-4 rounded-lg border p-4">
                        <div className="bg-muted flex size-12 items-center justify-center rounded-full">
                            <Search className="text-muted-foreground size-6" />
                        </div>
                        <div className="flex-1">
                            <p className="text-muted-foreground text-sm">{t`Eligible anonymous users`}</p>
                            {previewPending ? <Skeleton className="mt-1 h-8 w-16" /> : <p className="text-3xl font-bold">{preview?.eligibleCount ?? 0}</p>}
                            {preview && <p className="text-muted-foreground text-xs">{t`Inactive for more than ${preview.thresholdDays} days`}</p>}
                        </div>
                        <Button disabled={previewPending} onClick={() => refetch()} size="sm" variant="outline">
                            <RefreshCw className="mr-1 size-4" />
                            {t`Refresh`}
                        </Button>
                    </div>

                    {/* Last result */}
                    {lastResult && (
                        <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950">
                            <CheckCircle className="mt-0.5 size-5 shrink-0 text-green-600 dark:text-green-400" />
                            <div className="text-sm">
                                <p className="font-medium text-green-800 dark:text-green-200">
                                    {lastResult.deletedCount > 0 ? t`Cleanup complete` : t`Dry run complete`}
                                </p>
                                <p className="text-green-700 dark:text-green-300">
                                    {t`${lastResult.eligibleCount} eligible · ${lastResult.deletedCount} deleted · ${lastResult.durationMs}ms`}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Options */}
                    <div className="flex items-center gap-2">
                        <Checkbox checked={dryRun} id="dry-run" onCheckedChange={(checked) => setDryRun(checked === true)} />
                        <Label className="cursor-pointer" htmlFor="dry-run">
                            {t`Dry run (preview only — no deletions)`}
                        </Label>
                    </div>

                    {/* Execute button */}
                    <Button
                        className="w-full"
                        disabled={executeCleanup.isPending || previewPending || (preview?.eligibleCount ?? 0) === 0}
                        onClick={() => (dryRun ? handleExecute() : setShowConfirm(true))}
                        variant={dryRun ? "outline" : "destructive"}
                    >
                        {executeCleanup.isPending ? (
                            <>
                                <RefreshCw className="mr-2 size-4 animate-spin" />
                                {t`Running...`}
                            </>
                        ) : (
                            idleExecuteLabel
                        )}
                    </Button>
                </CardContent>
            </Card>

            {/* Confirmation dialog */}
            <Dialog onOpenChange={setShowConfirm} open={showConfirm}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="text-destructive size-5" />
                            {t`Confirm cleanup`}
                        </DialogTitle>
                        <DialogDescription>
                            {t`This will permanently delete ${preview?.eligibleCount ?? 0} anonymous user accounts and all their data. This action cannot be undone.`}
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button onClick={() => setShowConfirm(false)} variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={executeCleanup.isPending} onClick={handleExecute} variant="destructive">
                            {executeCleanup.isPending ? t`Deleting...` : t`Delete ${preview?.eligibleCount ?? 0} users`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};

// =============================================================================
// Logs Table
// =============================================================================

const CleanupLogsPanel = () => {
    const { i18n, t } = useLingui();
    const { data, isPending } = useCleanupLogs({ limit: 20 });
    // Run times are formatted with the viewer's locale and timezone, which the
    // server does not know — format after mount so SSR and hydration agree.
    const isMounted = useIsHydrated();

    const logsBody =
        data?.logs && data.logs.length > 0 ? (
            <div className="space-y-3">
                {data.logs.map(
                    (log: {
                        _id: string;
                        deletedCount: number;
                        durationMs: number;
                        eligibleCount: number;
                        mode: "dry_run" | "execute";
                        runAt: number;
                        triggeredBy: string;
                    }) => {
                        const date = isMounted ? formatDateTime(log.runAt, i18n.locale) : "";

                        return (
                            <div className="flex items-start gap-3 border-b pb-3 last:border-0" key={log._id}>
                                <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full">
                                    {log.mode === "dry_run" ? <Search className="size-4 text-blue-500" /> : <Trash2 className="text-destructive size-4" />}
                                </div>

                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant={log.mode === "dry_run" ? "outline" : "destructive"}>
                                            {log.mode === "dry_run" ? t`Dry run` : t`Execute`}
                                        </Badge>
                                        <span className="text-muted-foreground flex items-center gap-1 text-xs">
                                            <Clock className="size-3" />
                                            {date}
                                        </span>
                                    </div>

                                    <div className="text-muted-foreground mt-1 text-xs">
                                        {t`${log.eligibleCount} eligible · ${log.deletedCount} deleted · ${log.durationMs}ms`}
                                    </div>

                                    <div className="text-muted-foreground mt-0.5 truncate text-xs">
                                        {t`By:`} {log.triggeredBy === "scheduled" ? t`Scheduled job` : log.triggeredBy}
                                    </div>
                                </div>
                            </div>
                        );
                    },
                )}
            </div>
        ) : (
            <div className="text-muted-foreground py-8 text-center">{t`No cleanup runs yet`}</div>
        );

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t`Run History`}</CardTitle>
                <CardDescription>{t`Past cleanup runs and their results`}</CardDescription>
            </CardHeader>

            <CardContent>
                {isPending ? (
                    <div className="space-y-3">
                        {[1, 2, 3].map((i) => (
                            <div className="flex items-center gap-3" key={i}>
                                <Skeleton className="size-8 rounded-full" />
                                <div className="flex-1 space-y-2">
                                    <Skeleton className="h-4 w-48" />
                                    <Skeleton className="h-3 w-32" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    logsBody
                )}
            </CardContent>
        </Card>
    );
};

// =============================================================================
// Main Dashboard
// =============================================================================

const AdminCleanupDashboard = () => (
    <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
            <CleanupConfigPanel />
            <CleanupExecutePanel />
        </div>
        <CleanupLogsPanel />
    </div>
);

export default AdminCleanupDashboard;
