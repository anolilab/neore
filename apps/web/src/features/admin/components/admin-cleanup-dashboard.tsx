"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
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

import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import { showError } from "@/lib/toast";

import { useCleanupConfig, useCleanupLogs, useExecuteCleanup, usePreviewCleanup, useUpdateCleanupConfig } from "../hooks/use-admin";
import { AdminRows, AdminSection } from "./admin-section";

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
        <SettingsCard description={t`Configure thresholds and batch limits for anonymous user cleanup`} title={t`Cleanup Configuration`}>
            {isPending ? (
                <div className="space-y-3 py-3">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-32" />
                </div>
            ) : (
                <>
                    {editing ? (
                        <>
                            <SettingsRow
                                control={
                                    <Input
                                        className="w-28"
                                        id="threshold-days"
                                        max={365}
                                        min={1}
                                        onChange={(e) => setThresholdDays(e.target.value)}
                                        type="number"
                                        value={thresholdDays}
                                    />
                                }
                                description={t`Anonymous users inactive for this many days become eligible for deletion.`}
                                htmlFor="threshold-days"
                                title={t`Inactivity threshold (days)`}
                            />
                            <SettingsRow
                                control={
                                    <Input
                                        className="w-28"
                                        id="batch-size"
                                        max={1000}
                                        min={1}
                                        onChange={(e) => setBatchSize(e.target.value)}
                                        type="number"
                                        value={batchSize}
                                    />
                                }
                                description={t`Maximum number of users to delete per cleanup run.`}
                                htmlFor="batch-size"
                                title={t`Batch size`}
                            />
                            <div className="border-border/50 flex gap-2 border-t py-3">
                                <Button disabled={updateConfig.isPending} onClick={handleSave} size="sm">
                                    {t`Save`}
                                </Button>
                                <Button disabled={updateConfig.isPending} onClick={() => setEditing(false)} size="sm" variant="outline">
                                    {t`Cancel`}
                                </Button>
                            </div>
                        </>
                    ) : (
                        <>
                            <SettingsRow
                                control={
                                    <p className="text-sm tabular-nums">
                                        <span className="text-lg font-semibold">{config?.thresholdDays ?? 30}</span>{" "}
                                        <span className="text-muted-foreground">{t`days`}</span>
                                    </p>
                                }
                                title={t`Inactivity threshold`}
                            />
                            <SettingsRow
                                control={
                                    <p className="text-sm tabular-nums">
                                        <span className="text-lg font-semibold">{config?.batchSize ?? 100}</span>{" "}
                                        <span className="text-muted-foreground">{t`users / run`}</span>
                                    </p>
                                }
                                title={t`Batch size`}
                            />
                            <div className="border-border/50 border-t py-3">
                                <Button onClick={handleEdit} size="sm" variant="outline">
                                    {t`Edit`}
                                </Button>
                            </div>
                        </>
                    )}

                    <SettingsRow
                        control={
                            <Switch
                                aria-labelledby="scheduled-cleanup-title"
                                checked={config?.isEnabled ?? false}
                                disabled={updateConfig.isPending}
                                onCheckedChange={handleToggleEnabled}
                            />
                        }
                        description={t`Automatically run cleanup based on configuration`}
                        title={t`Scheduled cleanup`}
                        titleId="scheduled-cleanup-title"
                    />
                </>
            )}
        </SettingsCard>
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
            <SettingsCard description={t`Preview how many users will be removed, then execute cleanup.`} title={t`Preview & Execute`}>
                {/* Eligible count */}
                <SettingsRow
                    control={
                        previewPending ? (
                            <Skeleton className="h-8 w-16" />
                        ) : (
                            <p className="text-3xl font-semibold tabular-nums">{preview?.eligibleCount ?? 0}</p>
                        )
                    }
                    description={preview ? t`Inactive for more than ${preview.thresholdDays} days` : undefined}
                    title={t`Eligible anonymous users`}
                >
                    <Button disabled={previewPending} onClick={() => refetch()} size="sm" variant="outline">
                        <RefreshCw className="mr-1 size-4" />
                        {t`Refresh`}
                    </Button>
                </SettingsRow>

                {/* Last result */}
                {lastResult && (
                    <div className="border-border/50 flex items-start gap-3 border-t py-3">
                        <CheckCircle aria-hidden="true" className="text-success mt-0.5 size-4 shrink-0" />
                        <div className="text-sm">
                            <p className="font-medium">{lastResult.deletedCount > 0 ? t`Cleanup complete` : t`Dry run complete`}</p>
                            <p className="text-muted-foreground text-xs">
                                {t`${lastResult.eligibleCount} eligible · ${lastResult.deletedCount} deleted · ${lastResult.durationMs}ms`}
                            </p>
                        </div>
                    </div>
                )}

                {/* Options */}
                <div className="border-border/50 flex items-center gap-2 border-t py-3">
                    <Checkbox checked={dryRun} id="dry-run" onCheckedChange={(checked) => setDryRun(checked === true)} />
                    <Label className="cursor-pointer" htmlFor="dry-run">
                        {t`Dry run (preview only — no deletions)`}
                    </Label>
                </div>

                {/* Execute button */}
                <div className="border-border/50 border-t py-3">
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
                </div>
            </SettingsCard>

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
            <AdminRows>
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
                            <div className="flex items-start gap-3 py-3" key={log._id}>
                                <div className="surface-well flex size-8 shrink-0 items-center justify-center rounded-lg">
                                    {log.mode === "dry_run" ? (
                                        <Search aria-hidden="true" className="text-info size-4" />
                                    ) : (
                                        <Trash2 aria-hidden="true" className="text-destructive size-4" />
                                    )}
                                </div>

                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant={log.mode === "dry_run" ? "outline" : "destructive"}>
                                            {log.mode === "dry_run" ? t`Dry run` : t`Execute`}
                                        </Badge>
                                        <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
                                            <Clock aria-hidden="true" className="size-3" />
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
            </AdminRows>
        ) : (
            <div className="text-muted-foreground py-8 text-center text-sm">{t`No cleanup runs yet`}</div>
        );

    return (
        <AdminSection description={t`Past cleanup runs and their results`} title={t`Run History`}>
            {isPending ? (
                <AdminRows>
                    {[1, 2, 3].map((i) => (
                        <div className="flex items-center gap-3 py-3" key={i}>
                            <Skeleton className="size-8 rounded-lg" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="h-4 w-48" />
                                <Skeleton className="h-3 w-32" />
                            </div>
                        </div>
                    ))}
                </AdminRows>
            ) : (
                logsBody
            )}
        </AdminSection>
    );
};

// =============================================================================
// Main Dashboard
// =============================================================================

const AdminCleanupDashboard = () => (
    <div className="flex flex-col gap-6">
        <div className="grid items-start gap-6 2xl:grid-cols-2">
            <CleanupConfigPanel />
            <CleanupExecutePanel />
        </div>
        <CleanupLogsPanel />
    </div>
);

export default AdminCleanupDashboard;
