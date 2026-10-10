"use client";

import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Doc } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Check, Clock, History, Loader2, RotateCcw, Sparkles, User } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

interface PromptHistoryDialogProps {
    onClose: () => void;
    open: boolean;
    prompt: Doc<"prompts">;
}

const changeTypeConfig = {
    created: {
        color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
        icon: Check,
        label: msg`Created`,
    },
    manual: {
        color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
        icon: User,
        label: msg`Manual Edit`,
    },
    optimized: {
        color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
        icon: Sparkles,
        label: msg`AI Optimized`,
    },
    restored: {
        color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
        icon: RotateCcw,
        label: msg`Restored`,
    },
} as const;

const PromptHistoryDialog = ({ onClose, open, prompt }: PromptHistoryDialogProps) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const [selectedVersion, setSelectedVersion] = useState<Doc<"promptHistory"> | null>(null);
    const [isRestoring, setIsRestoring] = useState(false);

    // Query history for this prompt
    const { data: history } = useQuery(crpc.prompts.functions.getPromptHistory.queryOptions(open ? { promptId: prompt._id } : skipToken));

    // Restore mutation
    const { mutateAsync: restoreVersion } = useMutation(crpc.prompts.functions.restorePromptVersion.mutationOptions());

    const handleRestore = useCallback(async () => {
        if (!selectedVersion) {
            return;
        }

        setIsRestoring(true);

        try {
            await restoreVersion({
                promptId: prompt._id,
                version: selectedVersion.version,
            });
            toast.success(t`Restored to version ${selectedVersion.version}`);
            onClose();
        } catch {
            toast.error(t`Failed to restore version`);
        }

        setIsRestoring(false);
    }, [selectedVersion, restoreVersion, prompt._id, onClose, t]);

    const formatDate = (timestamp: number) =>
        formatDateTime(timestamp, i18n.locale, {
            dateStyle: "medium",
            timeStyle: "short",
        });

    const isCurrentVersion = (version: number) => version === prompt.currentVersion;

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
            <DialogContent className="max-w-4xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <History className="size-5" />
                        {t`Version History`}
                    </DialogTitle>
                    <DialogDescription>{t`View and restore previous versions of "${prompt.name}"`}</DialogDescription>
                </DialogHeader>

                <DialogPanel>
                    <div className="flex gap-4">
                        {/* Version list */}
                        <div className="w-80 flex-shrink-0">
                            <h3 className="mb-2 text-sm font-medium">{t`Versions`}</h3>
                            <ScrollArea className="h-96">
                                {history === undefined && (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader2 className="text-muted-foreground size-6 animate-spin" />
                                    </div>
                                )}
                                {history !== undefined && history.length === 0 && (
                                    <div className="text-muted-foreground py-8 text-center text-sm">{t`No history available`}</div>
                                )}
                                {history !== undefined && history.length > 0 && (
                                    <div className="space-y-2 pr-4">
                                        {history.map((entry) => {
                                            const config = changeTypeConfig[entry.changeType as keyof typeof changeTypeConfig] || changeTypeConfig.manual;
                                            const Icon = config.icon;
                                            const isCurrent = isCurrentVersion(entry.version);
                                            const isSelected = selectedVersion?._id === entry._id;

                                            return (
                                                <button
                                                    className={`w-full rounded-lg border p-3 text-left transition-colors ${
                                                        isSelected ? "border-primary bg-primary/5" : "hover:bg-muted border-transparent"
                                                    }`}
                                                    key={entry._id}
                                                    onClick={() => setSelectedVersion(entry as Doc<"promptHistory">)}
                                                    type="button"
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-medium">v{entry.version}</span>
                                                            {isCurrent && (
                                                                <Badge className="text-xs" variant="secondary">
                                                                    {t`Current`}
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        <Badge className={`${config.color} text-xs`}>
                                                            <Icon className="mr-1 size-3" />
                                                            {i18n._(config.label)}
                                                        </Badge>
                                                    </div>
                                                    <div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                                                        <Clock className="size-3" />
                                                        {formatDate(entry.createdAt)}
                                                    </div>
                                                    {entry.note && <p className="text-muted-foreground mt-1 truncate text-xs">{entry.note}</p>}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </ScrollArea>
                        </div>

                        {/* Content preview */}
                        <div className="flex-1">
                            <h3 className="mb-2 text-sm font-medium">
                                {selectedVersion ? t`Version ${selectedVersion.version} Content` : t`Select a version to preview`}
                            </h3>
                            <div className="bg-muted h-96 overflow-hidden rounded-lg">
                                {selectedVersion ? (
                                    <ScrollArea className="h-full">
                                        <div className="p-4">
                                            <pre className="text-sm whitespace-pre-wrap">{selectedVersion.content}</pre>
                                        </div>
                                    </ScrollArea>
                                ) : (
                                    <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                                        {t`Click on a version to see its content`}
                                    </div>
                                )}
                            </div>

                            {/* Diff indicator */}
                            {selectedVersion && !isCurrentVersion(selectedVersion.version) && (
                                <div className="mt-2 text-xs">
                                    <span className="text-muted-foreground">
                                        {selectedVersion.content.length > prompt.content.length &&
                                            t`+${selectedVersion.content.length - prompt.content.length} characters vs current`}
                                        {selectedVersion.content.length < prompt.content.length &&
                                            t`${selectedVersion.content.length - prompt.content.length} characters vs current`}
                                        {selectedVersion.content.length === prompt.content.length && t`Same length as current`}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </DialogPanel>

                <DialogFooter>
                    <Button onClick={onClose} variant="outline">
                        {t`Close`}
                    </Button>
                    {selectedVersion && !isCurrentVersion(selectedVersion.version) && (
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button disabled={isRestoring} onClick={handleRestore}>
                                        {isRestoring ? (
                                            <>
                                                <Loader2 className="mr-2 size-4 animate-spin" />
                                                {t`Restoring...`}
                                            </>
                                        ) : (
                                            <>
                                                <RotateCcw className="mr-2 size-4" />
                                                {t`Restore Version ${selectedVersion.version}`}
                                            </>
                                        )}
                                    </Button>
                                }
                            />
                            <TooltipContent>{t`This will create a new version with this content`}</TooltipContent>
                        </Tooltip>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default PromptHistoryDialog;
