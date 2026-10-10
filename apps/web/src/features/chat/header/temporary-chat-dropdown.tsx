"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/responsive-popover";
import { SnappySlider } from "@neore/ui/components/snappy-slider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { HourglassIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { useCRPC } from "@/lib/lunora/crpc";

// Preset retention values in hours
const RETENTION_VALUES = [1, 3, 6, 12, 24, 48, 72];

/** Reads the clock, so it lives outside the component that renders with it. */
const millisecondsUntil = (timestamp: number): number => timestamp - Date.now();

interface TemporaryChatDropdownProps {
    className?: string;
    threadId?: string;
}

const TemporaryChatDropdown: FC<TemporaryChatDropdownProps> = ({ className, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: userSettings } = useUserSettings();
    const defaultRetentionHours = userSettings?.temporaryChatRetentionHours ?? 24;

    // Query temporary status for existing threads
    const { data: temporaryStatus } = useQuery(
        crpc.chat.functions.getThreadTemporaryStatus.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken),
    );

    const { mutateAsync: makeThreadTemporary } = useMutation(crpc.chat.functions.makeThreadTemporary.mutationOptions());
    const { mutateAsync: convertToPermanent } = useMutation(crpc.chat.functions.convertTemporaryToPermanent.mutationOptions());
    const setPendingSettings = useModelStore((state) => state.setPendingSettings);

    const [retentionHours, setRetentionHours] = useState(defaultRetentionHours);
    const [open, setOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const isExistingThread = !!threadId;
    const isTemporary = temporaryStatus?.isTemporary === true;

    const settingsRetentionHours = userSettings?.temporaryChatRetentionHours;
    const statusRetentionHours = temporaryStatus?.retentionHours;

    // Update local state when user settings load or when temporary status changes.
    // Adjusted during render rather than in an effect, so the dropdown never paints
    // once with the previous retention value.
    const [previousInputs, setPreviousInputs] = useState<{ isTemporary: boolean; settingsRetentionHours?: number; statusRetentionHours?: number }>();

    if (
        isTemporary !== previousInputs?.isTemporary ||
        settingsRetentionHours !== previousInputs.settingsRetentionHours ||
        statusRetentionHours !== previousInputs.statusRetentionHours
    ) {
        setPreviousInputs({ isTemporary, settingsRetentionHours, statusRetentionHours });

        if (isTemporary && statusRetentionHours) {
            setRetentionHours(statusRetentionHours);
        } else if (settingsRetentionHours) {
            setRetentionHours(settingsRetentionHours);
        }
    }

    const formatHours = useCallback(
        (hours: number): string => {
            if (hours === 1) {
                return t`1 hour`;
            }

            return t`${hours} hours`;
        },
        [t],
    );

    const handleEnableTemporaryChat = async () => {
        setIsLoading(true);

        try {
            if (isExistingThread) {
                // Convert existing thread to temporary or update expiration
                const result = await makeThreadTemporary({
                    retentionHours,
                    threadId: threadId as Id<"threads">,
                });

                if (result.updated) {
                    toast.success(t`Expiration updated to ${formatHours(result.retentionHours)}`);
                } else {
                    toast.success(t`Thread will auto-delete in ${formatHours(result.retentionHours)}`);
                }
            } else {
                // Set pending settings for new thread
                setPendingSettings((previous) => {
                    return {
                        ...previous,
                        isTempChat: true,
                        retentionHours,
                    };
                });
                toast.success(t`Temporary mode enabled (${formatHours(retentionHours)})`);
            }

            setOpen(false);
        } catch (error) {
            console.error("Failed to enable temporary chat:", error);
            toast.error(t`Failed to enable temporary mode`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleRemoveTemporary = async () => {
        if (!threadId) {
            return;
        }

        setIsLoading(true);

        try {
            await convertToPermanent({ threadId: threadId as Id<"threads"> });
            toast.success(t`Thread is now permanent`);
            setOpen(false);
        } catch (error) {
            console.error("Failed to remove temporary status:", error);
            toast.error(t`Failed to make thread permanent`);
        } finally {
            setIsLoading(false);
        }
    };

    // Listen for keyboard shortcut event
    useEffect(() => {
        const handleKeyboardShortcut = async () => {
            if (isExistingThread) {
                if (isTemporary) {
                    // If already temporary, remove it
                    try {
                        await convertToPermanent({ threadId: threadId as Id<"threads"> });
                        toast.success(t`Thread is now permanent`);
                    } catch (error) {
                        console.error("Failed to remove temporary status:", error);
                        toast.error(t`Failed to make thread permanent`);
                    }
                } else {
                    // Make temporary
                    try {
                        const result = await makeThreadTemporary({
                            retentionHours: defaultRetentionHours,
                            threadId: threadId as Id<"threads">,
                        });

                        toast.success(t`Thread will auto-delete in ${formatHours(result.retentionHours)}`);
                    } catch (error) {
                        console.error("Failed to enable temporary chat:", error);
                        toast.error(t`Failed to enable temporary mode`);
                    }
                }
            } else {
                setPendingSettings((previous) => {
                    return {
                        ...previous,
                        isTempChat: true,
                        retentionHours: defaultRetentionHours,
                    };
                });
                toast.success(t`Temporary mode enabled`);
            }
        };

        globalThis.addEventListener("newTemporaryChat", handleKeyboardShortcut);

        return () => {
            globalThis.removeEventListener("newTemporaryChat", handleKeyboardShortcut);
        };
    }, [defaultRetentionHours, isExistingThread, isTemporary, threadId, makeThreadTemporary, convertToPermanent, setPendingSettings, t, formatHours]);

    const formatExpiresAt = (expiresAt: number): string => {
        const remaining = millisecondsUntil(expiresAt);

        if (remaining <= 0) {
            return t`Expiring soon`;
        }

        const hours = Math.floor(remaining / (1000 * 60 * 60));
        const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
            return t`${hours}h ${minutes}m remaining`;
        }

        return t`${minutes}m remaining`;
    };

    // Determine button text based on state
    const getButtonText = () => {
        if (isLoading) {
            return t`Processing...`;
        }

        if (isTemporary) {
            return t`Update Duration`;
        }

        if (isExistingThread) {
            return t`Enable Auto-Delete`;
        }

        return t`Enable for Next Chat`;
    };

    const getTooltipText = () => {
        if (isTemporary) {
            return formatExpiresAt(temporaryStatus.expiresAt);
        }

        if (isExistingThread) {
            return t`Enable auto-delete`;
        }

        return t`Temporary chat mode`;
    };

    const getDescriptionText = () => {
        if (isTemporary) {
            return formatExpiresAt(temporaryStatus.expiresAt);
        }

        if (isExistingThread) {
            return t`Enable auto-delete for this conversation.`;
        }

        return t`Your next message will start a self-destructing chat.`;
    };

    return (
        <Popover onOpenChange={setOpen} open={open}>
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <PopoverTrigger
                                render={
                                    <Button className={cn(className, isTemporary && "text-orange-500 hover:text-orange-600")} size="icon" variant="ghost">
                                        <HourglassIcon className="size-4" />
                                    </Button>
                                }
                            />
                        }
                    />
                    <TooltipContent>{getTooltipText()}</TooltipContent>
                </Tooltip>
            </TooltipProvider>
            <PopoverContent align="end" className="w-72">
                <div className="flex flex-col gap-4">
                    <div className="space-y-1">
                        <h4 className="leading-none font-medium">{isTemporary ? t`Auto-Delete Active` : t`Temporary Chat`}</h4>
                        <p className="text-muted-foreground text-sm">{getDescriptionText()}</p>
                    </div>

                    <SnappySlider
                        config={{ snappingThreshold: 3 }}
                        defaultValue={defaultRetentionHours}
                        label={t`Duration`}
                        max={168}
                        min={1}
                        onChange={setRetentionHours}
                        snapping
                        step={1}
                        suffix=" h"
                        value={retentionHours}
                        values={RETENTION_VALUES}
                    />

                    <div className="flex flex-col gap-2">
                        <Button className="w-full" disabled={isLoading} onClick={handleEnableTemporaryChat}>
                            {getButtonText()}
                        </Button>

                        {isTemporary && (
                            <Button className="w-full" disabled={isLoading} onClick={handleRemoveTemporary} variant="outline">
                                {t`Keep Permanently`}
                            </Button>
                        )}
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
};

export default TemporaryChatDropdown;
