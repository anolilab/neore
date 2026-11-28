"use client";

import { useLingui } from "@lingui/react/macro";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@neore/ui/components/alert-dialog";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { Switch } from "@neore/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BrainIcon, Trash2Icon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useId, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";

import MemoryDigestCard from "./memory-digest-card";
import MemoryExportButton from "./memory-export-button";
import MemoryFileImport from "./memory-file-import";
import MemoryImportDialog from "./memory-import-dialog";
import MemoryItem from "./memory-item";
import type { MemoryType } from "./memory-types";
import { isMemoryType, MEMORY_TYPES, useMemoryTypeLabels } from "./memory-types";
import RetiredMemories from "./retired-memories";
import ScheduleIdeasSwitch from "./schedule-ideas-switch";

type TypeFilter = MemoryType | "all";

/**
 * Formats a timestamp as a coarse "time ago" label. Lives outside the component so the
 * `Date.now()` read is not an impure call inside render.
 */
const formatRelativeTime = (timestamp: number | undefined, t: ReturnType<typeof useLingui>["t"]): string => {
    if (!timestamp) {
        return "";
    }

    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60_000);

    if (minutes < 1) {
        return t`just now`;
    }

    if (minutes < 60) {
        return t`${minutes}m ago`;
    }

    const hours = Math.floor(diff / 3_600_000);

    if (hours < 24) {
        return t`${hours}h ago`;
    }

    const days = Math.floor(diff / 86_400_000);

    return t`${days}d ago`;
};

const MemorySettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: userSettings } = useUserSettings();
    const updateSettingsMutation = useUpdateUserSettings();
    const typeLabels = useMemoryTypeLabels();
    const filterLabelId = useId();
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

    // OPT-IN: absent means off, matching the backend's `isMemoryEnabled`.
    const memoryEnabled = userSettings?.memoryEnabled ?? false;

    // Fetch memories list (skip when memory is disabled to avoid unnecessary API calls)
    const { data: memories, refetch: refetchMemories } = useQuery({
        // Read by refetches, not a subscription: a shared bot's label comes from the global `botOwners` table, whose writes
        // on the bot owner's shard never reach a live query (docs/agents/lunora-upstream.md). It is read again whenever the
        // person comes back to the page, and after each change made here (`refresh`).
        ...crpc.memory.functions.listUserMemories.queryOptions({}, { live: false }),
        enabled: memoryEnabled,
        refetchOnWindowFocus: "always",
    });

    // Fetch memory stats (skip when memory is disabled)
    const { data: stats, refetch: refetchStats } = useQuery({
        ...crpc.memory.functions.getMemoryStats.queryOptions({}),
        enabled: memoryEnabled,
    });

    // Moved by every change made here, so the open retired list is read again too (a delete takes retired rows with it).
    const [readCount, setReadCount] = useState(0);

    const refresh = useCallback(() => {
        void refetchMemories();
        void refetchStats();
        setReadCount((count) => count + 1);
    }, [refetchMemories, refetchStats]);

    const { isPending: isDeleting, mutate: deleteMemory } = useMutation({
        ...crpc.memory.functions.deleteMemory.mutationOptions(),
        onError: () => {
            toast.error(t`Failed to delete memory`);
        },
        onSuccess: () => {
            refresh();
            toast.success(t`Memory deleted`);
        },
    });

    const { isPending: isUpdating, mutate: updateMemory } = useMutation({
        ...crpc.memory.functions.updateMemory.mutationOptions(),
        onError: () => {
            toast.error(t`Failed to update memory`);
        },
        onSuccess: refresh,
    });

    const { isPending: isPinning, mutate: setPinned } = useMutation({
        ...crpc.memory.functions.setMemoryPinned.mutationOptions(),
        onError: () => {
            toast.error(t`Failed to update memory`);
        },
        onSuccess: refresh,
    });

    // Clear all memories mutation
    const { isPending: isClearingAll, mutate: clearAll } = useMutation({
        ...crpc.memory.functions.clearAllUserMemories.mutationOptions(),
        onError: () => {
            toast.error(t`Failed to clear memories`);
        },
        onSuccess: (count: number) => {
            refresh();
            toast.success(t`Cleared ${count} memories`);
        },
    });

    const setMemoryEnabled = useCallback(
        async (enabled: boolean) => {
            try {
                await updateSettingsMutation.mutateAsync({ memoryEnabled: enabled });
                trackEvent("memory_toggled", { enabled });
                toast.success(enabled ? t`Memory enabled` : t`Memory disabled`);
            } catch {
                toast.error(t`Failed to update setting`);
            }
        },
        [updateSettingsMutation, t],
    );

    const handleToggleMemory = useCallback(async () => setMemoryEnabled(!memoryEnabled), [memoryEnabled, setMemoryEnabled]);
    const handleEnableMemory = useCallback(async () => setMemoryEnabled(true), [setMemoryEnabled]);

    const visible = (memories ?? []).filter((memory) => typeFilter === "all" || memory.type === typeFilter);
    const busy = isDeleting || isUpdating || isPinning;
    const relativeTime = (timestamp: number) => formatRelativeTime(timestamp, t);

    return (
        <SettingsCard
            description={t`The AI learns from your conversations to personalize its responses, and reflects on what it learned each night. Everything it remembers is listed here — edit, retype, pin or delete any of it.`}
            title={t`Memory`}
        >
            <CardContent className="space-y-4">
                {/* Toggle */}
                <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-sm font-medium" htmlFor="memory-enabled-switch">
                        <BrainIcon aria-hidden="true" className="text-muted-foreground h-4 w-4" />
                        {t`Enable memory`}
                    </label>
                    <Switch checked={memoryEnabled} id="memory-enabled-switch" onCheckedChange={handleToggleMemory} />
                </div>

                <ScheduleIdeasSwitch memoryEnabled={memoryEnabled} />

                {/* Outside the enabled block: with memory off it offers to turn it on first. */}
                <MemoryImportDialog memoryEnabled={memoryEnabled} onEnableMemory={handleEnableMemory} onImported={refresh} />

                <MemoryFileImport memoryEnabled={memoryEnabled} onImported={refresh} />

                <MemoryExportButton />

                {memoryEnabled && (
                    <>
                        <MemoryDigestCard />

                        {/* Stats */}
                        {stats && stats.total > 0 && (
                            <div className="text-muted-foreground text-xs">
                                {t`${stats.total} memories`}
                                {stats.pinned > 0 && <> · {t`${stats.pinned} pinned`}</>}
                            </div>
                        )}

                        {/* Browse by type */}
                        {memories && memories.length > 0 && (
                            <div className="space-y-1">
                                <span className="sr-only" id={filterLabelId}>{t`Filter memories by type`}</span>
                                <ToggleGroup
                                    aria-labelledby={filterLabelId}
                                    className="flex-wrap"
                                    onValueChange={(value) => {
                                        const next = value?.[0];

                                        setTypeFilter(isMemoryType(next) ? next : "all");
                                    }}
                                    size="sm"
                                    spacing={1}
                                    value={[typeFilter]}
                                    variant="outline"
                                >
                                    <ToggleGroupItem value="all">{t`All (${memories.length})`}</ToggleGroupItem>
                                    {MEMORY_TYPES.map((type) => (
                                        <ToggleGroupItem key={type} value={type}>
                                            {`${typeLabels[type]} (${String(stats?.byType[type] ?? 0)})`}
                                        </ToggleGroupItem>
                                    ))}
                                </ToggleGroup>
                            </div>
                        )}

                        {/* Memory list */}
                        {visible.length > 0 ? (
                            <ul aria-label={t`Memories`} className="max-h-96 space-y-2 overflow-y-auto">
                                {visible.map((memory) => (
                                    <MemoryItem
                                        busy={busy}
                                        key={memory._id}
                                        memory={memory}
                                        onDelete={(memoryId) => deleteMemory({ memoryId })}
                                        onSave={(memoryId, changes) => updateMemory({ memoryId, ...changes })}
                                        onTogglePin={(memoryId, pinned) => setPinned({ memoryId, pinned })}
                                        relativeTime={relativeTime}
                                    />
                                ))}
                            </ul>
                        ) : (
                            <div className="text-muted-foreground py-4 text-center text-sm">
                                {memories && memories.length > 0
                                    ? t`No memories of this type.`
                                    : t`No memories yet. The AI will start learning from your conversations automatically.`}
                            </div>
                        )}

                        <RetiredMemories onBroughtBack={refresh} readCount={readCount} />

                        {/* Clear all */}
                        {memories && memories.length > 0 && (
                            <AlertDialog>
                                {/* Base UI composes via `render`, not Radix's `asChild`. */}
                                <AlertDialogTrigger render={<Button className="w-full" disabled={isClearingAll} variant="destructive" />}>
                                    <Trash2Icon aria-hidden="true" className="mr-2 h-4 w-4" />
                                    {t`Clear All Memories`}
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>{t`Clear all memories?`}</AlertDialogTitle>
                                        <AlertDialogDescription>
                                            {t`This will permanently delete all ${memories.length} memories and their daily digests. The AI will start learning fresh from your next conversation.`}
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => clearAll({})}>{t`Delete All`}</AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        )}
                    </>
                )}
            </CardContent>
        </SettingsCard>
    );
};

export default MemorySettings;
