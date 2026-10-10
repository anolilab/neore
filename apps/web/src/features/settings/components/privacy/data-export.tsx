"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { Progress, ProgressValue } from "@neore/ui/components/progress";
import { formatDate } from "@neore/ui/utils/locale-format";
import { useMutation } from "@tanstack/react-query";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";

/** Mirrors the `export` half of `gdpr_functions.getGdprStatus` — those fields are nullable. */
interface ExportStatus {
    _id: string;
    currentStep?: string | null;
    errorMessage?: string | null;
    expiresAt?: number | null;
    hasFile?: boolean;
    progress?: number | null;
    status: string;
}

interface DataExportProps {
    exportStatus?: ExportStatus | null;
    isLoading: boolean;
}

const DataExport: FC<DataExportProps> = ({ exportStatus, isLoading }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const requestExportMutation = useMutation(crpc.gdpr.functions.requestDataExport.mutationOptions());
    const cancelExportMutation = useMutation(crpc.gdpr.functions.cancelStuckExport.mutationOptions());
    const { mutateAsync: getDownloadUrl } = useMutation(useLunoraActionOptions(api.gdpr.functions.getExportDownloadUrl));
    const [isRequesting, setIsRequesting] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [isCancelling, setIsCancelling] = useState(false);

    const handleRequestExport = async () => {
        try {
            setIsRequesting(true);
            await requestExportMutation.mutateAsync({});
            toast.success(t`Export request submitted. You will receive an email when it's ready.`);
        } catch (error: any) {
            toast.error(error?.message || t`Failed to request export`);
        } finally {
            setIsRequesting(false);
        }
    };

    const handleDownload = async () => {
        try {
            setIsDownloading(true);
            const result = await getDownloadUrl({});

            if (result?.url) {
                window.open(result.url, "_blank", "noopener,noreferrer");
                toast.success(t`Download started`);
            }
        } catch (error: any) {
            toast.error(error?.message || t`Failed to download export`);
        } finally {
            setIsDownloading(false);
        }
    };

    const handleCancel = async () => {
        try {
            setIsCancelling(true);
            await cancelExportMutation.mutateAsync({});
            toast.success(t`Export cancelled`);
        } catch (error: any) {
            toast.error(error?.message || t`Failed to cancel export`);
        } finally {
            setIsCancelling(false);
        }
    };

    const isProcessing = exportStatus?.status === "processing" || exportStatus?.status === "pending";
    const isCompleted = exportStatus?.status === "completed";
    const isFailed = exportStatus?.status === "failed";
    const isCancelled = exportStatus?.status === "cancelled";
    const hasFile = exportStatus?.hasFile ?? false;
    const canDownload = isCompleted && hasFile;
    const canRequestExport = !isLoading && !isProcessing && !isCompleted;
    const progress = exportStatus?.progress ?? 0;

    return (
        <SettingsCard
            description={t`Download a copy of all your personal data in JSON format (GDPR Article 20 - Right to Data Portability)`}
            title={t`Data Export`}
        >
            <CardContent className="space-y-4">
                {isProcessing && (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span>{exportStatus?.currentStep || t`Processing...`}</span>
                            <span>{progress}%</span>
                        </div>
                        <Progress value={progress}>
                            <ProgressValue />
                        </Progress>
                        <Button className="text-muted-foreground" disabled={isCancelling} onClick={handleCancel} size="sm" variant="ghost">
                            {isCancelling ? t`Cancelling...` : t`Cancel Export`}
                        </Button>
                    </div>
                )}

                {isCompleted && exportStatus?.expiresAt && (
                    <div className="bg-muted rounded-lg p-4 text-sm">
                        <p className="font-medium">{t`Export ready!`}</p>
                        <p className="text-muted-foreground mt-1">{t`Expires on ${formatDate(exportStatus.expiresAt, i18n.locale)}`}</p>
                    </div>
                )}

                {isFailed && (
                    <div className="bg-destructive/10 text-destructive rounded-lg p-4 text-sm">
                        <p className="font-medium">{t`Export failed`}</p>
                        {exportStatus?.errorMessage && <p className="mt-1">{exportStatus.errorMessage}</p>}
                        <Button className="mt-2" disabled={isRequesting} onClick={handleRequestExport} size="sm" variant="outline">
                            {isRequesting ? t`Requesting...` : t`Retry Export`}
                        </Button>
                    </div>
                )}

                {isCancelled && (
                    <div className="bg-muted rounded-lg p-4 text-sm">
                        <p className="text-muted-foreground">{t`Previous export was cancelled`}</p>
                    </div>
                )}

                {isCompleted && !hasFile && (
                    <div className="bg-destructive/10 text-destructive rounded-lg p-4 text-sm">
                        <p className="font-medium">{t`Export incomplete`}</p>
                        <p className="mt-1">{t`The export file was not generated. Please request a new export.`}</p>
                    </div>
                )}

                <div className="flex gap-2">
                    {canRequestExport && (
                        <Button disabled={isRequesting || isLoading} onClick={handleRequestExport}>
                            {isRequesting ? t`Requesting...` : t`Request Data Export`}
                        </Button>
                    )}

                    {canDownload && (
                        <Button disabled={isDownloading} onClick={handleDownload} variant="default">
                            {isDownloading ? t`Preparing...` : t`Download Export`}
                        </Button>
                    )}

                    {isCompleted && (
                        <Button disabled={isRequesting} onClick={handleRequestExport} variant="outline">
                            {t`New Export`}
                        </Button>
                    )}
                </div>

                <p className="text-muted-foreground text-xs">
                    {t`Your export will include: profile, settings, conversations, files metadata, prompts, and usage history. The download link expires in 7 days.`}
                </p>
            </CardContent>
        </SettingsCard>
    );
};

export default DataExport;
